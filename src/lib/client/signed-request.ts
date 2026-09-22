// The sheet a member signs on screen, rasterised and filed against their
// request (S-1702, S-1703): the closure request and the resignation request
// share one wiring, and the Cash Deposit Form's is the same shape.
//
// The page carries what the upload needs as data attributes on `.form-page`
// (transaction id, reference, document type id, where to go next, the
// document already on file), and the signature pad, the file button and the
// status line by their data hooks. Nothing here decides where the file
// goes: begin-upload does (documents.ts).
import { renderElementToPdf } from './pdf';
import { uploadDocumentBlob } from './document-upload';
import { openSignaturePad } from './signature';

export function wireSignedRequestForm(options: {
  signatureTitle: string;
  documentLabel: string;
}): void {
  const page = document.querySelector<HTMLElement>('.form-page');
  const fileButton = document.querySelector<HTMLButtonElement>('#file-form');
  const statusEl = document.querySelector<HTMLElement>('[data-status]');
  const sigImage = document.querySelector<HTMLImageElement>('[data-sig-image]');
  const signButton =
    document.querySelector<HTMLButtonElement>('[data-sig-open]');
  const clearButton =
    document.querySelector<HTMLButtonElement>('[data-sig-clear]');
  if (!page || !fileButton || !sigImage || !signButton || !clearButton) return;

  const transactionId = page.dataset.transactionId ?? '';
  const reference = page.dataset.reference ?? '';
  const documentTypeId = page.dataset.documentTypeId ?? '';
  const next = page.dataset.next ?? '';

  const say = (message: string, tone: 'info' | 'error' = 'info') => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  };

  let signature: string | null = null;
  const refresh = () => {
    fileButton.disabled = !signature || documentTypeId === '';
  };
  refresh();

  signButton.addEventListener('click', async () => {
    const result = await openSignaturePad(options.signatureTitle);
    if (!result) return;
    signature = result;
    sigImage.src = result;
    sigImage.hidden = false;
    signButton.textContent = 'Re-sign';
    clearButton.hidden = false;
    refresh();
  });

  clearButton.addEventListener('click', () => {
    signature = null;
    sigImage.hidden = true;
    sigImage.removeAttribute('src');
    signButton.textContent = 'Sign';
    clearButton.hidden = true;
    refresh();
  });

  fileButton.addEventListener('click', () => {
    if (!signature) return;
    fileButton.disabled = true;
    signButton.disabled = true;
    say('Preparing the form…');

    void (async () => {
      // Rasterised from the page itself, so what is filed is the sheet the
      // member read and signed rather than a second rendering of it.
      page.classList.add('capturing');
      let blob: Blob;
      try {
        blob = await renderElementToPdf(page);
      } catch (error) {
        page.classList.remove('capturing');
        say(
          error instanceof Error
            ? `Could not prepare the PDF: ${error.message}`
            : 'Could not prepare the PDF.',
          'error'
        );
        fileButton.disabled = false;
        signButton.disabled = false;
        return;
      }
      page.classList.remove('capturing');

      // A request signed again replaces the one on file, so "the signed
      // request" keeps naming one thing.
      const filedDocumentId = page.dataset.filedDocumentId ?? '';
      if (filedDocumentId) {
        say('Removing the copy on file…');
        try {
          const response = await fetch('/api/v1/documents/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ documentId: filedDocumentId }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(
              body?.error?.message ??
                'The copy already on file could not be removed.'
            );
          }
          page.dataset.filedDocumentId = '';
        } catch (error) {
          say(
            error instanceof Error
              ? error.message
              : 'The copy already on file could not be removed.',
            'error'
          );
          fileButton.disabled = false;
          signButton.disabled = false;
          return;
        }
      }

      try {
        await uploadDocumentBlob({
          transactionId,
          documentTypeId,
          subject: 'applicant',
          fileName: `${reference} - ${options.documentLabel}.pdf`,
          blob,
          onStatus: message => say(message),
        });
        window.location.href = next;
      } catch (error) {
        say(
          (error instanceof Error
            ? error.message
            : 'The request could not be filed.') + ' Please try again.',
          'error'
        );
        fileButton.disabled = false;
        signButton.disabled = false;
      }
    })();
  });
}
