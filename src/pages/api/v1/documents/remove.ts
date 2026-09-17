// Taking a filed document back off the checklist (S-409, officer feedback).
//
// The same removeFiledDocument the application pages already run from their
// own Remove button, reachable from a page that has no form to post — the
// printed form, which files the signed PDF itself and has to clear the
// previous one first so only the latest signature is on file.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { removeFiledDocument, DocumentError } from '@lib/documents/documents';
import { GraphError, graphFailureMessage } from '@lib/documents/graph';

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/documents/remove',
    summary: 'Remove a filed document',
    description:
      'Supersedes the live version and deletes the file from SharePoint, ' +
      'leaving the checklist item Missing so it can be filed again.',
    tag: 'Documents',
    permission: 'document.upload',
    requestSchema: {
      type: 'object',
      required: ['documentId'],
      properties: {
        documentId: { type: 'string', format: 'uuid' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['state'],
      properties: {
        state: { type: 'string', enum: ['missing'] },
      },
    },
  },
  async ({ context, principal, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      documentId?: string;
    } | null;

    if (!payload?.documentId) {
      throw new ApiError('validation_failed', undefined, {
        documentId: ['is required'],
      });
    }

    try {
      const result = await removeFiledDocument(payload.documentId, principal);
      return apiSuccess(result, correlationId);
    } catch (error) {
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
        throw new ApiError(
          error.reason === 'not_found'
            ? 'not_found'
            : error.reason === 'refused'
              ? 'forbidden'
              : 'validation_failed',
          error.message
        );
      }
      throw error;
    }
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
