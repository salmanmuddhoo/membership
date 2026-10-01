// What a member — or a claimant — is told at every stage of an exit
// (S-1705, FRD 11.1): a closure, a resignation or a demised claim
// submitted, under review, approved with the payout, or rejected with the
// reason. One event per stage per kind (migration 0080), the wording the
// Society's to edit, raised by the request modules and by review.ts and
// never failing what raised it (notify.ts's bargain).
//
// Who is written to differs: a closure or a resignation is the member's,
// so their contact is the one their application recorded (receipt-
// notifications.ts, the same as a receipt's); a claim is the claimant's,
// whose contact is on the claim — the deceased member's own address is the
// one thing that must not be written to.
import { notify } from '../notifications/notify';
import { formatMoney } from '../payments/money';
import { contactForHolder } from './receipt-notifications';
import { accountsClosedTogether } from './claimants';
import type { TransactionSummary } from './review';

export type ExitHappening =
  'submitted' | 'under_review' | 'approved' | 'rejected';

// The event codes' own vocabulary (0080): 'demised', not 'demise'.
const EVENT_SUBJECT: Record<string, string> = {
  closure: 'closure',
  resignation: 'resignation',
  demise: 'demised',
};

export function isExitKind(kind: string): boolean {
  return kind in EVENT_SUBJECT;
}

export function exitEventCode(kind: string, happening: ExitHappening): string {
  return `${EVENT_SUBJECT[kind]}.${happening}`;
}

/**
 * Raise the event for this stage of a request. Never throws; returns the
 * notification ids written, none when there is nobody to write to or no
 * active wording.
 */
// The account the wording names — on a death, every account the closure
// (0099) or the claim covers.
async function accountWords(transaction: TransactionSummary): Promise<string> {
  const covered =
    (transaction.kind === 'closure' && transaction.claimantKind) ||
    transaction.kind === 'demise' ||
    transaction.kind === 'resignation'
      ? await accountsClosedTogether(transaction.id)
      : [];
  return covered.length > 0
    ? covered.map(a => `${a.accountNo} · ${a.typeName}`).join(', ')
    : `${transaction.accountNo} · ${transaction.accountTypeName}`;
}

export async function notifyExit(
  transaction: TransactionSummary,
  happening: ExitHappening,
  extras: { comment?: string | null } = {}
): Promise<string[]> {
  if (!isExitKind(transaction.kind)) return [];
  try {
    // On a death — a claim, or a deceased non-member's closure — the
    // claimant is told, never the holder.
    const recipient =
      transaction.kind === 'demise' || transaction.claimantKind
        ? transaction.claimant
          ? {
              name: transaction.claimant.name,
              email: transaction.claimant.email ?? null,
              mobile: transaction.claimant.mobile ?? null,
            }
          : null
        : await contactForHolder(transaction.holderKind, transaction.holderId);
    if (!recipient || (!recipient.email && !recipient.mobile)) return [];
    return await notify({
      eventCode: exitEventCode(transaction.kind, happening),
      recipients: { email: recipient.email, mobile: recipient.mobile },
      values: {
        recipient_name: recipient.name || transaction.holderName,
        member_name: transaction.holderName,
        reference: transaction.reference,
        account: await accountWords(transaction),
        // The wording carries its own "Rs".
        amount: formatMoney(transaction.amount, transaction.currency).replace(
          /^[A-Z]{3}\s*/,
          ''
        ),
        method: transaction.methodName,
        receipt_no: transaction.receiptNo ?? '',
        comment: (extras.comment ?? '').trim(),
      },
      entityType: 'transaction',
      entityId: transaction.id,
    });
  } catch (error) {
    console.error('[exits] could not send notification:', error);
    return [];
  }
}
