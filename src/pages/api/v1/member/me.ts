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
      'what became of the last update the member sent — waiting, applied, ' +
      'or declined with the reason. An applicant session gets kind ' +
      'applicant and no parties.',
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
          description: 'An update waiting for staff to verify it.',
          required: ['id', 'submittedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            submittedAt: { type: 'string', format: 'date-time' },
          },
        },
        lastUpdate: {
          type: 'object',
          nullable: true,
          description:
            'The most recent details update this member sent, whatever ' +
            'became of it. A declined one carries the reason, which is ' +
            'written for the member to read.',
          required: ['id', 'status', 'submittedAt', 'decidedAt', 'comment'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: {
              type: 'string',
              enum: ['pending', 'applied', 'declined'],
            },
            submittedAt: { type: 'string', format: 'date-time' },
            decidedAt: { type: 'string', format: 'date-time', nullable: true },
            comment: { type: 'string', nullable: true },
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
