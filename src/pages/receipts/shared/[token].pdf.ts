// The receipt as a file, on the signed link (S-1602). The same token that
// opens /receipts/shared/{token} opens {token}.pdf: no sign-in, one
// transaction, thirty days. This is what a WhatsApp document or an email
// attachment is fetched from at send time, and what a member who wants a
// copy to keep downloads from the page.
import type { APIRoute } from 'astro';
import { verifyReceiptToken } from '@lib/ledger/receipt-links';
import { receiptPdfFileName, renderReceiptPdf } from '@lib/ledger/receipt-pdf';
import { loadTransactionReceipt } from '@lib/ledger/receipts';

export const GET: APIRoute = async ({ params }) => {
  const transactionId = params.token
    ? await verifyReceiptToken(params.token)
    : null;
  const receipt = transactionId
    ? await loadTransactionReceipt(transactionId)
    : null;
  if (!receipt) {
    return new Response('This link has expired or is not valid.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(renderReceiptPdf(receipt), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${receiptPdfFileName(receipt)}"`,
      // Personal, and reachable by anyone holding the link: never in a
      // shared cache.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
