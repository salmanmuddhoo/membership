/**
 * The parties on an application that are not the applicant themselves — a
 * nominee, a Takaful beneficiary — grouped and labelled for display.
 *
 * The applicant, Employment Details and the guardian are deliberately left
 * out: each already has a card of its own driven by the editable contact
 * fields, which are the same values in an editable form. What remains is who
 * a record concerns beyond the applicant.
 *
 * Here rather than on a page because three screens now want it: a member's
 * own page, and — since an account opened against a minor or a corporate
 * holder is worked from the holder's details — the additional-account
 * application's Applicant details step.
 */
import { loadApplication } from './capture';
import { forDisplay } from './phone';

const SUBJECT_LABELS: Record<string, string> = {
  nominee: 'Nominee',
  beneficiary: 'Takaful beneficiary',
};

// Phone values are stored in E.164; +23057891234 is not what anyone wants to
// read off a screen. Keyed by name here because a party's values are a plain
// string map with no field configuration attached, unlike the applicant's
// own fields, which carry their own dataType.
const PHONE_KEYS = new Set(['mobile', 'telephone', 'contact_telephone']);

export interface PartyGroup {
  key: string;
  label: string;
  details: { key: string; label: string; value: string }[];
}

export async function otherPartyGroups(
  applicationId: string | null
): Promise<PartyGroup[]> {
  if (!applicationId) return [];
  const application = await loadApplication(applicationId);

  // A membership type that captures two nominees writes a row for each the
  // moment the form is drafted (saveDraft, capture.ts) — one exists whether
  // or not the officer ever filled it in. Left in, an untouched Nominee 2
  // showed up as a heading over nothing (officer feedback). Filtered on what
  // was actually entered rather than on the row existing, and filtered
  // before the count below, so a record with only Nominee 1 filled in reads
  // "Nominee" and not "Nominee 1".
  const parties = (application?.parties ?? [])
    .filter(
      p =>
        p.subject !== 'applicant' &&
        p.subject !== 'employment' &&
        p.subject !== 'guardian'
    )
    .filter(p => Object.values(p.values).some(value => value.trim() !== ''));

  const occurrences = parties.reduce<Record<string, number>>((counts, p) => {
    counts[p.subject] = (counts[p.subject] ?? 0) + 1;
    return counts;
  }, {});

  return parties.map(p => ({
    key: `${p.subject}-${p.ordinal}`,
    label:
      (SUBJECT_LABELS[p.subject] ?? p.subject) +
      (occurrences[p.subject] > 1 ? ` ${p.ordinal}` : ''),
    details: Object.entries(p.values)
      .filter(([, value]) => value.trim() !== '')
      .map(([key, value]) => ({
        key,
        label: key.replace(/_/g, ' '),
        value: PHONE_KEYS.has(key) ? forDisplay(value) : value,
      })),
  }));
}
