// Sending a member their receipt (S-1602, FRD 6.8). The ledger raises this
// whenever a transaction's receipt is issued, and an officer can raise it
// again from the receipt. What is sent is a template the Society edits
// (migration 0076); who it goes to is the holder's contact details, which
// live on the application that first recorded them (events.ts).
import { loadApplication } from '../applications/capture';
import { loadCustomer, loadMember } from '../members/create';
import { contactFor, type Contact } from '../notifications/events';
import { RECEIPT_ISSUED } from '../notifications/event-codes';
import { notify } from '../notifications/notify';
import { formatMoney } from '../payments/money';
import { receiptLinks } from './receipt-links';
import { receiptPdfFileName } from './receipt-pdf';
import { loadTransactionReceipt, type TransactionReceipt } from './receipts';

const KIND_WORDS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};

// The holder's contact details: a member's or a customer's, off the
// application that captured them. Null for a legacy record with none.
export async function contactForHolder(
  holderKind: 'member' | 'customer',
  holderId: string
): Promise<Contact | null> {
  const applicationId =
    holderKind === 'member'
      ? (await loadMember(holderId))?.applicationId
      : (await loadCustomer(holderId))?.applicationId;
  if (!applicationId) return null;
  const application = await loadApplication(applicationId);
  return application ? contactFor(application) : null;
}

export interface ReceiptSend {
  // The notification rows written — none when the member has no address on
  // file, the event has no active template, or the PDF cannot be attached.
  notificationIds: string[];
  contact: Contact | null;
  // False when there is no PDF to send: without the app's address or the
  // link secret there is nothing for the mail or Meta to fetch it from.
  attachable: boolean;
}

/**
 * Send this receipt to its holder on every channel they have an address for
 * and the event has an active template for. Never throws: a receipt that
 * could not be sent is still a receipt, and the delivery log says what
 * happened.
 */
export async function notifyReceiptIssued(
  transactionId: string
): Promise<ReceiptSend> {
  const empty: ReceiptSend = {
    notificationIds: [],
    contact: null,
    attachable: true,
  };
  try {
    const receipt = await loadTransactionReceipt(transactionId);
    if (!receipt || receipt.state !== 'issued') return empty;
    // On a death — a demised claim, or a deceased non-member's closure —
    // the receipt is the claimant's, as every other message about it is
    // (exit-notifications.ts), never the holder's.
    const claimant = receipt.transaction.claimant;
    const contact = claimant
      ? {
          name: claimant.name,
          email: claimant.email ?? null,
          mobile: claimant.mobile ?? null,
        }
      : await contactForHolder(
          receipt.transaction.holderKind,
          receipt.transaction.holderId
        );
    if (!contact || (!contact.email && !contact.mobile)) {
      return { ...empty, contact };
    }
    // The receipt goes as its PDF and never as an address (officer
    // request): fetched at send time from its signed link — by the mail
    // provider, or by Meta for a WhatsApp document header — and never shown
    // to the member. No link, no PDF, and a message saying a receipt is
    // attached is not sent without one.
    const links = await receiptLinks(transactionId);
    if (!links) {
      console.error(
        '[receipts] receipt not sent: no app origin or link secret to serve its PDF'
      );
      return { ...empty, contact, attachable: false };
    }
    const notificationIds = await notify({
      eventCode: RECEIPT_ISSUED,
      recipients: { email: contact.email, mobile: contact.mobile },
      values: valuesFor(receipt, contact),
      entityType: 'transaction',
      entityId: receipt.transaction.id,
      attachment: {
        url: links.pdf,
        filename: receiptPdfFileName(receipt),
        contentType: 'application/pdf',
      },
      attachmentRequired: true,
    });
    return { notificationIds, contact, attachable: true };
  } catch (error) {
    console.error('[receipts] could not send receipt:', error);
    return empty;
  }
}

function valuesFor(
  receipt: TransactionReceipt,
  contact: Contact
): Record<string, string> {
  const t = receipt.transaction;
  return {
    member_name: contact.name || t.holderName,
    receipt_no: receipt.receiptNo,
    reference: t.reference,
    kind: KIND_WORDS[t.kind] ?? t.kind,
    // The wording carries its own "Rs", so the figure goes bare.
    amount: formatMoney(t.amount, t.currency).replace(/^[A-Z]{3}\s*/, ''),
    account:
      receipt.accountsClosed.length > 0
        ? receipt.accountsClosed
            .map(a => `${a.accountNo} · ${a.typeName}`)
            .join(', ')
        : `${t.accountNo} · ${t.accountTypeName}`,
  };
}
