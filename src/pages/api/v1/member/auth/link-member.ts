// Identification: NIC + AB Number name one active member, and a code goes
// to the mobile or the email on their record, as the person chooses
// (docs/member-app.md). Opens nothing by
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
      'Identify an existing member by NIC + AB Number and send a code to their mobile or email on record',
    description:
      'Exact pair, members entitled to the app only. The code goes to the ' +
      'mobile (by WhatsApp or SMS, as the site sends them) or the email ' +
      'on the record, never to one the person types. A pair that names ' +
      'nobody, or a member with nothing on record for the channel chosen, ' +
      'is refused with 404 and a message telling the person to choose the ' +
      'other channel or contact the Al Barakah office. Rate-limited per ' +
      'NIC, per AB Number and ' +
      'per address, hit or miss, and one code per AB Number per cooldown ' +
      'window.',
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
        channel: {
          type: 'string',
          enum: ['phone', 'email'],
          description:
            'Where the code goes: the mobile on record (WhatsApp) or the email on record. Default phone.',
        },
      },
    },
    responseSchema: challengeSchema,
  },
  async ({ body, correlationId, clientIp }) => {
    const input = await body<{
      nic?: string;
      abNumber?: string;
      channel?: string;
    }>();
    const challenge = await linkMember(
      {
        nic: String(input.nic ?? ''),
        abNumber: String(input.abNumber ?? ''),
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
