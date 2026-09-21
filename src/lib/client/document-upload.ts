// Filing a document from the browser, without a file picker (S-403, S-408).
//
// This is the same three-phase transfer the manual upload widget on the
// Documents step already uses — begin-upload asks the backend where the file
// goes and for how long, the bytes go to SharePoint in chunks, commit-upload
// asks SharePoint whether they actually arrived. Generalised to take any
// Blob rather than only a picked File, so a PDF generated on screen (pdf.ts)
// can be filed exactly the way a photographed document already is — through
// the one path that decides where a file may go and confirms it landed,
// never by trusting the browser's own word that a transfer finished.
export interface UploadDocumentInput {
  applicationId?: string;
  memberId?: string;
  documentTypeId: string;
  subject: 'applicant' | 'nominee' | 'guardian' | 'beneficiary';
  fileName: string;
  blob: Blob;
  // Reported as the transfer proceeds, in the same words the manual upload
  // widget already shows an officer, so a generated document is not a
  // different-feeling wait from a photographed one.
  onStatus?: (message: string) => void;
}

export class DocumentUploadError extends Error {}

export async function uploadDocumentBlob(
  input: UploadDocumentInput
): Promise<{ documentId: string }> {
  const say = (message: string) => input.onStatus?.(message);
  const contentType = input.blob.type || 'application/pdf';

  say('Preparing…');
  const begun = await fetch('/api/v1/documents/begin-upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      applicationId: input.applicationId,
      memberId: input.memberId,
      documentTypeId: input.documentTypeId,
      subject: input.subject,
      fileName: input.fileName,
      contentType,
      sizeBytes: input.blob.size,
    }),
  });
  const begunBody = await begun.json();
  if (!begun.ok) {
    throw new DocumentUploadError(
      begunBody?.error?.message ?? 'The upload was refused.'
    );
  }
  const {
    documentId,
    versionId,
    uploadUrl,
    chunkSize,
  }: {
    documentId: string;
    versionId: string;
    uploadUrl: string;
    chunkSize: number;
  } = begunBody.data;

  const putChunk = (
    start: number,
    end: number
  ): Promise<{ ok: boolean; status: number }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader(
        'content-range',
        `bytes ${start}-${end - 1}/${input.blob.size}`
      );
      xhr.upload.addEventListener('progress', event => {
        if (!event.lengthComputable) return;
        const sent = start + event.loaded;
        say(`Sending… ${Math.round((sent / input.blob.size) * 100)}%`);
      });
      xhr.addEventListener('load', () =>
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
        })
      );
      xhr.addEventListener('error', () =>
        reject(
          new DocumentUploadError(
            'The transfer failed — check your connection.'
          )
        )
      );
      xhr.send(input.blob.slice(start, end));
    });

  for (let start = 0; start < input.blob.size; start += chunkSize) {
    const end = Math.min(start + chunkSize, input.blob.size);
    const result = await putChunk(start, end);
    if (!result.ok && result.status !== 202) {
      throw new DocumentUploadError(`The transfer failed (${result.status}).`);
    }
  }

  say('Confirming…');
  const committed = await fetch('/api/v1/documents/commit-upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ versionId }),
  });
  const commitBody = await committed.json();
  if (!committed.ok) {
    throw new DocumentUploadError(
      commitBody?.error?.message ?? 'The file could not be confirmed.'
    );
  }

  say('Filed.');
  return { documentId };
}
