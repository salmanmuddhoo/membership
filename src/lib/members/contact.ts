// Officer feedback: a regional officer corrects a phone number or address at
// the counter — a member reads it out, or a letter comes back undelivered —
// and the person is standing right there. member_details_request
// (details-requests.ts) exists for the opposite case: a change the member
// themselves sent in from the app, unattended, which is why it goes through
// member.details_verify before it lands. Neither reason applies here, so
// this writes straight to application_party and skips that queue entirely
// (migration 0045, widened for Mobile and Employment Details on officer
// feedback).
//
// Officer feedback, second round: every applicant field was made editable
// here, not a fixed Telephone/Mobile/Address subset — the same edit
// affordance is how a field migration left blank (an optional one the
// legacy register never carried) gets filled in later.
//
// Officer feedback, third round: that went too far — Name, NIC and the
// like should not stay open to correction once they carry a value; a
// typo gets fixed by whoever is responsible for the record, not edited
// at the counter indefinitely. So only ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS
// (Telephone, Mobile, Address, Email — the fields a letter or a phone
// call can go stale) stay editable regardless of value; every other
// applicant field is editable only while still blank, the one case the
// second round was actually meant to cover, and locks the moment it is
// filled in. Employment Details is unaffected — still fully editable,
// same as it always was.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { toInternational, PhoneFormatError } from '../applications/phone';
import { listMembershipTypes } from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_EDIT_CONTACT = 'member.edit_contact';
const ACTION_UPDATED = 'member.contact.updated';

const PHONE_FIELD_KEYS = new Set(['telephone', 'mobile']);

// The applicant fields that stay editable no matter what they already
// hold — everything else locks once it has a value (see the comment
// above the imports).
const ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS = new Set([
  'telephone',
  'mobile',
  'address',
  'email',
]);

// Officer feedback: editing a Minor's guardian details from the member
// page was never asked for — a guardian is only ever set by migration's
// own import or (once built) an application's own capture flow. Guardian
// fields are still read and shown here (the member page's read-only
// card, with the Member ID linking to the guardian's own page), just
// never accepted as a change.

export class ContactUpdateError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_found' | 'forbidden' | 'invalid' = 'invalid'
  ) {
    super(message);
    this.name = 'ContactUpdateError';
  }
}

function assertMayEdit(principal: Principal): void {
  if (!principal.permissions.has(PERMISSION_EDIT_CONTACT)) {
    throw new ContactUpdateError(
      'You do not have permission to edit contact details.',
      'forbidden'
    );
  }
}

export type EditableSubject = 'applicant' | 'employment' | 'guardian';

export interface EditableContactField {
  // Which application_party row this field lives on and saves to — the
  // applicant's own (every field the type configures), Employment
  // Details, or (Minor only) the guardian's.
  subject: EditableSubject;
  fieldKey: string;
  label: string;
  dataType: string;
  value: string;
  // Whether this specific field accepts an edit right now. Telephone,
  // Mobile, Address and Email are always editable; every other applicant
  // field only while still blank (see ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS);
  // Employment Details is always editable; a guardian field never is (see
  // the note above updateContactDetails) — still returned so the page can
  // show it, just always read-only.
  editable: boolean;
}

// Every applicant field this application's type configures, plus every
// Employment Details field, plus (Minor only) every guardian field — what
// the member/customer page renders, as an input where `editable` is true
// and as plain text otherwise. A type that configures none of these
// returns nothing to show, same as a type that never asked for a Nominee
// renders no Nominee section.
export async function editableContactFields(
  applicationId: string
): Promise<EditableContactField[]> {
  const application = await query<{ membership_type_id: string }>(
    `select membership_type_id from membership_application where id = $1`,
    [applicationId]
  );
  if (application.rowCount === 0) return [];

  const type = (await listMembershipTypes()).find(
    t => t.id === application.rows[0].membership_type_id
  );
  const applicantFields = (type?.fields ?? []).filter(
    f => f.subject === 'applicant' && f.isVisible
  );
  const employmentFields = (type?.fields ?? []).filter(
    f => f.subject === 'employment' && f.isVisible
  );
  const guardianFields = (type?.fields ?? []).filter(
    f => f.subject === 'guardian' && f.isVisible
  );
  if (
    applicantFields.length === 0 &&
    employmentFields.length === 0 &&
    guardianFields.length === 0
  ) {
    return [];
  }

  const parties = await query<{
    subject: EditableSubject;
    values: Record<string, string>;
  }>(
    `select subject, values from application_party
      where application_id = $1
        and subject in ('applicant', 'employment', 'guardian')
        and ordinal = 1`,
    [applicationId]
  );
  const valuesBySubject = new Map(parties.rows.map(p => [p.subject, p.values]));

  return [
    ...applicantFields.map(f => {
      const value = valuesBySubject.get('applicant')?.[f.fieldKey] ?? '';
      return {
        subject: 'applicant' as const,
        fieldKey: f.fieldKey,
        editable:
          ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS.has(f.fieldKey) || value === '',
        label: f.label,
        dataType: f.dataType,
        value,
      };
    }),
    ...employmentFields.map(f => ({
      subject: 'employment' as const,
      fieldKey: f.fieldKey,
      editable: true,
      label: f.label,
      dataType: f.dataType,
      value: valuesBySubject.get('employment')?.[f.fieldKey] ?? '',
    })),
    ...guardianFields.map(f => ({
      subject: 'guardian' as const,
      fieldKey: f.fieldKey,
      editable: false,
      label: f.label,
      dataType: f.dataType,
      value: valuesBySubject.get('guardian')?.[f.fieldKey] ?? '',
    })),
  ];
}

