import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { resendOtp } from '@lib/member/identity';
import { challengeSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/resend-otp',
    summary: 'Send a fresh code for a challenge already issued',
    description: 'Same purpose, same number; the previous code is dead.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      required: ['challengeId'],
      properties: { challengeId: { type: 'string', format: 'uuid' } },
    },
    responseSchema: challengeSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{ challengeId?: string }>();
    const challenge = await resendOtp(String(input.challengeId ?? ''), {
      ip: clientIp,
      correlationId,
    });
    return apiSuccess(challenge, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
