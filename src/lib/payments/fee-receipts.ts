// A membership fee receipt sent to the person who paid (officer request):
// when an application's fees are recorded, the receipt the officer prints is
// also sent as a PDF, by email and WhatsApp, to the applicant's contact
// details — the same way a transaction's receipt goes (S-1602,
// src/lib/ledger/receipt-notifications.ts), never as a link.
//
// The PDF is drawn here with jsPDF, line for line what the printed sheet at
// /receipts/{id} shows: who it was received from (the guardian or contact
// person where they paid for a minor or a corporate), the method, who took
// it, the lines and the total. Reprint marks and the print history belong to
// the paper and are left out.
import { jsPDF } from 'jspdf';
import { loadApplication } from '../applications/capture';
import { depositorForApplication } from '../applications/depositor';
import { feeReceiptPdfLink } from '../ledger/receipt-links';
import { FEE_RECEIPT_ISSUED } from '../notifications/event-codes';
import { contactFor, type Contact } from '../notifications/events';
import { notify } from '../notifications/notify';
import { localFormat } from '../time';
import { formatMoney } from './money';
import type { Payment } from './payments';

const dateFormat = localFormat({ dateStyle: 'long', timeStyle: 'short' });

export interface FeeReceiptParties {
  // "Received from": the applicant, or whoever paid for them.
  owner: string;
  // "Account of": the applicant, where someone else paid for them.
  accountOf: string | null;
}

// The two names the sheet prints. A Minor cannot pay in for themselves and a
// Corporate entity is not a person, so the guardian and the Contact Person
// respectively are who stood at the counter (depositorFor); the applicant
// then gets a line of their own.
export async function feeReceiptParties(
  payment: Payment
): Promise<FeeReceiptParties> {
  const reference = payment.applicationReference ?? payment.memberNo ?? null;
  const applicant =
    [payment.applicantName, reference].filter(Boolean).join(' · ') || '—';
  // Paid by another member's transfer (officer request): the receipt says
  // who paid, and for whom.
  if (payment.paidByMember) {
    const { name, memberNo } = payment.paidByMember;
    return {
      owner: [name, memberNo].filter(Boolean).join(' · '),
      accountOf: applicant,
    };
  }
  const depositor = await depositorForApplication(payment.applicationId);
  const paidBy = !!depositor.name && depositor.name !== payment.applicantName;
  return paidBy
    ? { owner: depositor.name!, accountOf: applicant }
    : { owner: applicant, accountOf: null };
}

export function feeReceiptPdfFileName(payment: Payment): string {
  return `Receipt ${payment.receiptNo}.pdf`;
}

