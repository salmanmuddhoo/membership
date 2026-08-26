// The one way an /api/v1 endpoint is defined (S-109, S-110, S-111).
//
// Everything an endpoint must do consistently happens here rather than in each
// handler: resolving the caller, enforcing its permission, rate limiting,
// logging, and turning anything that goes wrong into the standard envelope.
// A handler that forgets one of these cannot exist, because there is no way to
// write an endpoint that skips the wrapper.
//
// The descriptor is also the source of the OpenAPI document, so an endpoint
// cannot be added without describing it — see scripts/generate-openapi.ts.
import type { APIContext } from 'astro';
import { recordAuditQuietly } from '../access/audit';
import { hasPermission, type Principal } from '../access/principal';
import {
  apiError,
  apiSuccess,
  ApiError,
  correlationIdFrom,
  type ErrorCode,
} from './envelope';
import { checkRateLimit } from './rate-limit';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointDescriptor {
  method: HttpMethod;
  // The path as OpenAPI states it, e.g. /api/v1/members/{id}.
  path: string;
  summary: string;
  description?: string;
  // Grouping in the generated document.
  tag: string;
  // The permission required. `null` means "any signed-in, active account" and
  // has to be written deliberately — there is no way to omit the field and get
  // an unprotected endpoint by accident.
  permission: string | null;
  // Shape of a successful `data` payload, as an OpenAPI schema object.
  responseSchema: Record<string, unknown>;
  requestSchema?: Record<string, unknown>;
}

export interface RequestContext {
  principal: Principal;
  correlationId: string;
  context: APIContext;
}

export type EndpointHandler = (ctx: RequestContext) => Promise<Response>;

export interface Endpoint {
  descriptor: EndpointDescriptor;
  handler: (context: APIContext) => Promise<Response>;
}

function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length <= 45 ? first : null;
}

// Structured, one line per request (S-111). JSON so a log search can filter by
// correlation id or status without a regular expression, and deliberately
// without the request body — which for this application routinely holds member
// personal and financial data.
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

export function defineEndpoint(
  descriptor: EndpointDescriptor,
  handler: EndpointHandler
): Endpoint {
  return {
    descriptor,
    handler: async (context: APIContext): Promise<Response> => {
      const started = Date.now();
      const correlationId = correlationIdFrom(context.request.headers);
      const path = new URL(context.request.url).pathname;

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

      // The middleware has already resolved the principal for this request. It
      // is null when there is no session, or the session belongs to nobody
      // here — both of which are refusals, not errors.
      const principal = context.locals.principal;
      const user = context.locals.user;

      if (!principal) {
        const code: ErrorCode = user ? 'forbidden' : 'unauthenticated';
        return finish(apiError(code, correlationId), 'anonymous', code);
      }

      if (
        descriptor.permission !== null &&
        !hasPermission(principal, descriptor.permission)
      ) {
        await recordAuditQuietly({
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'access.denied',
          entityType: 'endpoint',
          entityId: `${descriptor.method} ${descriptor.path}`,
          newValue: { required: descriptor.permission },
          requestId: correlationId,
          ipAddress: clientAddress(context.request.headers),
        });
        return finish(
          apiError('forbidden', correlationId),
          principal.email,
          'forbidden'
        );
      }

      const limit = await checkRateLimit(principal.userId, correlationId);
      if (!limit.allowed) {
        return finish(
          apiError('rate_limited', correlationId, undefined, undefined, {
            'retry-after': String(limit.retryAfterSeconds),
          }),
          principal.email,
          'rate_limited'
        );
      }

      try {
        const response = await handler({ principal, correlationId, context });
        return finish(response, principal.email);
      } catch (error) {
        if (error instanceof ApiError) {
          return finish(
            apiError(error.code, correlationId, error.message, error.details),
            principal.email,
            error.code
          );
        }

        // Anything else is a defect. The caller is told only that something
        // went wrong; the real cause is logged against the correlation id so it
        // can be found without the caller ever having seen it.
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
          principal.email,
          'internal_error'
        );
      }
    },
  };
}

export { apiSuccess, ApiError };
