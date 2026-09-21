// Save as you go (S-302, on a phone). Accepts whatever was typed; format and
// mandatory-field problems are reported at submit, not here.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { saveMemberApplication } from '@lib/member/applications';
import type { PartyValues } from '@lib/applications/capture';
import { applicationSchema, partySchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'PUT',
    path: '/api/v1/member/applications/{id}/parties',
    summary: 'Save the draft',
    description:
      'Never fails on content. Only parties the application has and fields ' +
      "the type configures are kept; the applicant's mobile is always the " +
      "session's. Refused once submitted.",
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['parties'],
      properties: { parties: { type: 'array', items: partySchema } },
    },
    responseSchema: applicationSchema,
  },
  async ({ member, context, body, correlationId }) => {
    const input = await body<{ parties?: PartyValues[] }>();
    const application = await saveMemberApplication(
      member,
      String(context.params.id ?? ''),
      input.parties ?? []
    );
    return apiSuccess(application, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const PUT: APIRoute = endpoint.handler;
