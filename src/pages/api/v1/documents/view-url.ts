// Getting a short-lived URL to open a filed document (S-403).
//
// A separate round trip rather than something baked into the page: the URL
// Graph hands back is pre-authenticated — good for one GET, no further
// sign-in — so it is a secret in the same sense an upload ticket is one, and
// belongs in a response fetched on click rather than in HTML that sits on
// screen for as long as the tab is open.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { getDocumentViewUrl, DocumentError } from '@lib/documents/documents';
import { GraphError, graphFailureMessage } from '@lib/documents/graph';

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/documents/view-url',
    summary: 'Get a short-lived URL to open a filed document',
    description:
      'Returns a pre-authenticated URL good for one download, valid for a ' +
      'short time. The caller opens it directly — no further sign-in to ' +
      'SharePoint is needed or possible, which is what lets someone without ' +
      'a SharePoint account view a document at all.',
    tag: 'Documents',
    permission: 'document.view',
    requestSchema: {
      type: 'object',
      required: ['documentId'],
      properties: {
        documentId: { type: 'string', format: 'uuid' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['url', 'fileName', 'contentType'],
      properties: {
        url: { type: 'string' },
        fileName: { type: 'string' },
        contentType: { type: 'string' },
      },
    },
  },
  async ({ context, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      documentId?: string;
    } | null;

    if (!payload?.documentId) {
      throw new ApiError('validation_failed', undefined, {
        documentId: ['is required'],
      });
    }

    try {
      const result = await getDocumentViewUrl(payload.documentId);
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
