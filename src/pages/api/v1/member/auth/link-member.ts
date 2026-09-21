// Identification: NIC + AB Number name one active member, and a code goes
// to the mobile on their record (docs/member-app.md). Opens nothing by
// itself. Not the staff existing-member-search: exact pair, no fragments,
// no names in the answer.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { linkMember } from '@lib/member/identity';
import { challengeSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/auth/link-member',
    summary:
      'Identify an existing member by NIC + AB Number and send a code to their registered mobile',
    description:
      'Exact pair, active members only. The answer is the same whether the ' +
      'pair named someone or not — a challenge id and no number — so it ' +
      'never says whether a NIC + AB Number combination exists; a miss ' +
      'gets a challenge nothing can verify against. Rate-limited per NIC, ' +
      'per AB Number and per address, and one code per AB Number per ' +
      'cooldown window.',
    tag: 'Member app',
    caller: 'public',
    requestSchema: {
      type: 'object',
      required: ['nic', 'abNumber'],
      properties: {
        nic: { type: 'string', description: 'As on the identity card.' },
        abNumber: {
          type: 'string',
          description: 'The Member No. on the card, e.g. AB0001.',
        },
      },
    },
    responseSchema: challengeSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{ nic?: string; abNumber?: string }>();
    const challenge = await linkMember(
      { nic: String(input.nic ?? ''), abNumber: String(input.abNumber ?? '') },
      { ip: clientIp, correlationId }
    );
    return apiSuccess(challenge, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
