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
import { receiptLink } from './receipt-links';
import { loadTransactionReceipt, type TransactionReceipt } from './receipts';

const KIND_WORDS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
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
  // file or the event has no active template.
  notificationIds: string[];
  contact: Contact | null;
  link: string | null;
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
  const empty: ReceiptSend = { notificationIds: [], contact: null, link: null };
  try {
    const receipt = await loadTransactionReceipt(transactionId);
    if (!receipt || receipt.state !== 'issued') return empty;
    const contact = await contactForHolder(
      receipt.transaction.holderKind,
      receipt.transaction.holderId
    );
    if (!contact || (!contact.email && !contact.mobile)) {
      return { ...empty, contact };
    }
    const link = await receiptLink(transactionId);
    const notificationIds = await notify({
      eventCode: RECEIPT_ISSUED,
      recipients: { email: contact.email, mobile: contact.mobile },
      values: valuesFor(receipt, contact, link),
      entityType: 'transaction',
      entityId: receipt.transaction.id,
    });
    return { notificationIds, contact, link };
  } catch (error) {
    console.error('[receipts] could not send receipt:', error);
    return empty;
  }
}

function valuesFor(
  receipt: TransactionReceipt,
  contact: Contact,
  link: string | null
): Record<string, string> {
  const t = receipt.transaction;
  return {
    member_name: contact.name || t.holderName,
    receipt_no: receipt.receiptNo,
    reference: t.reference,
    kind: KIND_WORDS[t.kind] ?? t.kind,
    // The wording carries its own "Rs", so the figure goes bare.
    amount: formatMoney(t.amount, t.currency).replace(/^[A-Z]{3}\s*/, ''),
    account: `${t.accountNo} · ${t.accountTypeName}`,
    // Without an origin or a secret there is no link to give; the wording
    // then says where to ask, rather than carrying a broken address.
    link: link ?? 'Ask at your branch for a printed copy.',
  };
}
