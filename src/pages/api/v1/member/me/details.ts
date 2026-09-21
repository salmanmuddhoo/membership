// A member's own capture of their details. Not an edit: what KYC verified
// changes only after staff have checked the request against a document
// where one is needed. The member sees "pending" meanwhile.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { submitDetails } from '@lib/member/profile';
import type { PartyValues } from '@lib/applications/capture';
import { partySchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'PUT',
    path: '/api/v1/member/me/details',
    summary: 'Capture or correct own details, for staff to verify',
    description:
      'Every mandatory field must be present and every phone placeable; ' +
      'details are keyed subject.ordinal.fieldKey. The mobile the member ' +
      'signs in with cannot be changed here. One request may wait at a time.',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['parties'],
      properties: { parties: { type: 'array', items: partySchema } },
    },
    responseSchema: {
      type: 'object',
      required: ['id', 'status', 'submittedAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['pending', 'applied', 'declined'] },
        submittedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  async ({ member, body, correlationId, clientIp }) => {
    const input = await body<{ parties?: PartyValues[] }>();
    const request = await submitDetails(member, input.parties ?? [], {
      ip: clientIp,
      correlationId,
    });
    return apiSuccess(request, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const PUT: APIRoute = endpoint.handler;
