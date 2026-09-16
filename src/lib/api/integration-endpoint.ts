// The one way an endpoint a machine calls is defined (S-908, S-909).
//
// The third caller, after staff (defineEndpoint) and the member app
// (defineMemberEndpoint). Same descriptor, same envelope, same log line; the
// difference is who is on the other end and what that means for trust.
//
// Nobody is present. There is no session to revoke, no person to ask, and no
// screen on which a mistake becomes obvious — so the things a person's own
// caution would otherwise cover have to be structural:
//
//   A credential is checked on EVERY request, against the database, never a
//   cache. Revoking one has to stop it on its next call, not when a warm
//   instance happens to expire.
//
//   A refusal is RECORDED (S-909). A credential being tried and failing is
//   the signal that someone is probing, and it is worth exactly as much as
//   the successes — more, when it repeats.
//
//   The limit is per credential, not only per address. One integration
//   looping on a bug must not exhaust another's allowance, and a caller
//   behind a changing address must not get a fresh allowance by moving.
import type { APIContext } from 'astro';
import { recordAuditQuietly } from '../access/audit';
import {
  credentialForToken,
  noteCredentialUsed,
  type ApiCredential,
} from './credentials';
import type { EndpointDescriptor, Endpoint } from './endpoint';
import {
  apiError,
  ApiError,
  apiSuccess,
  correlationIdFrom,
  type ErrorCode,
} from './envelope';
import { ApplicationError } from '../applications/capture';
import { DatabaseUnavailableError } from '../db/pool';
import { checkRateLimit } from './rate-limit';

export interface IntegrationEndpointDescriptor extends Omit<
  EndpointDescriptor,
  'permission' | 'caller'
> {
  caller: 'integration';
  // What the credential must be allowed to do. Written per endpoint rather
  // than inferred, so a new endpoint cannot inherit an existing credential's
  // reach by being added next to one.
  scope: string;
}

export interface IntegrationRequestContext {
  credential: ApiCredential;
  correlationId: string;
  clientIp: string | null;
  context: APIContext;
  body<T>(): Promise<T>;
}

export type IntegrationHandler = (
  ctx: IntegrationRequestContext
) => Promise<Response>;

function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length <= 45 ? first : null;
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// An address that presents no valid credential is limited hard and on its own,
// before any credential is known. Nothing legitimate fails to authenticate
// repeatedly, so this is the ceiling on guessing.
const UNAUTHENTICATED_LIMIT = { max: 20, windowSeconds: 60 };

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
  if (error instanceof DatabaseUnavailableError) {
    return new ApiError(
      'service_unavailable',
      'The service is temporarily unavailable. Try again shortly.'
    );
  }
  return null;
}

export function defineIntegrationEndpoint(
  descriptor: IntegrationEndpointDescriptor,
  handler: IntegrationHandler
): Endpoint {
  return {
    // permission is null because a credential holds no staff permission at
    // all; what it may do is the scope, checked below.
    descriptor: {
      ...descriptor,
      permission: null,
    } satisfies EndpointDescriptor,
    handler: async (context: APIContext): Promise<Response> => {
      const started = Date.now();
      const correlationId = correlationIdFrom(context.request.headers);
      const path = new URL(context.request.url).pathname;
      const clientIp = clientAddress(context.request.headers);

      const finish = (response: Response, actor: string, code?: ErrorCode) => {
        console.info(
          JSON.stringify({
            kind: 'api',
            correlationId,
            method: descriptor.method,
            path,
            status: response.status,
            durationMs: Date.now() - started,
            actor,
            ...(code ? { code } : {}),
          })
        );
        return response;
      };

      // Recorded, not just logged. A log is rotated and searched by whoever
      // remembers to; the audit trail is what an investigation reads.
      const recordRefusal = (reason: string, clientId?: string) =>
        recordAuditQuietly({
          actorUserId: null,
          actorDescription: clientId
            ? `public-api:${clientId}`
            : 'public-api:unknown',
          action: 'api_credential.refused',
          entityType: 'api_credential',
          entityId: clientId ?? 'unknown',
          newValue: { reason, path, method: descriptor.method },
          requestId: correlationId,
          ipAddress: clientIp,
        });

      try {
        const token = bearerToken(context.request.headers);

        // The guessing ceiling applies before a credential is known, so a
        // caller cannot probe faster by presenting nothing.
        const guessLimit = await checkRateLimit(
          `integration-auth:${clientIp ?? 'unknown'}`,
          correlationId,
          UNAUTHENTICATED_LIMIT
        );
        if (!guessLimit.allowed) {
          await recordRefusal('too_many_attempts');
          return finish(
            apiError('rate_limited', correlationId, undefined, undefined, {
              'retry-after': String(guessLimit.retryAfterSeconds),
            }),
            'public-api:unknown',
            'rate_limited'
          );
        }

        const credential = token ? await credentialForToken(token) : null;
        if (!credential) {
          // Deliberately one message for every way of being wrong: no
          // credential, a wrong secret, a revoked one. Distinguishing them
          // would let someone with a list of client ids learn which are real.
          await recordRefusal(token ? 'invalid_credential' : 'no_credential');
          return finish(
            apiError(
              'unauthenticated',
              correlationId,
              'A valid API credential is required.'
            ),
            'public-api:unknown',
            'unauthenticated'
          );
        }

        const actor = `public-api:${credential.clientId}`;

        if (!credential.scopes.includes(descriptor.scope)) {
          await recordRefusal('out_of_scope', credential.clientId);
          return finish(
            apiError(
              'forbidden',
              correlationId,
              'This credential may not do that.'
            ),
            actor,
            'forbidden'
          );
        }

        // Per credential, at its own ceiling. Keyed on the id rather than the
        // client id so the counter survives a credential being renamed.
        const rate = await checkRateLimit(
          `integration:${credential.id}`,
          correlationId,
          { max: credential.rateLimitPerMinute, windowSeconds: 60 }
        );
        if (!rate.allowed) {
          await recordRefusal('rate_limited', credential.clientId);
          return finish(
            apiError('rate_limited', correlationId, undefined, undefined, {
              'retry-after': String(rate.retryAfterSeconds),
            }),
            actor,
            'rate_limited'
          );
        }

        await noteCredentialUsed(credential.id);

        const body = async <T>(): Promise<T> => {
          const parsed = (await context.request
            .json()
            .catch(() => null)) as T | null;
          if (parsed === null || typeof parsed !== 'object') {
            throw new ApiError('validation_failed', 'A JSON body is required.');
          }
          return parsed;
        };

        const response = await handler({
          credential,
          correlationId,
          clientIp,
          context,
          body,
        });
        return finish(response, actor);
      } catch (error) {
        const known = toApiError(error);
        if (known) {
          return finish(
            apiError(known.code, correlationId, known.message, known.details),
            'public-api',
            known.code
          );
        }
        // A defect. The detail stays in the log against the correlation id;
        // a machine caller learns only that it was not their request's fault.
        console.error(`[api] ${descriptor.method} ${path}`, error);
        return finish(
          apiError('internal_error', correlationId),
          'public-api',
          'internal_error'
        );
      }
    },
  };
}

export { apiSuccess };
