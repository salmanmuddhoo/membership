// The one way a /api/v1/member endpoint is defined (docs/member-app.md).
//
// The counterpart of defineEndpoint (lib/api/endpoint.ts) for the member
// app: same descriptor, same envelope, same rate limiter and log line, but
// the caller is resolved from a bearer token to a MemberPrincipal rather
// than from the staff cookie to a Principal — or, for the handful of public
// endpoints that create a session, not resolved at all. There is no
// permission check because a member has no permissions: every handler is
// scoped to "this caller's own record" by construction, and an endpoint that
// needs a permission is a staff endpoint and belongs in defineEndpoint.
import type { APIContext } from 'astro';
import {
  apiError,
  ApiError,
  apiSuccess,
  correlationIdFrom,
  type ErrorCode,
} from '../api/envelope';
import type { EndpointDescriptor, Endpoint } from '../api/endpoint';
import { checkRateLimit } from '../api/rate-limit';
import { ApplicationError } from '../applications/capture';
import { MemberConfigError } from '../config';
import { DatabaseUnavailableError } from '../db/pool';
import { DocumentError } from '../documents/documents';
import { GraphError, graphFailureMessage } from '../documents/graph';
import { UploadRejected } from '../documents/upload';
import { CodeDeliveryError } from './otp';
import { resolveMemberSession, type MemberPrincipal } from './identity';

export interface MemberEndpointDescriptor extends Omit<
  EndpointDescriptor,
  'permission' | 'caller'
> {
  caller: 'member' | 'public';
}

export interface MemberRequestContext<
  Caller extends 'member' | 'public' = 'member',
> {
  // Present for caller 'member'; null for a public endpoint.
  member: Caller extends 'member' ? MemberPrincipal : null;
  correlationId: string;
  clientIp: string | null;
  context: APIContext;
  // Read and parse the JSON body, or fail as validation_failed.
  body<T>(): Promise<T>;
}

export type MemberEndpointHandler<Caller extends 'member' | 'public'> = (
  ctx: MemberRequestContext<Caller>
) => Promise<Response>;

function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length <= 45 ? first : null;
}

// A public endpoint is limited per address, tightly: nothing legitimate
// calls one often. A member endpoint is limited per session at the staff
// API's own generous default.
const PUBLIC_LIMIT = { max: 30, windowSeconds: 60 };

// Errors the business modules throw, mapped to the envelope. Anything not
// listed is a defect and becomes internal_error with the detail in the log.
function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof ApplicationError) {
    const code: ErrorCode =
      error.reason === 'not_found'
        ? 'not_found'
        : error.reason === 'locked'
          ? 'conflict'
          : error.reason === 'forbidden'
            ? 'forbidden'
            : 'validation_failed';
    return new ApiError(code, error.message);
  }
  if (error instanceof DocumentError) {
    const code: ErrorCode =
      error.reason === 'not_found'
        ? 'not_found'
        : error.reason === 'conflict'
          ? 'conflict'
          : 'validation_failed';
    return new ApiError(code, error.message);
  }
  if (error instanceof UploadRejected) {
    return new ApiError('validation_failed', error.message, {
      file: [error.reason],
    });
  }
  if (error instanceof GraphError) {
    return new ApiError('service_unavailable', graphFailureMessage(error));
  }
  if (error instanceof CodeDeliveryError) {
    return new ApiError('service_unavailable', error.message);
  }
  if (error instanceof MemberConfigError) {
    // The detail names an environment variable; that is for the operator's
    // log, not the phone.
    return new ApiError(
      'service_unavailable',
      'The member app is not fully configured on this environment. Please ' +
        'tell an administrator.'
    );
  }
  if (error instanceof DatabaseUnavailableError) {
    return new ApiError('service_unavailable');
  }
  return null;
}

function logRequest(fields: {
  correlationId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  actor: string;
  code?: ErrorCode;
}): void {
  console.info(JSON.stringify({ kind: 'api', ...fields }));
}

export function defineMemberEndpoint<Caller extends 'member' | 'public'>(
  descriptor: MemberEndpointDescriptor & { caller: Caller },
  handler: MemberEndpointHandler<Caller>
): Endpoint {
  const full: EndpointDescriptor = { ...descriptor, permission: null };

  return {
    descriptor: full,
    handler: async (context: APIContext): Promise<Response> => {
      const started = Date.now();
      const correlationId = correlationIdFrom(context.request.headers);
      const path = new URL(context.request.url).pathname;
      const clientIp = clientAddress(context.request.headers);

      const finish = (response: Response, actor: string, code?: ErrorCode) => {
        logRequest({
          correlationId,
          method: descriptor.method,
          path,
          status: response.status,
          durationMs: Date.now() - started,
          actor,
          ...(code ? { code } : {}),
        });
        return response;
      };

      let member: MemberPrincipal | null = null;
      let actor = 'anonymous';
      let limitSubject: string;
      let limit: { max?: number; windowSeconds?: number } = {};

      if (descriptor.caller === 'member') {
        try {
          member = await resolveMemberSession(
            context.request.headers.get('authorization')
          );
        } catch (error) {
          const mapped = toApiError(error);
          if (mapped) {
            return finish(
              apiError(mapped.code, correlationId, mapped.message),
              actor,
              mapped.code
            );
          }
          console.error(
            JSON.stringify({ kind: 'api-error', correlationId, path }),
            error
          );
          return finish(apiError('internal_error', correlationId), actor);
        }
        if (!member) {
          return finish(
            apiError('unauthenticated', correlationId, 'Sign in to continue.'),
            actor,
            'unauthenticated'
          );
        }
        actor = `member-session:${member.sessionId}`;
        limitSubject = `member-session:${member.sessionId}`;
      } else {
        limitSubject = `member-public:${clientIp ?? 'unknown'}`;
        limit = PUBLIC_LIMIT;
      }

      const rate = await checkRateLimit(limitSubject, correlationId, limit);
      if (!rate.allowed) {
        return finish(
          apiError('rate_limited', correlationId, undefined, undefined, {
            'retry-after': String(rate.retryAfterSeconds),
          }),
          actor,
          'rate_limited'
        );
      }

      const body = async <T>(): Promise<T> => {
        const parsed = (await context.request
          .json()
          .catch(() => null)) as T | null;
        if (parsed === null || typeof parsed !== 'object') {
          throw new ApiError('validation_failed', 'A JSON body is required.');
        }
        return parsed;
      };

      try {
        const response = await handler({
          member: member as MemberRequestContext<Caller>['member'],
          correlationId,
          clientIp,
          context,
          body,
        });
        return finish(response, actor);
      } catch (error) {
        const mapped = toApiError(error);
        if (mapped) {
          if (
            mapped.code === 'service_unavailable' ||
            mapped.code === 'internal_error'
          ) {
            console.error(
              JSON.stringify({
                kind: 'api-error',
                correlationId,
                path,
                code: mapped.code,
              }),
              error
            );
          }
          return finish(
            apiError(
              mapped.code,
              correlationId,
              mapped.message,
              mapped.details
            ),
            actor,
            mapped.code
          );
        }
        console.error(
          JSON.stringify({
            kind: 'api-error',
            correlationId,
            path,
            method: descriptor.method,
          }),
          error
        );
        return finish(
          apiError('internal_error', correlationId),
          actor,
          'internal_error'
        );
      }
    },
  };
}

export { apiSuccess, ApiError };
