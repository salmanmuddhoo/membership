// Small, display-only label fixes for the member page and list (QA-12,
// QA-16, QA-31). Nothing here changes what is stored — only how a raw code
// or a mis-cased configured label reads on screen.
import { STATUS_LABELS, type MemberStatus } from './status';
import { localFormat } from '../time';

function capitalise(word: string): string {
  return word.length === 0
    ? word
    : word.charAt(0).toUpperCase() + word.slice(1);
}

// A member's status already has a proper word (STATUS_LABELS, status.ts).
// Everything else shown as a status here — a customer's ('active',
// 'converted') or an account's ('active', 'closed') — is not that enum but
// needs exactly the same treatment: capitalise the one word.
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as MemberStatus] ?? capitalise(status);
}

// otherPartyGroups (applications/parties.ts) labels a Nominee/Beneficiary
// detail from its raw field key — those fields carry no configured label of
// their own, unlike the applicant/employment/guardian fields on the same
// page (membership_type_field, migration 0010). NIC and a linked member's
// own number are common enough, and read as codes rather than words often
// enough, to spell out here rather than leave to Title Case.
export function partyDetailLabel(key: string, fallback: string): string {
  if (key === 'nic' || key.endsWith('_nic')) return 'NIC';
  if (key === 'member_id') return 'Member No.';
  return fallback;
}

// The guardian block's field labels are configured (migration 0010) and
// already read correctly everywhere except this one: "Guardian Member ID"
// was written Title Case, unlike every other label there ("Guardian NIC",
// "Relationship to minor", ...), which reads as sentence case once the
// page stops Title-casing configured text (see the member page's dt's).
export function guardianFieldLabel(fieldKey: string, label: string): string {
  return fieldKey === 'member_id' ? 'Guardian member ID' : label;
}

// A date-only value — a date-of-birth field, a membership's own "joined" —
// shown the way the rest of the app writes a date: day, short month, year,
// never a time a date column never actually carried.
// A moment (a membership's "joined") reads as its Mauritius day.
const dateOnlyFormat = localFormat({
  dateStyle: 'medium',
});
// A calendar day typed as yyyy-mm-dd is that day wherever it is read: built
// as UTC midnight and printed in UTC, so no clock can move it.
const calendarDayFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});
export function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    // A yyyy-mm-dd value (an application_party field's own dataType:
    // 'date') — built from its own parts rather than `new Date(value)`.
    const [y, m, d] = value.split('-').map(Number);
    if (y && m && d) {
      return calendarDayFormat.format(new Date(Date.UTC(y, m - 1, d)));
    }
    return dateOnlyFormat.format(new Date(value));
  }
  return dateOnlyFormat.format(value);
}
