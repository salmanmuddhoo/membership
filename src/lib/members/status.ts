// What a member's status may be, and what each one permits (S-1701, FRD
// 7, RES-US-006, DEM-US-007, open point 2). The database refuses any other
// value (migration 0077); this is the same list for the code, with the
// words the screen uses and the one rule every capture path asks: may
// money move for this person?
export const MEMBER_STATUSES = [
  'pending',
  'active',
  'inactive',
  'dormant',
  'resigned',
  'demised',
] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const STATUS_LABELS: Record<MemberStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  inactive: 'Inactive',
  dormant: 'Dormant',
  resigned: 'Resigned',
  demised: 'Demised',
};

// Who money may move for. The capture paths (deposits.ts, withdrawals.ts,
// transfers.ts, closures.ts) read the holder's status and refuse anything
// else, naming it; this is the one place that says which statuses those
// are, so a page can hide what the library would refuse.
//
// An active holder, and — officer direction — a resigned member: resigning
// ends the membership, not the relationship. The Shares and the MSA closed
// with it, so what is left open is only ever a non-membership account
// (HSA, Investment), and on those they deal exactly as a non-member
// customer does. Dormant, inactive, pending and demised still move nothing.
export function canTransact(status: string): boolean {
  return status === 'active' || status === 'resigned';
}

// A resigned member who still holds an open account is, to the Society, a
// non-member: the screens tag them so, alongside customers.
export function isNonMember(
  status: string,
  accounts: readonly { status: string }[]
): boolean {
  return status === 'resigned' && accounts.some(a => a.status !== 'closed');
}

// Officer direction: a resigned member still holding an open account is,
// on screen, an active non-member — they resigned the membership, not
// the Society. The stored status stays 'resigned' (Rejoin keys on it).
export function shownStatus(status: string, nonMember: boolean): string {
  return status === 'resigned' && nonMember ? 'active' : status;
}

// Who may apply for a further account (HSA, Investment, …). An active
// holder, and — officer direction — a resigned member: they left the
// membership, not the Society, and keep the accounts that were never the
// membership's; a further one of those is theirs to open, on their existing
// record, through the same application. Shares and the MSA are not (that
// is a rejoin).
// 'closed' is a non-member whose every account has been closed
// (markCustomerClosedOnceAllClosed): a new account makes them active again.
export function canOpenAccount(status: string): boolean {
  return status === 'active' || status === 'resigned' || status === 'closed';
}

// The line the member page shows for a member who cannot transact: what
// they are, since when, and what that means at the counter. Null for an
// active member, who needs no line.
export function statusNotice(
  status: string,
  changedAt: Date | null,
  format = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' })
): string | null {
  if (status === 'active') return null;
  if (status === 'closed') return 'Every account is closed.';
  const label = STATUS_LABELS[status as MemberStatus] ?? status;
  const since = changedAt ? ` since ${format.format(changedAt)}` : '';
  // A resigned member transacts and opens accounts as a non-member does:
  // the line says what they are, and nothing is refused.
  if (canTransact(status)) return `${label}${since}.`;
  return `${label}${since}. No transactions and no new accounts.`;
}
