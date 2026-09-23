// The receipt as a document (S-1602's Should half): the same sheet
// TransactionReceiptSheet.astro renders, typeset as a one-page PDF so it can
// travel as a WhatsApp document or an email attachment rather than only as
// a link. Drawn with jsPDF directly — text and rules, no browser — because a
// headless browser is not something a Vercel function can carry, and the
// sheet is a handful of labelled lines that need no layout engine.
//
// Reprint marks and the print history are deliberately absent: those belong
// to the paper an officer hands over, and this is the copy the member keeps.
import { jsPDF } from 'jspdf';
import { formatMoney } from '../payments/money';
import type { TransactionReceipt } from './receipts';

const TITLES: Record<string, string> = {
  deposit: 'Deposit receipt',
  withdrawal: 'Withdrawal receipt',
  transfer_leg: 'Transfer receipt',
  reversal: 'Reversal',
  closure: 'Account closure receipt',
  resignation: 'Resignation receipt',
  demise: 'Demised claim receipt',
};

const LINES: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
  closure: 'Account closed · balance paid out',
  resignation: 'Membership resigned · Shares and MSA paid out',
  demise: 'Entitlements paid to the claimant',
};

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Indian/Mauritius',
});

// What the sheet says, row by row — the same reading of the transaction the
// Astro sheet makes, kept in one place so the PDF cannot drift from it.
export function receiptFacts(
  receipt: TransactionReceipt
): { label: string; value: string }[] {
  const t = receipt.transaction;
  const holder = [t.holderName || t.holderKind, t.memberNo]
    .filter(Boolean)
    .join(' · ');
  const otherSide =
    t.kind === 'transfer_leg'
      ? t.payeeName ||
        [
          t.counterpartHolderName,
          t.counterpartAccountNo &&
            `${t.counterpartAccountNo} · ${t.counterpartAccountTypeName}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const moneyIn = t.kind === 'deposit' || t.legDirection === 'credit';

  const rows: { label: string; value: string }[] = [
    {
      label: moneyIn ? 'Received from' : 'Paid to',
      value: t.payeeName || receipt.depositorName || holder,
    },
    ...(receipt.depositorName ? [{ label: 'On behalf of', value: holder }] : []),
    { label: 'Account', value: `${t.accountNo} · ${t.accountTypeName}` },
  ];
  if (otherSide && !t.payeeName) {
    rows.push({
      label: t.legDirection === 'credit' ? 'From' : 'To',
      value: otherSide,
    });
  }
  if (t.payeeName) {
    rows.push({
      label: t.kind === 'demise' ? 'Entitlements of' : 'On behalf of',
      value: holder,
    });
  }
  rows.push({
    label: 'Transaction',
    value: t.displayReference,
  });
  if (t.method !== 'internal_transfer') {
    rows.push({
      label: 'Method',
      value: [t.methodName, t.methodReference].filter(Boolean).join(' · '),
    });
  }
  rows.push({
    label: 'Recorded by',
    value: [t.capturedByName, receipt.capturedByRole]
      .filter(Boolean)
      .join(' · '),
  });
  if (receipt.postedByName && receipt.postedByName !== t.capturedByName) {
    rows.push({ label: 'Posted by', value: receipt.postedByName });
  }
  return rows;
}

export function receiptPdfFileName(receipt: TransactionReceipt): string {
  return `Receipt ${receipt.receiptNo}.pdf`;
}

/**
 * The receipt, as one A4 page. Returns the file's bytes.
 */
export function renderReceiptPdf(receipt: TransactionReceipt): ArrayBuffer {
  const t = receipt.transaction;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const left = 20;
  const right = 190;
  let y = 24;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Al Barakah MCSL', left, y);
  doc.setFontSize(11);
  doc.text(receipt.receiptNo, right, y, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(TITLES[t.kind] ?? 'Receipt', left, y);
  doc.text(dateFormat.format(t.postedAt ?? t.createdAt), right, y, {
    align: 'right',
  });
  doc.setTextColor(0);
  y += 5;
  doc.setDrawColor(180);
  doc.line(left, y, right, y);
  y += 9;

  if (receipt.state === 'void') {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(180, 0, 0);
    doc.text(
      `VOID${receipt.voidedAt ? ` · ${dateFormat.format(receipt.voidedAt)}` : ''}${
        receipt.voidReason ? ` · ${receipt.voidReason}` : ''
      }`,
      left,
      y
    );
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    y += 8;
  }

  for (const row of receiptFacts(receipt)) {
    doc.setTextColor(90);
    doc.text(row.label, left, y);
    doc.setTextColor(0);
    const lines = doc.splitTextToSize(row.value, right - left - 45) as string[];
    doc.text(lines, left + 45, y);
    y += 6 * Math.max(1, lines.length);
  }

  y += 4;
  doc.line(left, y, right, y);
  y += 8;
  const line = [LINES[t.kind] ?? t.kind, t.reason].filter(Boolean).join(' · ');
  const amount = formatMoney(t.amount, t.currency);
  doc.text(doc.splitTextToSize(line, right - left - 50) as string[], left, y);
  doc.text(amount, right, y, { align: 'right' });
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.text('Total', left, y);
  doc.text(amount, right, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 4;
  doc.line(left, y, right, y);
  y += 8;

  if (t.balanceAfter) {
    doc.setTextColor(90);
    doc.text(
      `Balance after: ${formatMoney(t.balanceAfter, t.currency)}`,
      left,
      y
    );
    doc.setTextColor(0);
    y += 10;
  }

  y = Math.max(y + 20, 150);
  doc.line(left, y, left + 70, y);
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text('For Al Barakah Multipurpose Co-operative Society Limited', left, y);

  return doc.output('arraybuffer');
}
