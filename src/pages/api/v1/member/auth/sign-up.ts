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
    summary:
      'Verify a WhatsApp number or an email address to start a membership application',
    description:
      'No AB Number needed. The person chooses the channel and types the ' +
      'number or address the code goes to. Always succeeds for a ' +
      'well-formed one, known or not; the session it leads to never ' +
      'resolves to a member record.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['phone', 'email'],
          description: 'Where the code goes. Default phone.',
        },
        mobile: {
          type: 'string',
          description:
            'For phone: any form the capture form accepts; stored as E.164.',
        },
        email: {
          type: 'string',
          description: 'For email: the address the code goes to.',
        },
      },
    },
    responseSchema: challengeSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{
      mobile?: string;
      email?: string;
      channel?: string;
    }>();
    const challenge = await startSignUp(
      {
        mobile: String(input.mobile ?? ''),
        email: String(input.email ?? ''),
        channel:
          input.channel === undefined ? undefined : String(input.channel),
      },
      { ip: clientIp, correlationId }
    );
    return apiSuccess(challenge, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
