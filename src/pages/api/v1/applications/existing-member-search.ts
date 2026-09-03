// Finding the member an additional-account application opens an account for
// (S-613, FRD 7.6).
//
// Active members only — an additional account is something an active member
// does, the same restriction startAdditionalAccountApplication enforces
// again server-side when the application is actually created.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess } from '@lib/api/endpoint';
import { searchExistingMembers } from '@lib/applications/capture';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/applications/existing-member-search',
    summary: 'Search for an existing member by name, NIC or Member No.',
    description:
      'Matches active members only, for starting an additional-account ' +
      'application against one of them.',
    tag: 'Applications',
    permission: 'application.capture',
    query: [
      {
        name: 'q',
        description: 'Matched against surname, name, NIC and Member No.',
        schema: { type: 'string' },
      },
    ],
    responseSchema: {
      type: 'object',
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['memberId', 'memberNo', 'surname', 'name', 'nic'],
            properties: {
              memberId: { type: 'string' },
              memberNo: { type: 'string' },
              surname: { type: 'string' },
              name: { type: 'string' },
              nic: { type: 'string' },
            },
          },
        },
      },
    },
  },
  async ({ context, correlationId }) => {
    const q = context.url.searchParams.get('q') ?? '';
    const candidates = await searchExistingMembers(q);
    return apiSuccess({ candidates }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
