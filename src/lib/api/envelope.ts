// The single response envelope every /api/v1 endpoint uses (S-109, AD-03).
//
// A stable shape matters more than a convenient one: the website and the future
// mobile application both parse this, and changing it later means changing
// every client at once. So errors carry a machine-readable `code` that clients
// may branch on, a `message` safe to show a person, and a `correlationId` that
// ties the response to the server log.
//
// The message is written for the caller, never for the developer. An
// unexpected failure says so plainly; the stack trace, the SQL, and the host
// name stay in the log where the correlation id can find them.

export type ErrorCode =
  // The caller is not signed in, or the session is no longer valid.
  | 'unauthenticated'
  // Signed in, but not permitted. Also covers "no account in this system":
  // telling an unknown caller which one it is reveals whether an account
  // exists, so both refuse identically here and differ only in the audit log.
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'rate_limited'
  // Something went wrong that the caller can do nothing about.
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

// Wording is fixed here rather than at each call site so the same condition
// never produces two different messages across endpoints.
const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  unauthenticated: 'You are not signed in.',
  forbidden: 'You do not have access to this resource.',
  not_found: 'The requested resource does not exist.',
  validation_failed: 'The request could not be processed as submitted.',
  conflict: 'The request conflicts with the current state of the resource.',
  rate_limited: 'Too many requests. Please try again shortly.',
  internal_error: 'Something went wrong. Please try again.',
};

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    correlationId: string;
    // Field-level detail, for validation failures only. Never carries anything
    // derived from an exception.
    details?: Record<string, string[]>;
  };
}

export interface ApiSuccessBody<T> {
  data: T;
  correlationId: string;
}

// Thrown by handlers to produce a specific error response. Anything else that
// escapes a handler becomes internal_error, so a forgotten `throw` cannot leak.
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    // Overrides the standard wording. Must still be safe to show a caller.
    message?: string,
    readonly details?: Record<string, string[]>
  ) {
    super(message ?? MESSAGE_BY_CODE[code]);
    this.name = 'ApiError';
  }
}

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

function jsonResponse(
  body: unknown,
  status: number,
  correlationId: string,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Echoed so a caller reporting a problem can quote it.
      'x-correlation-id': correlationId,
      // API responses are per-user and must never be cached by a shared proxy.
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function apiSuccess<T>(
  data: T,
  correlationId: string,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  const body: ApiSuccessBody<T> = { data, correlationId };
  return jsonResponse(body, status, correlationId, extraHeaders);
}

export function apiError(
  code: ErrorCode,
  correlationId: string,
  message?: string,
  details?: Record<string, string[]>,
  extraHeaders?: Record<string, string>
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message: message ?? MESSAGE_BY_CODE[code],
      correlationId,
      ...(details ? { details } : {}),
    },
  };
  return jsonResponse(body, statusFor(code), correlationId, extraHeaders);
}

// A correlation id for this request. Prefers the platform's own request id so
// the application log and the platform log can be joined; falls back to a
// random one when there is none.
export function correlationIdFrom(headers: Headers): string {
  const existing =
    headers.get('x-correlation-id') ??
    headers.get('x-vercel-id') ??
    headers.get('x-request-id');

  // A caller-supplied value is echoed back and written to our logs, so it is
  // length-capped and restricted to characters that cannot forge a log line.
  if (existing && /^[A-Za-z0-9._:-]{1,128}$/.test(existing)) return existing;

  return crypto.randomUUID();
}