/** The fee receipt, as one A4 page. Returns the file's bytes. */
export function renderFeeReceiptPdf(
  payment: Payment,
  parties: FeeReceiptParties
): ArrayBuffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const left = 20;
  const right = 190;
  let y = 24;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Al Barakah MCSL', left, y);
  doc.setFontSize(11);
  doc.text(payment.receiptNo, right, y, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(payment.kind === 'refund' ? 'Refund' : 'Official receipt', left, y);
  doc.text(dateFormat.format(payment.receivedAt), right, y, {
    align: 'right',
  });
  doc.setTextColor(0);
  y += 5;
  doc.setDrawColor(180);
  doc.line(left, y, right, y);
  y += 9;

  if (payment.voidedAt) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(180, 0, 0);
    doc.text(
      [`VOID · ${dateFormat.format(payment.voidedAt)}`, payment.voidReason]
        .filter(Boolean)
        .join(' · '),
      left,
      y
    );
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    y += 8;
  }

  const facts: { label: string; value: string }[] = [
    { label: 'Received from', value: parties.owner },
    ...(parties.accountOf
      ? [{ label: 'Account of', value: parties.accountOf }]
      : []),
    {
      label: 'Method',
      value: [payment.methodName, payment.methodReference]
        .filter(Boolean)
        .join(' · '),
    },
    ...(payment.refundsReceiptNo
      ? [{ label: 'Refund of', value: payment.refundsReceiptNo }]
      : []),
    {
      label: 'Received by',
      value: [payment.recordedByName, payment.recordedByRole]
        .filter(Boolean)
        .join(' · '),
    },
  ];
  for (const row of facts) {
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
  for (const line of [...payment.lines, ...payment.accountLines]) {
    doc.text(line.label, left, y);
    doc.text(formatMoney(line.amount, payment.currency), right, y, {
      align: 'right',
    });
    y += 7;
  }
  doc.setFont('helvetica', 'bold');
  doc.text('Total', left, y);
  doc.text(formatMoney(payment.totalAmount, payment.currency), right, y, {
    align: 'right',
  });
  doc.setFont('helvetica', 'normal');
  y += 4;
  doc.line(left, y, right, y);
  y += 8;

  if (payment.varianceReason) {
    doc.setTextColor(90);
    const note = doc.splitTextToSize(
      payment.varianceReason,
      right - left
    ) as string[];
    doc.text(note, left, y);
    doc.setTextColor(0);
    y += 6 * note.length + 4;
  }

  y = Math.max(y + 20, 150);
  doc.line(left, y, left + 70, y);
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text('For Al Barakah Multipurpose Co-operative Society Limited', left, y);

  return doc.output('arraybuffer');
}

export interface FeeReceiptSend {
  // The notification rows written — none when there is no one to write to,
  // no active wording, or no PDF to attach.
  notificationIds: string[];
  contact: Contact | null;
  // False when the PDF cannot be served: no app address or link secret.
  attachable: boolean;
}

/**
 * Send this fee receipt to the applicant, as its PDF, on every channel they
 * have an address for and the event has an active wording for. Never throws:
 * a receipt that could not be sent is still a receipt, and the delivery log
 * says what happened.
 *
 * Only a live payment taken over the counter goes: not a refund, not a void,
 * and not a migrated opening balance (method 'migration'), which nobody paid
 * that day.
 */
export async function notifyFeeReceiptIssued(
  payment: Payment
): Promise<FeeReceiptSend> {
  const none: FeeReceiptSend = {
    notificationIds: [],
    contact: null,
    attachable: true,
  };
  try {
    if (
      payment.kind !== 'payment' ||
      payment.voidedAt ||
      payment.method === 'migration' ||
      !payment.applicationId
    ) {
      return none;
    }
    const application = await loadApplication(payment.applicationId);
    const contact = application ? await contactFor(application) : null;
    if (!contact || (!contact.email && !contact.mobile)) {
      return { ...none, contact };
    }
    const pdf = await feeReceiptPdfLink(payment.id);
    if (!pdf) {
      console.error(
        '[fee-receipts] receipt not sent: no app origin or link secret to serve its PDF'
      );
      return { ...none, contact, attachable: false };
    }
    const lines = [...payment.lines, ...payment.accountLines];
    const notificationIds = await notify({
      eventCode: FEE_RECEIPT_ISSUED,
      recipients: { email: contact.email, mobile: contact.mobile },
      values: {
        member_name: contact.name || payment.applicantName,
        receipt_no: payment.receiptNo,
        reference: payment.applicationReference ?? payment.memberNo ?? '',
        // The wording carries its own "Rs", so the figure goes bare.
        amount: formatMoney(payment.totalAmount, payment.currency).replace(
          /^[A-Z]{3}\s*/,
          ''
        ),
        items: lines.map(l => l.label).join(', '),
      },
      entityType: 'payment',
      entityId: payment.id,
      attachment: {
        url: pdf,
        filename: feeReceiptPdfFileName(payment),
        contentType: 'application/pdf',
      },
      attachmentRequired: true,
    });
    return { notificationIds, contact, attachable: true };
  } catch (error) {
    console.error('[fee-receipts] could not send receipt:', error);
    return none;
  }
}
