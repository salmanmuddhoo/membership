// Phase two of filing a document: confirm it really arrived (S-408).
//
// The client says the transfer finished. That is not evidence — a dropped
// connection looks the same from the browser as a completed one. SharePoint is
// asked whether the file is there and whether it is the right size, and only
// then does the document stop reading Missing.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { commitUpload, DocumentError } from '@lib/documents/documents';
import { GraphError, graphFailureMessage } from '@lib/documents/graph';

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/documents/commit-upload',
    summary: 'Confirm a filed document arrived',
    description:
      'Asks SharePoint whether the file is present and complete. Only then ' +
      'is the document filed. A file that is absent or truncated leaves the ' +
      'checklist item as it was, which for a replacement means the document ' +
      'it was replacing is untouched.',
    tag: 'Documents',
    permission: 'document.upload',
    requestSchema: {
      type: 'object',
      required: ['versionId'],
      properties: {
        versionId: { type: 'string', format: 'uuid' },
        checksumSha256: {
          type: 'string',
          description:
            'Optional. Recorded so the archived file can later be proved ' +
            'unchanged (S-402).',
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['state'],
      properties: { state: { type: 'string', enum: ['committed'] } },
    },
  },
  async ({ context, principal, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      versionId?: string;
      checksumSha256?: string;
    } | null;

    if (!payload?.versionId) {
      throw new ApiError('validation_failed', undefined, {
        versionId: ['is required'],
      });
    }

    try {
      const result = await commitUpload(
        payload.versionId,
        { userId: principal.userId, email: principal.email },
        { checksumSha256: payload.checksumSha256 }
      );
      return apiSuccess(result, correlationId);
    } catch (error) {
      // SharePoint being unconfigured or refusing us is not a defect in this
      // request, and reporting it as one leaves the officer staring at a 500
      // with no idea whether to retry, fix their file, or find an
      // administrator. The underlying detail stays in the log.
      if (error instanceof GraphError) {
        console.error(
          JSON.stringify({
            kind: 'graph-error',
            correlationId,
            reason: error.reason,
            status: error.status ?? null,
          }),
          error.message
        );
        throw new ApiError('service_unavailable', graphFailureMessage(error));
      }
      if (error instanceof DocumentError) {
        // `refused` here is the file being absent or truncated, which the
        // officer can act on by uploading again — so it is a 422 they can read,
        // not a 403 that reads as a permissions problem.
        throw new ApiError(
          error.reason === 'not_found' ? 'not_found' : 'validation_failed',
          error.message
        );
      }
      throw error;
    }
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
