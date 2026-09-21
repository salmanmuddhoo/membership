import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { commitMemberUpload } from '@lib/member/applications';
import { applicationSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/applications/{id}/documents/commit-upload',
    summary: 'Confirm a filed document arrived',
    description:
      'SharePoint is asked whether the file is there and complete; only ' +
      'then is it on the checklist. Only an upload begun on this application ' +
      'can be committed against it.',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['uploadId'],
      properties: { uploadId: { type: 'string', format: 'uuid' } },
    },
    responseSchema: applicationSchema,
  },
  async ({ member, context, body, correlationId }) => {
    const input = await body<{ uploadId?: string }>();
    const application = await commitMemberUpload(
      member,
      String(context.params.id ?? ''),
      String(input.uploadId ?? '')
    );
    return apiSuccess(application, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
