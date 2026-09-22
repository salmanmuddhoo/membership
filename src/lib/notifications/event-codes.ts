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

  const [subject, happening] = eventCode.split('.');
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
