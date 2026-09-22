// The vocabulary of notification events (S-902).
//
// Two questions about an event code: what is it called, and what may a
// template written for it use? Both are asked by the sender (events.ts, which
// raises the event) and by the template editor (templates.ts, which validates
// the wording) — so they live here, in a module that imports nothing, rather
// than in either one importing the other.
//
// The names and the placeholder lists have to agree with what `notifyAbout`
// actually passes. They are two halves of one contract, and events.test.ts
// checks them against each other.

export type Happening = 'submitted' | 'returned' | 'approved' | 'rejected';

// An exit's stages (S-1705): closure.*, resignation.* and demised.*, what
// src/lib/ledger/exit-notifications.ts passes for each.
export const EXIT_SUBJECTS = ['closure', 'resignation', 'demised'] as const;
export const EXIT_HAPPENINGS = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
] as const;
const EXIT_COMMON = [
  'recipient_name',
  'member_name',
  'reference',
  'account',
  'amount',
] as const;

// A member's own transactions (S-1803) and the staff who wait on them
// (S-1804, S-1805): what src/lib/ledger/transaction-notifications.ts
// passes for each.
const TRANSACTION_COMMON = [
  'member_name',
  'reference',
  'amount',
  'account',
] as const;
const STAFF_COMMON = [
  'recipient_name',
  'kind',
  'reference',
  'member_name',
  'amount',
  'account',
  'link',
] as const;
export const TRANSACTION_PLACEHOLDERS: Record<string, readonly string[]> = {
  'deposit.posted': [...TRANSACTION_COMMON, 'balance'],
  'withdrawal.submitted': TRANSACTION_COMMON,
  'withdrawal.under_review': [...TRANSACTION_COMMON, 'comment'],
  'withdrawal.disbursed': [
    ...TRANSACTION_COMMON,
    'method',
    'receipt_no',
    'balance',
  ],
  'withdrawal.rejected': [...TRANSACTION_COMMON, 'comment'],
  'transfer.posted': [
    ...TRANSACTION_COMMON,
    'from_account',
    'to_account',
    'balance',
  ],
  'balance.near_floor': [...TRANSACTION_COMMON, 'balance', 'floor'],
  'transaction.awaiting': [...STAFF_COMMON, 'step', 'captured_by'],
  'transaction.returned': [...STAFF_COMMON, 'returned_by', 'comment'],
  'receipt.voided': [...STAFF_COMMON, 'receipt_no', 'voided_by', 'reason'],
};

export const RECEIPT_ISSUED = 'receipt.issued';
export const RECEIPT_PLACEHOLDERS = [
  'member_name',
  'receipt_no',
  'reference',
  'kind',
  'amount',
  'account',
  'link',
] as const;

/**
 * The event code for one thing happening to one kind of application.
 *
 * A membership application and an account application are different news. A
 * non-member opening a savings account must not be welcomed as a member, and
 * an existing member opening a second account must not be told their
 * membership has been approved — so the two carry different codes, and the
 * Society writes each its own wording (migrations 0053 and 0054).
 */
// A member's standing (S-804, S-805): what src/lib/members/dormancy.ts
// passes when the nightly job marks a member dormant and when an officer
// reactivates them — and what details-requests.ts passes when a details
// update the member sent from the app is applied (the fields that changed,
// by label) or declined (the reason the officer wrote).
export const MEMBER_PLACEHOLDERS: Record<string, readonly string[]> = {
  'member.dormant': ['member_name', 'member_no', 'last_activity', 'months'],
  'member.reactivated': ['member_name', 'member_no', 'reason'],
  'member.details.applied': ['member_name', 'member_no', 'fields'],
  'member.details.declined': ['member_name', 'member_no', 'reason'],
};

export function eventCodeForKind(
  applicationKind: string,
  happening: Happening
): string {
  const subject = applicationKind === 'membership' ? 'application' : 'account';
  return `${subject}.${happening}`;
}

/**
 * Which placeholders an event actually fills in.
 *
 * The template editor needs this: a placeholder with no value renders as
 * nothing, so an administrator who writes `{{member_number}}` for
 * `{{member_no}}` produces "Your member number is ." in a real member's inbox
 * and nothing anywhere says why. Knowing the list here is what lets the
 * editor refuse it instead of a member discovering it.
 *
 * Null for an event this system does not raise — a code someone added by hand
 * is not necessarily wrong, and refusing what cannot be checked would be.
 */
export function placeholdersForEvent(eventCode: string): string[] | null {
  // A transaction's receipt (S-1602): what the ledger passes when one is
  // issued or re-sent (src/lib/ledger/receipt-notifications.ts).
  if (eventCode === RECEIPT_ISSUED) return [...RECEIPT_PLACEHOLDERS];
  if (eventCode in TRANSACTION_PLACEHOLDERS) {
    return [...TRANSACTION_PLACEHOLDERS[eventCode]];
  }
  if (eventCode in MEMBER_PLACEHOLDERS) {
    return [...MEMBER_PLACEHOLDERS[eventCode]];
  }

  const [subject, happening] = eventCode.split('.');
  if ((EXIT_SUBJECTS as readonly string[]).includes(subject)) {
    if (!(EXIT_HAPPENINGS as readonly string[]).includes(happening)) {
      return null;
    }
    switch (happening) {
      case 'under_review':
      case 'rejected':
        return [...EXIT_COMMON, 'comment'];
      case 'approved':
        return [...EXIT_COMMON, 'method', 'receipt_no'];
      default:
        return [...EXIT_COMMON];
    }
  }
  if (subject !== 'application' && subject !== 'account') return null;

  const common = ['applicant_name', 'reference'];
  switch (happening) {
    case 'submitted':
      return common;
    case 'returned':
    case 'rejected':
      return [...common, 'comment'];
    case 'approved':
      // A member number exists only where a membership was approved; an
      // account application's own template has no such thing to name.
      return subject === 'application' ? [...common, 'member_no'] : common;
    default:
      return null;
  }
}
