// Brokered upload to SharePoint (S-112).
//
// THE CONSTRAINT
//
// A Vercel serverless function accepts a request body of about 4.5 MB. A photo
// from a tablet is routinely 3-12 MB. So a document cannot simply be POSTed to
// our API and forwarded: the request is rejected before our code runs, and no
// amount of care inside the handler helps.
//
// THE MECHANISM
//
// Graph's large-file protocol is a two-step: create an *upload session*, then
// PUT the bytes to the session's URL in ranges. The session URL returned by
// Graph is pre-authenticated - it carries its own short-lived token, is scoped
// to that one file in that one location, and needs no Authorization header.
//
// So the backend decides WHERE a file may go, WHAT it may be called and HOW
// LARGE it may be, asks Graph for a session on exactly those terms, and hands
// the client only that URL. The client never receives the application's client
// secret or any credential that reaches anything else (AD-09). The bytes travel
// from the tablet to Microsoft directly, so our function's body limit never
// applies.
//
// WHAT THIS COSTS
//
// The browser talks to Graph. That is a real departure from "all SharePoint
// access through the backend", and it is why this is a spike rather than an
// implementation - see docs/documents.md for the alternative and the
// recommendation.
import {
  getAccessToken,
  getGraphConfig,
  GraphError,
  type GraphConfig,
} from './graph';

// Graph requires every chunk except the last to be a multiple of 320 KiB.
const CHUNK_MULTIPLE = 320 * 1024;

// 8 MiB balances round trips against the memory a relayed chunk would occupy.
export const DEFAULT_CHUNK_SIZE = 25 * CHUNK_MULTIPLE;

export interface UploadTicket {
  // Where the client PUTs the bytes. Short-lived, single-file, pre-authenticated.
  uploadUrl: string;
  expiresAt: string;
  chunkSize: number;
  // Our own handle for the document, for correlating the later confirmation.
  itemPath: string;
}

export interface UploadRequest {
  // Folder path within the drive, decided by the BACKEND from the member
  // record - never taken from the client, which would let a caller write
  // anywhere in the library.
  folderPath: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

// A file name from a tablet is user input on the way to a file system. Anything
// that could climb out of the intended folder, or that SharePoint rejects
// outright, is removed rather than escaped - a document's name has no need of
// these characters.
export function sanitiseFileName(raw: string): string {
  const withoutPath = raw.replace(/^.*[\\/]/, '');
  const cleaned = withoutPath
    // SharePoint's own forbidden set.
    .replace(/["*:<>?/\\|#%]/g, '')
    // Control characters, which have no place in a file name.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();

  if (cleaned.length === 0) return 'document';
  // SharePoint's limit is 400 for the whole path; a generous cap on the name
  // leaves room for the folder structure.
  return cleaned.slice(0, 128);
}

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly reason: 'too_large' | 'unsupported_type' | 'invalid_path'
  ) {
    super(message);
    this.name = 'UploadRejected';
  }
}

// What a member document may be. Deliberately a short allow-list rather than a
// block-list: a document repository has no reason to accept an executable, and
// naming what is allowed fails safe as formats appear.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
]);

// Large enough for a high-resolution photograph of an A4 page, small enough
// that a mistake or an abusive caller cannot fill the library.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function validateUploadRequest(request: UploadRequest): void {
  if (request.sizeBytes <= 0 || request.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      `Files must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      'too_large'
    );
  }

  if (!ALLOWED_CONTENT_TYPES.has(request.contentType)) {
    throw new UploadRejected(
      'That file type cannot be filed. Use a photograph or a PDF.',
      'unsupported_type'
    );
  }

  // The folder is chosen by the backend, so a traversal sequence here is a
  // defect on our side rather than an attack - but it must never reach Graph.
  if (
    request.folderPath.includes('..') ||
    request.folderPath.startsWith('/') ||
    request.folderPath.includes('\\')
  ) {
    throw new UploadRejected('Invalid destination folder.', 'invalid_path');
  }
}

// Ask Graph for an upload session on terms the backend chose.
export async function createUploadTicket(
  request: UploadRequest,
  config: GraphConfig = getGraphConfig(),
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<UploadTicket> {
  validateUploadRequest(request);

  const fileName = sanitiseFileName(request.fileName);
  const itemPath = `${request.folderPath}/${fileName}`;
  const token = await getAccessToken(config);

  const response = await fetch(
    `${config.graphBaseUrl}/drives/${config.driveId}/root:/${encodeURI(itemPath)}:/createUploadSession`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        item: {
          // Never silently overwrite a filed document: a replacement is an
          // explicit action with its own history (S-409), not a side effect of
          // uploading a file with the same name.
          '@microsoft.graph.conflictBehavior': 'rename',
          name: fileName,
        },
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GraphError(
      `Graph createUploadSession failed (${response.status}): ${detail}`,
      'request_failed',
      response.status
    );
  }

  const session = (await response.json()) as {
    uploadUrl: string;
    expirationDateTime: string;
  };

  return {
    uploadUrl: session.uploadUrl,
    expiresAt: session.expirationDateTime,
    chunkSize,
    itemPath,
  };
}

export interface UploadedItem {
  id: string;
  name: string;
  size: number;
  webUrl: string;
}

// Send a whole file to an upload session in ranges.
//
// Used by the server (the migration importer files documents this way) and by
// the spike's proof. The browser runs the same algorithm in TypeScript against
// the same session URL.
export async function uploadInChunks(
  uploadUrl: string,
  bytes: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  fetchImpl: typeof fetch = fetch
): Promise<UploadedItem> {
  const total = bytes.byteLength;
  let offset = 0;
  let lastBody: unknown;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const chunk = bytes.subarray(offset, end);

    const response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(chunk.byteLength),
        // Inclusive range, and Graph rejects a mismatch - which is what makes
        // a resumed or retried upload safe rather than corrupting the file.
        'content-range': `bytes ${offset}-${end - 1}/${total}`,
      },
      body: chunk as unknown as BodyInit,
    });

    // 202 means "chunk accepted, send the next"; 200/201 means the last chunk
    // completed the file.
    if (
      response.status !== 202 &&
      response.status !== 200 &&
      response.status !== 201
    ) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Chunk upload failed at byte ${offset} (${response.status}): ${detail}`
      );
    }

    lastBody = await response.json().catch(() => undefined);
    offset = end;
  }

  const item = lastBody as Partial<UploadedItem> | undefined;
  if (!item?.id) {
    // The bytes are all sent but Graph did not describe the finished file, so
    // we cannot record metadata against it. Reporting success here is what
    // S-408 exists to prevent.
    throw new Error(
      'Upload finished without Graph returning the created item; treating as failed.'
    );
  }

  return {
    id: item.id,
    name: item.name ?? '',
    size: item.size ?? total,
    webUrl: item.webUrl ?? '',
  };
}
