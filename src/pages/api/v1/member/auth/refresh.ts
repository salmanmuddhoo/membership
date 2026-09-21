import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { refreshSession } from '@lib/member/identity';
import { sessionSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/refresh',
    summary: 'Rotate a refresh token',
    description:
      'A new access and refresh token; the one presented is dead the moment ' +
      'it is used. Refused once the session is revoked, expired, or belongs ' +
      'to a member who is no longer active.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
    responseSchema: sessionSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{ refreshToken?: string }>();
    const session = await refreshSession(String(input.refreshToken ?? ''), {
      ip: clientIp,
      correlationId,
    });
    return apiSuccess(session, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
