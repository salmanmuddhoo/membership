// The same brokered upload the officer's screen uses (docs/documents.md):
// a short-lived URL scoped to one file, the bytes never through here, and
// nothing on the checklist until commit.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { beginMemberUpload } from '@lib/member/applications';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/applications/{id}/documents/begin-upload',
    summary: 'Start filing a document against the application',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['checklistItemId', 'fileName', 'sizeBytes', 'contentType'],
      properties: {
        checklistItemId: {
          type: 'string',
          description: 'From the application’s documents, or /reference.',
        },
        fileName: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1 },
        contentType: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: [
        'uploadId',
        'uploadUrl',
        'expiresAt',
        'maxBytes',
        'acceptedTypes',
      ],
      properties: {
        uploadId: { type: 'string', format: 'uuid' },
        uploadUrl: {
          type: 'string',
          description: 'PUT the bytes here, then commit.',
        },
        expiresAt: { type: 'string', format: 'date-time' },
        maxBytes: { type: 'integer' },
        acceptedTypes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  async ({ member, context, body, correlationId }) => {
    const input = await body<{
      checklistItemId?: string;
      fileName?: string;
      sizeBytes?: number;
      contentType?: string;
    }>();
    const ticket = await beginMemberUpload(
      member,
      String(context.params.id ?? ''),
      {
        checklistItemId: String(input.checklistItemId ?? ''),
        fileName: String(input.fileName ?? ''),
        sizeBytes: Number(input.sizeBytes ?? 0),
        contentType: String(input.contentType ?? ''),
      }
    );
    return apiSuccess(ticket, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
