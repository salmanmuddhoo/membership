// Verification. For a link_member challenge this is the moment the phone is
// linked to the member — member_session.member_id, server-side; for sign_up,
// an applicant session. What comes back is the authentication from here on.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { verifyOtp } from '@lib/member/identity';
import { sessionSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/verify-otp',
    summary: 'Verify the code and create the session',
    description:
      'Five wrong codes burn the challenge. The internal member id is ' +
      'linked to the session server-side and never returned.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      required: ['challengeId', 'code'],
      properties: {
        challengeId: { type: 'string', format: 'uuid' },
        code: { type: 'string', pattern: '^[0-9]{6}$' },
        deviceLabel: {
          type: 'string',
          description: 'What the phone calls itself. Display only.',
        },
      },
    },
    responseSchema: sessionSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{
      challengeId?: string;
      code?: string;
      deviceLabel?: string;
    }>();
    const session = await verifyOtp(
      {
        challengeId: String(input.challengeId ?? ''),
        code: String(input.code ?? ''),
      },
      {
        ip: clientIp,
        correlationId,
        deviceLabel: input.deviceLabel
          ? String(input.deviceLabel).slice(0, 80)
          : null,
      }
    );
    return apiSuccess(session, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
