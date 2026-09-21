// Streaming a filed document's bytes through this server, so the browser can
// print it.
//
// The viewer next door (view-url.ts) hands the browser SharePoint's own
// pre-authenticated URL, which renders perfectly well and costs this server
// nothing. It cannot be printed from, though: a cross-origin frame will not
// take window.print(), and SharePoint sends no CORS headers for a script to
// fetch the bytes and re-host them itself. Serving them from this origin is
// what makes a print frame scriptable — for a PDF as much as an image.
import type { APIRoute } from 'astro';
import { defineEndpoint, ApiError } from '@lib/api/endpoint';
import { getDocumentContent, DocumentError } from '@lib/documents/documents';
import { GraphError, graphFailureMessage } from '@lib/documents/graph';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/documents/content',
    summary: 'Stream a filed document',
    description:
      'Returns the document itself rather than a link to it, from this ' +
      'origin, so a browser can render and print it in place. Same ' +
      'permission and same document as the view URL — only the delivery ' +
      'differs.',
    tag: 'Documents',
    permission: 'document.view',
    query: [
      {
        name: 'documentId',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responseSchema: { type: 'string', format: 'binary' },
  },
  async ({ context, correlationId }) => {
    const documentId = new URL(context.request.url).searchParams.get(
      'documentId'
    );
    if (!documentId) {
      throw new ApiError('validation_failed', undefined, {
        documentId: ['is required'],
      });
    }

    try {
      const { body, fileName, contentType } =
        await getDocumentContent(documentId);

      return new Response(body, {
        headers: {
          'content-type': contentType,
          // Rendered in place, never saved: the officer asked to print it,
          // not to keep a copy on the branch machine.
          'content-disposition': `inline; filename="${fileName.replace(/"/g, '')}"`,
          // Short-lived and personal. A shared cache holding a member's
          // identity document is exactly what must not happen.
          'cache-control': 'private, no-store',
          // Uploads are already held to a short allow-list of image types and
          // PDF (upload.ts), so nothing here can be a document the browser
          // would run. This says so outright rather than leaving it to
          // sniffing, which is what would turn a mislabelled upload served
          // from this origin into a page of ours.
          'x-content-type-options': 'nosniff',
        },
      });
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
export const GET: APIRoute = endpoint.handler;
