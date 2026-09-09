// Officer feedback: a regional officer corrects a phone number or address at
// the counter — a member reads it out, or a letter comes back undelivered —
// and the person is standing right there. member_details_request
// (details-requests.ts) exists for the opposite case: a change the member
// themselves sent in from the app, unattended, which is why it goes through
// member.details_verify before it lands. Neither reason applies here, so
// this writes straight to application_party and skips that queue entirely
// (migration 0045, widened for Mobile and Employment Details on officer
// feedback).
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { toInternational, PhoneFormatError } from '../applications/phone';
import { listMembershipTypes } from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_EDIT_CONTACT = 'member.edit_contact';
const ACTION_UPDATED = 'member.contact.updated';

// Only what officer feedback asked for, on the applicant party — Telephone,
// Mobile and Address. Widening this to every applicant field would reopen
// the review workflow member.details_verify exists for; this path is
// deliberately narrower, and saves straight through. Employment is a
// separate party row (subject = 'employment'), never subject to that same
// review workflow to begin with — every field a type configures for it is
// editable here, not a fixed subset (see editableContactFields).
const EDITABLE_APPLICANT_FIELD_KEYS = new Set([
  'telephone',
  'mobile',
  'address',
]);
const PHONE_FIELD_KEYS = new Set(['telephone', 'mobile']);

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

export interface EditableContactField {
  // Which application_party row this field lives on and saves to — the
  // applicant's own (Telephone, Mobile, Address) or Employment Details,
  // its own row.
  subject: 'applicant' | 'employment';
  fieldKey: string;
  label: string;
  dataType: string;
  value: string;
}

// The applicant's Telephone/Mobile/Address fields this application's type
// actually configures, plus every Employment Details field it configures —
// what the member/customer page renders as inputs. A type that configures
// none of either returns nothing to edit, same as a type that never asked
// for a Nominee renders no Nominee section.
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
    f =>
      f.subject === 'applicant' &&
      f.isVisible &&
      EDITABLE_APPLICANT_FIELD_KEYS.has(f.fieldKey)
  );
  const employmentFields = (type?.fields ?? []).filter(
    f => f.subject === 'employment' && f.isVisible
  );
  if (applicantFields.length === 0 && employmentFields.length === 0) {
    return [];
  }

  const parties = await query<{
    subject: 'applicant' | 'employment';
    values: Record<string, string>;
  }>(
    `select subject, values from application_party
      where application_id = $1 and subject in ('applicant', 'employment')
        and ordinal = 1`,
    [applicationId]
  );
  const valuesBySubject = new Map(parties.rows.map(p => [p.subject, p.values]));

  return [
    ...applicantFields.map(f => ({
      subject: 'applicant' as const,
      fieldKey: f.fieldKey,
      label: f.label,
      dataType: f.dataType,
      value: valuesBySubject.get('applicant')?.[f.fieldKey] ?? '',
    })),
    ...employmentFields.map(f => ({
      subject: 'employment' as const,
      fieldKey: f.fieldKey,
      label: f.label,
      dataType: f.dataType,
      value: valuesBySubject.get('employment')?.[f.fieldKey] ?? '',
    })),
  ];
}

export interface ContactFieldChange {
  subject: 'applicant' | 'employment';
  fieldKey: string;
  value: string;
}

/**
 * Save straight onto the applicant and/or Employment Details party — no
 * draft, no submission, no approval. Only the fields that actually changed
 * are written (jsonb || jsonb), so this can never disturb a field the
 * officer did not touch. The applicant party always exists (every
 * application has one); Employment Details does not — a migrated record in
 * particular has no application_party row for it at all until its first
 * edit here, which this creates rather than requiring pre-created.
 */
export async function updateContactDetails(
  applicationId: string,
  changes: ContactFieldChange[],
  entity: { entityType: 'member' | 'customer'; entityId: string },
  principal: Principal
): Promise<{ updated: string[] }> {
  assertMayEdit(principal);

  return withTransaction(async client => {
    const bySubject = new Map<
      'applicant' | 'employment',
      ContactFieldChange[]
    >();
    for (const change of changes) {
      const list = bySubject.get(change.subject) ?? [];
      list.push(change);
      bySubject.set(change.subject, list);
    }

    const updated: string[] = [];
    const previousValue: Record<string, string> = {};
    const newValue: Record<string, string> = {};

    for (const [subject, subjectChanges] of bySubject) {
      const allowedKeys =
        subject === 'applicant' ? EDITABLE_APPLICANT_FIELD_KEYS : null;

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
        if (allowedKeys && !allowedKeys.has(fieldKey)) continue;
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
