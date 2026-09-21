import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { memberDocuments } from '@lib/member/profile';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/documents',
    summary: 'Documents on file for the caller',
    description:
      'Name, state, filed date and expiry. No download: viewing stays a ' +
      'branch matter until a member-facing viewer is decided.',
    tag: 'Member app',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'documentCode',
          'documentName',
          'status',
          'filedAt',
          'expiresAt',
        ],
        properties: {
          id: { type: 'string' },
          documentCode: { type: 'string' },
          documentName: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'filed', 'verified', 'rejected'],
          },
          filedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await memberDocuments(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
