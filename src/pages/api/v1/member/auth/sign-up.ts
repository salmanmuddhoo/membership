// A new applicant has no AB Number. Their mobile is verified so an
// application can be saved as they go; the NIC goes on the application.
// Always the same answer for a well-formed number: the session this leads
// to is an applicant's, whoever the number belongs to.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { startSignUp } from '@lib/member/identity';
import { challengeSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/sign-up',
    summary: 'Verify a mobile number to start a membership application',
    description:
      'No AB Number needed. Always succeeds for a well-formed number, known ' +
      'or not; the session it leads to never resolves to a member record.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      required: ['mobile'],
      properties: {
        mobile: {
          type: 'string',
          description: 'Any form the capture form accepts; stored as E.164.',
        },
      },
    },
    responseSchema: challengeSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{ mobile?: string }>();
    const challenge = await startSignUp(
      { mobile: String(input.mobile ?? '') },
      { ip: clientIp, correlationId }
    );
    return apiSuccess(challenge, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