export interface ContactFieldChange {
  subject: EditableSubject;
  fieldKey: string;
  value: string;
}

/**
 * Save straight onto the applicant, Employment Details and/or guardian
 * party — no draft, no submission, no approval. Only the fields that
 * actually changed are written (jsonb || jsonb), so this can never disturb
 * a field the officer did not touch. The applicant party always exists
 * (every application has one); Employment Details and guardian do not — a
 * migrated record in particular has no application_party row for either
 * until its first edit here, which this creates rather than requiring
 * pre-created.
 *
 * A guardian field is never accepted here — editableContactFields already
 * marks every one of them read-only, and any change of subject 'guardian'
 * that reaches this function anyway (a direct API call, not the page) is
 * silently dropped rather than saved.
 */
export async function updateContactDetails(
  applicationId: string,
  changes: ContactFieldChange[],
  entity: { entityType: 'member' | 'customer'; entityId: string },
  principal: Principal
): Promise<{ updated: string[] }> {
  assertMayEdit(principal);

  return withTransaction(async client => {
    const bySubject = new Map<EditableSubject, ContactFieldChange[]>();
    for (const change of changes) {
      if (change.subject === 'guardian') continue;
      const list = bySubject.get(change.subject) ?? [];
      list.push(change);
      bySubject.set(change.subject, list);
    }

    const updated: string[] = [];
    const previousValue: Record<string, string> = {};
    const newValue: Record<string, string> = {};

    for (const [subject, subjectChanges] of bySubject) {
      const current = await client.query<{ values: Record<string, string> }>(
        `select values from application_party
          where application_id = $1 and subject = $2 and ordinal = 1
          for no key update`,
        [applicationId, subject]
      );
      const before = current.rows[0]?.values ?? null;
      if (before === null && subject === 'applicant') {
        throw new ContactUpdateError(
          'This record has no applicant details to edit.',
          'not_found'
        );
      }

      const patch: Record<string, string> = {};
      for (const { fieldKey, value: raw } of subjectChanges) {
        // Mirrors editableContactFields's own editable rule: once an
        // applicant field outside the always-editable set carries a
        // value, it is locked — this is the server-side half of that,
        // not just the page hiding the input.
        if (
          subject === 'applicant' &&
          !ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS.has(fieldKey) &&
          (before ?? {})[fieldKey]
        ) {
          continue;
        }
        let value = raw.trim();
        if (PHONE_FIELD_KEYS.has(fieldKey) && value !== '') {
          try {
            value = toInternational(value);
          } catch (error) {
            if (error instanceof PhoneFormatError) {
              throw new ContactUpdateError(
                `${fieldKey === 'mobile' ? 'Mobile' : 'Telephone'}: ${error.message}`,
                'invalid'
              );
            }
            throw error;
          }
        }
        if (value === ((before ?? {})[fieldKey] ?? '')) continue;
        patch[fieldKey] = value;
      }

      if (Object.keys(patch).length === 0) continue;

      await client.query(
        `insert into application_party (application_id, subject, ordinal, values)
         values ($1, $2, 1, $3::jsonb)
         on conflict (application_id, subject, ordinal)
         do update set values = application_party.values || excluded.values`,
        [applicationId, subject, JSON.stringify(patch)]
      );

      for (const key of Object.keys(patch)) {
        updated.push(key);
        previousValue[key] = (before ?? {})[key] ?? '';
        newValue[key] = patch[key];
      }
    }

    if (updated.length === 0) {
      return { updated: [] };
    }

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_UPDATED,
        entityType: entity.entityType,
        entityId: entity.entityId,
        previousValue,
        newValue,
      },
      client
    );

    return { updated };
  });
}
