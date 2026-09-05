// Rate limiting across serverless instances (S-111).
//
// The counter lives in the database because each serverless instance has its
// own memory: an in-process counter would let a caller multiply their allowance
// by the number of warm instances, which is not a limit at all.
//
// The increment is a single statement, so two concurrent requests cannot both
// read the same count and both decide they are under the limit.
import { readEnv } from '../config';
import { query } from '../db/pool';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function positiveInt(key: string, fallback: number): number {
  const raw = readEnv(key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Generous by default: this exists to slow abuse, not to shape normal use. An
// officer working quickly through a list of members should never meet it.
const DEFAULT_MAX_REQUESTS = 300;
const DEFAULT_WINDOW_SECONDS = 60;

// One statement: bucket the current time into a window, add the request, and
// report the resulting count. ON CONFLICT makes the increment atomic, so
// concurrent requests cannot both see the pre-increment value.
const INCREMENT = `
  insert into rate_limit_window (subject, window_start, request_count)
  values (
    $1,
    to_timestamp(floor(extract(epoch from now()) / $2) * $2),
    1
  )
  on conflict (subject, window_start) do update
     set request_count = rate_limit_window.request_count + 1
  returning request_count,
            extract(epoch from (window_start + make_interval(secs => $2) - now()))::int
              as seconds_remaining
`;

// Old windows are never read again. Sweeping them on a small fraction of
// requests keeps the table from growing without needing a scheduled job, and
// costs nothing on the requests that skip it.
const SWEEP_PROBABILITY = 0.01;

async function sweepExpiredWindows(windowSeconds: number): Promise<void> {
  try {
    await query(
      `delete from rate_limit_window
        where window_start < now() - make_interval(secs => $1)`,
      [windowSeconds * 5]
    );
  } catch (error) {
    // Housekeeping. A failure here must not affect the request.
    console.warn('[rate-limit] sweep failed:', error);
  }
}

// The member surface asks for tighter limits on a few public endpoints (a
// one-time code costs an SMS; a NIC + AB Number lookup is what a stolen
// card would be tried against), so a caller may name its own ceiling and
// window. The default is the staff API's generous one.
export interface RateLimitOptions {
  max?: number;
  windowSeconds?: number;
}

export async function checkRateLimit(
  subject: string,
  correlationId: string,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  if (readEnv('RATE_LIMIT_DISABLED') === 'true') {
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterSeconds: 0,
    };
  }

  const max =
    options.max ?? positiveInt('RATE_LIMIT_MAX_REQUESTS', DEFAULT_MAX_REQUESTS);
  const windowSeconds =
    options.windowSeconds ??
    positiveInt('RATE_LIMIT_WINDOW_SECONDS', DEFAULT_WINDOW_SECONDS);

  try {
    const result = await query<{
      request_count: number;
      seconds_remaining: number;
    }>(INCREMENT, [subject, windowSeconds]);

    const count = result.rows[0].request_count;
    const retryAfterSeconds = Math.max(1, result.rows[0].seconds_remaining);

    if (Math.random() < SWEEP_PROBABILITY) {
      await sweepExpiredWindows(windowSeconds);
    }

    if (count > max) {
      console.warn(
        JSON.stringify({
          kind: 'rate-limit',
          correlationId,
          subject,
          count,
          max,
        })
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return { allowed: true, remaining: max - count, retryAfterSeconds };
  } catch (error) {
    // Fail OPEN, deliberately.
    //
    // The rate limiter slows abuse; it is not the access control. If its table
    // is unavailable the request has already passed authentication and
    // authorisation, both of which needed the same database — so failing closed
    // here would take the API down to protect against something the request has
    // already been authorised to do. The failure is logged loudly instead.
    console.error('[rate-limit] check failed, allowing request:', error);
    return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  }
}
