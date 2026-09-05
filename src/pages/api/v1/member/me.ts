// The caller's own record (docs/member-app.md). Who they are comes from the
// session; there is no id to pass.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { memberProfile } from '@lib/member/profile';
import { partySchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me',
    summary: "The caller's own record",
    description:
      'Membership, the details captured on the founding application, and ' +
      'whether an update the member sent is waiting for staff. An applicant ' +
      'session gets kind applicant and no parties.',
    tag: 'Member app',
    caller: 'member',
    responseSchema: {
      type: 'object',
      required: [
        'kind',
        'memberNo',
        'status',
        'joinedAt',
        'membershipType',
        'parties',
        'pendingUpdate',
      ],
      properties: {
        kind: { type: 'string', enum: ['member', 'customer', 'applicant'] },
        memberNo: { type: 'string', nullable: true },
        status: { type: 'string' },
        joinedAt: { type: 'string', format: 'date-time', nullable: true },
        membershipType: {
          type: 'object',
          nullable: true,
          required: ['code', 'name'],
          properties: { code: { type: 'string' }, name: { type: 'string' } },
        },
        parties: { type: 'array', items: partySchema },
        pendingUpdate: {
          type: 'object',
          nullable: true,
          required: ['id', 'submittedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            submittedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await memberProfile(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
