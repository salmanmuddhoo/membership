import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { revokeSession } from '@lib/member/identity';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/logout',
    summary: 'Revoke the session; the device must link again',
    tag: 'Member app',
    caller: 'member',
    responseSchema: {
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean', enum: [true] } },
    },
  },
  async ({ member, correlationId, clientIp }) => {
    await revokeSession(member, { ip: clientIp, correlationId });
    return apiSuccess({ ok: true as const }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
