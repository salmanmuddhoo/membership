// The receipt as a file, on the signed link (S-1602). The same token that
// opens /receipts/shared/{token} opens {token}.pdf: no sign-in, one
// receipt, thirty days. This is what a WhatsApp document or an email
// attachment is fetched from at send time, and what a member who wants a
// copy to keep downloads from the page.
//
// Two kinds of receipt share the address: a transaction's, and a membership
// fee receipt (a payment), each under a token signed for its own purpose.
import type { APIRoute } from 'astro';
import {
  verifyFeeReceiptToken,
  verifyReceiptToken,
} from '@lib/ledger/receipt-links';
import { receiptPdfFileName, renderReceiptPdf } from '@lib/ledger/receipt-pdf';
import { loadTransactionReceipt } from '@lib/ledger/receipts';
import {
  feeReceiptParties,
  feeReceiptPdfFileName,
  renderFeeReceiptPdf,
} from '@lib/payments/fee-receipts';
import { loadPayment } from '@lib/payments/payments';

function pdfResponse(bytes: ArrayBuffer, filename: string): Response {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${filename}"`,
      // Personal, and reachable by anyone holding the link: never in a
      // shared cache.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const GET: APIRoute = async ({ params }) => {
  const token = params.token ?? '';

  const transactionId = token ? await verifyReceiptToken(token) : null;
  const receipt = transactionId
    ? await loadTransactionReceipt(transactionId)
    : null;
  if (receipt) {
    return pdfResponse(renderReceiptPdf(receipt), receiptPdfFileName(receipt));
  }

  const paymentId = token ? await verifyFeeReceiptToken(token) : null;
  const payment = paymentId ? await loadPayment(paymentId) : null;
  if (payment) {
    return pdfResponse(
      renderFeeReceiptPdf(payment, await feeReceiptParties(payment)),
      feeReceiptPdfFileName(payment)
    );
  }

  return new Response('This link has expired or is not valid.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
