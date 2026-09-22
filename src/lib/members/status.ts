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

// Only an active member transacts or opens an account. The capture paths
// (deposits.ts, withdrawals.ts, closures.ts) read the holder's status and
// refuse anything else, naming it; this is the one place that says which
// statuses those are, so a page can hide what the library would refuse.
export function canTransact(status: string): boolean {
  return status === 'active';
}

// Who may apply for a further account (HSA, Investment, …). An active
// holder, and — officer direction — a resigned member: they left the
// membership, not the Society, and keep the accounts that were never the
// membership's; a further one of those is theirs to open, on their existing
// record, through the same application. Shares and the MSA are not (that
// is a rejoin).
export function canOpenAccount(status: string): boolean {
  return status === 'active' || status === 'resigned';
}

// The line the member page shows for a member who cannot transact: what
// they are, since when, and what that means at the counter. Null for an
// active member, who needs no line.
export function statusNotice(
  status: string,
  changedAt: Date | null,
  format = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' })
): string | null {
  if (canTransact(status)) return null;
  const label = STATUS_LABELS[status as MemberStatus] ?? status;
  const since = changedAt ? ` since ${format.format(changedAt)}` : '';
  return canOpenAccount(status)
    ? `${label}${since}. No transactions.`
    : `${label}${since}. No transactions and no new accounts.`;
}
