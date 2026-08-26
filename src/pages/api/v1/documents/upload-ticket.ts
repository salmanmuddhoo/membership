// Broker an upload ticket for a member document (S-112 spike).
//
// The client asks for permission to file a document; it never receives a
// credential, only a short-lived URL scoped to the one file the backend
// authorised. See docs/documents.md.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { createUploadTicket, UploadRejected } from '@lib/documents/upload';

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/documents/upload-ticket',
    summary: 'Request permission to file a document',
    description:
      'Returns a short-lived, single-file upload URL. The bytes go from the ' +
      "device to Microsoft directly, so the platform's request-body limit " +
      'never applies. The caller never receives a credential.',
    tag: 'Documents',
    permission: 'document.upload',
    requestSchema: {
      type: 'object',
      required: ['memberReference', 'fileName', 'sizeBytes', 'contentType'],
      properties: {
        memberReference: { type: 'string', examples: ['ABM-000001'] },
        fileName: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1 },
        contentType: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['uploadUrl', 'expiresAt', 'chunkSize', 'itemPath'],
      properties: {
        uploadUrl: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        chunkSize: { type: 'integer' },
        itemPath: { type: 'string' },
      },
    },
  },
  async ({ context, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      memberReference?: string;
      fileName?: string;
      sizeBytes?: number;
      contentType?: string;
    } | null;

    if (
      !payload?.memberReference ||
      !payload.fileName ||
      typeof payload.sizeBytes !== 'number' ||
      !payload.contentType
    ) {
      throw new ApiError('validation_failed', undefined, {
        body: [
          'memberReference, fileName, sizeBytes and contentType are required',
        ],
      });
    }

    // The member reference decides the folder. The caller does NOT get to say
    // where the file lands — otherwise a valid ticket request could write
    // anywhere in the library.
    if (!/^ABM-\d{6}$/.test(payload.memberReference)) {
      throw new ApiError('validation_failed', undefined, {
        memberReference: ['must look like ABM-000001'],
      });
    }

    try {
      const ticket = await createUploadTicket({
        folderPath: `Members/${payload.memberReference}`,
        fileName: payload.fileName,
        sizeBytes: payload.sizeBytes,
        contentType: payload.contentType,
      });

      return apiSuccess(ticket, correlationId);
    } catch (error) {
      if (error instanceof UploadRejected) {
        throw new ApiError('validation_failed', error.message, {
          file: [error.reason],
        });
      }
      throw error;
    }
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
