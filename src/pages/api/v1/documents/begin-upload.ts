// Phase one of filing a document: authorise it and get a ticket (S-403, S-408).
//
// The bytes never pass through this application. The client is handed a
// short-lived URL scoped to the one file the backend chose a home for, and the
// checklist still reads Missing until commit-upload confirms with SharePoint
// that the file actually arrived.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { beginUpload, DocumentError } from '@lib/documents/documents';
import { UploadRejected } from '@lib/documents/upload';
import type { FieldSubject } from '@lib/config/reference';

const SUBJECTS: ReadonlySet<string> = new Set([
  'applicant',
  'nominee',
  'guardian',
  'beneficiary',
]);

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/documents/begin-upload',
    summary: 'Start filing a document',
    description:
      'Records the intent to file a document and returns a short-lived, ' +
      'single-file upload URL. The caller never receives a credential, and ' +
      'never says where the file goes — the folder comes from the ' +
      'application or member it is filed against. Nothing appears on the ' +
      'checklist until commit-upload.',
    tag: 'Documents',
    permission: 'document.upload',
    requestSchema: {
      type: 'object',
      required: [
        'documentTypeId',
        'subject',
        'fileName',
        'contentType',
        'sizeBytes',
      ],
      properties: {
        applicationId: { type: 'string', format: 'uuid' },
        memberId: { type: 'string', format: 'uuid' },
        documentTypeId: { type: 'string', format: 'uuid' },
        subject: {
          type: 'string',
          enum: ['applicant', 'nominee', 'guardian', 'beneficiary'],
        },
        fileName: { type: 'string' },
        contentType: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1 },
        expiresAt: {
          type: 'string',
          format: 'date',
          description:
            'Required for a document type configured to track expiry.',
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: [
        'documentId',
        'versionId',
        'uploadUrl',
        'expiresAt',
        'chunkSize',
      ],
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        versionId: { type: 'string', format: 'uuid' },
        uploadUrl: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        chunkSize: { type: 'integer' },
      },
    },
  },
  async ({ context, principal, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      applicationId?: string;
      memberId?: string;
      documentTypeId?: string;
      subject?: string;
      fileName?: string;
      contentType?: string;
      sizeBytes?: number;
      expiresAt?: string;
    } | null;

    if (!payload) {
      throw new ApiError('validation_failed', 'A JSON body is required.');
    }

    const problems: Record<string, string[]> = {};
    if (!payload.applicationId && !payload.memberId) {
      problems.owner = ['one of applicationId or memberId is required'];
    }
    if (payload.applicationId && payload.memberId) {
      problems.owner = [
        'a document belongs to an application or a member, not both',
      ];
    }
    if (!payload.documentTypeId) {
      problems.documentTypeId = ['is required'];
    }
    if (!payload.subject || !SUBJECTS.has(payload.subject)) {
      problems.subject = [`must be one of ${[...SUBJECTS].join(', ')}`];
    }
    if (!payload.fileName) problems.fileName = ['is required'];
    if (!payload.contentType) problems.contentType = ['is required'];
    if (typeof payload.sizeBytes !== 'number' || payload.sizeBytes <= 0) {
      problems.sizeBytes = ['must be a positive number of bytes'];
    }

    // Parsed here rather than passed through, so an unreadable date is a
    // validation error the officer can see rather than an Invalid Date landing
    // in the column that decides when the document lapses.
    let expiresAt: Date | null = null;
    if (payload.expiresAt) {
      expiresAt = new Date(payload.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        problems.expiresAt = ['is not a date'];
      }
    }

    if (Object.keys(problems).length > 0) {
      throw new ApiError('validation_failed', undefined, problems);
    }

    try {
      const result = await beginUpload(
        {
          applicationId: payload.applicationId,
          memberId: payload.memberId,
          documentTypeId: payload.documentTypeId!,
          subject: payload.subject as FieldSubject,
          fileName: payload.fileName!,
          contentType: payload.contentType!,
          sizeBytes: payload.sizeBytes!,
          expiresAt,
        },
        { userId: principal.userId, email: principal.email }
      );

      // The ticket's itemPath is deliberately not returned. It is the drive
      // path the backend chose, and the client has no use for it — commit is
      // by versionId, which is the handle the client was given.
      return apiSuccess(
        {
          documentId: result.documentId,
          versionId: result.versionId,
          uploadUrl: result.ticket.uploadUrl,
          expiresAt: result.ticket.expiresAt,
          chunkSize: result.ticket.chunkSize,
        },
        correlationId
      );
    } catch (error) {
      if (error instanceof UploadRejected) {
        throw new ApiError('validation_failed', error.message, {
          file: [error.reason],
        });
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
