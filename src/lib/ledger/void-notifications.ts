// The Treasurer told of a void (S-1805, NOTIF-US-004, FRD 11.2): whoever
// may void a receipt hears when one is — the reason and who did it — so a
// number struck from the sequence is never a surprise at reconciliation.
// Raised by receipts.ts (a transaction's receipt) and payments.ts (a fee
// receipt) after the void has committed, and never failing either.
//
// Its own module rather than a corner of transaction-notifications.ts so
// that payments.ts, which review.ts imports, can raise it without the
// import graph looping back through review.ts.
import { getAppOrigin } from '../config';
import { notify } from '../notifications/notify';
import { staffWithPermission } from '../notifications/staff';
import { formatMoney } from '../payments/money';

export const RECEIPT_VOIDED = 'receipt.voided';

// How a kind reads in a message.
export const KIND_WORDS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};
// Who is told: every active holder of this permission, except the voider.
export const VOID_PERMISSION = 'receipt.void';

export interface VoidNotice {
  receiptNo: string;
  reference: string;
  kind: string;
  memberName: string;
  amount: string;
  currency: string;
  account: string;
  reason: string;
  // The user who voided it: named in the message, and not written to.
  voidedBy: { userId: string; name: string };
  // Where the receipt is read from, relative to the app's origin.
  path: string;
  entityType: string;
  entityId: string;
}

// The bare figure: the wording carries its own "Rs".
export function bareAmount(amount: string, currency: string): string {
  return formatMoney(amount, currency).replace(/^[A-Z]{3}\s*/, '');
}

// A full address when the origin is known; otherwise where to look.
export function appLink(path: string): string {
  const origin = getAppOrigin();
  return origin ? `${origin}${path}` : 'Sign in to open it.';
}

export async function notifyReceiptVoided(
  notice: VoidNotice
): Promise<string[]> {
  try {
    const recipients = (await staffWithPermission(VOID_PERMISSION)).filter(
      r => r.userId !== notice.voidedBy.userId
    );
    const written: string[] = [];
    for (const recipient of recipients) {
      written.push(
        ...(await notify({
          eventCode: RECEIPT_VOIDED,
          recipients: { email: recipient.email, mobile: null },
          values: {
            recipient_name: recipient.name,
            kind: notice.kind,
            reference: notice.reference,
            member_name: notice.memberName,
            amount: bareAmount(notice.amount, notice.currency),
            account: notice.account,
            link: appLink(notice.path),
            receipt_no: notice.receiptNo,
            voided_by: notice.voidedBy.name,
            reason: notice.reason,
          },
          entityType: notice.entityType,
          entityId: notice.entityId,
        }))
      );
    }
    return written;
  } catch (error) {
    console.error('[receipts] could not send void notice:', error);
    return [];
  }
}
