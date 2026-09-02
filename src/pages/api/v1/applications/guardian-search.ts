// Finding a parent to link as a minor's guardian (S-604, FRD 7.10.2).
//
// Searches both existing members and Individual applications still being
// captured — a parent and their minor can be registered at the same visit,
// the parent first, and this is what lets the officer find and point at the
// parent's own application before it is anywhere near approved. Submission
// still refuses until the guardian actually is an active member; this only
// helps the officer name who they mean.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess } from '@lib/api/endpoint';
import { searchGuardianCandidates } from '@lib/applications/capture';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/applications/guardian-search',
    summary: "Search for a minor's guardian by name, NIC or Member No.",
    description:
      'Matches existing active members and Individual applications not yet ' +
      'decided, so a parent joining alongside their child can be found ' +
      'before their own application is approved.',
    tag: 'Applications',
    permission: 'application.capture',
    query: [
      {
        name: 'q',
        description:
          'Matched against surname, name, NIC and Member No./reference.',
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
            required: ['kind', 'reference', 'status', 'surname', 'name', 'nic'],
            properties: {
              kind: { type: 'string', enum: ['member', 'application'] },
              reference: {
                type: 'string',
                description:
                  'Member No. once one exists, the application reference until then.',
              },
              status: { type: 'string' },
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
    const candidates = await searchGuardianCandidates(q);
    return apiSuccess({ candidates }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
