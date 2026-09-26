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
import { findNicHolder, normalise } from '../applications/capture';
import { toInternational, PhoneFormatError } from '../applications/phone';
import {
  listMembershipTypes,
  type MembershipTypeField,
} from '../config/reference';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_EDIT_CONTACT = 'member.edit_contact';
// Officer request: a role that may correct ANY detail of a member or
// non-member — name, NIC, date of birth, everything the locking rule above
// keeps closed once filled in. The fields are still checked the way capture
// checks them (required, choices, dates, phone format, an NIC nobody else
// holds), and the change is audited as a correction, before and after.
export const PERMISSION_EDIT_ALL_DETAILS = 'member.edit_all_details';
const ACTION_UPDATED = 'member.contact.updated';
const ACTION_CORRECTED = 'member.details.corrected';

export function mayEditAllDetails(principal: Principal): boolean {
  return principal.permissions.has(PERMISSION_EDIT_ALL_DETAILS);
}

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
  if (
    !principal.permissions.has(PERMISSION_EDIT_CONTACT) &&
    !mayEditAllDetails(principal)
  ) {
    throw new ContactUpdateError(
      'You do not have permission to edit contact details.',
      'forbidden'
    );
  }
}

export type EditableSubject =
  'applicant' | 'employment' | 'guardian' | 'nominee';

export interface EditableContactField {
  // Which application_party row this field lives on and saves to — the
  // applicant's own (every field the type configures), Employment
  // Details, or (Minor only) the guardian's.
  subject: EditableSubject;
  // Which one of the subject: always 1 but for a nominee, of whom a type
  // may ask for several.
  ordinal: number;
  fieldKey: string;
  label: string;
  dataType: string;
  // The configured choices for a 'choice' field (Marital status, Employment
  // status…) — empty for every other dataType. Lets the page render a
  // dropdown instead of a text input without a second lookup.
  choices: string[];
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
  applicationId: string,
  // With member.edit_all_details every applicant field is open, filled in
  // or not.
  options: { allDetails?: boolean } = {}
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
  // Officer request: member.edit_all_details corrects the nominees too.
  // Without it they are not offered here at all — the page shows them in
  // their own card, read-only.
  const nomineeFields = options.allDetails
    ? (type?.fields ?? []).filter(f => f.subject === 'nominee' && f.isVisible)
    : [];
  if (
    applicantFields.length === 0 &&
    employmentFields.length === 0 &&
    guardianFields.length === 0 &&
    nomineeFields.length === 0
  ) {
    return [];
  }

  const parties = await query<{
    subject: EditableSubject;
    ordinal: number;
    values: Record<string, string>;
  }>(
    `select subject, ordinal, values from application_party
      where application_id = $1
        and (subject in ('applicant', 'employment', 'guardian')
               and ordinal = 1
             or subject = 'nominee')
      order by subject, ordinal`,
    [applicationId]
  );
  const valuesBySubject = new Map(
    parties.rows
      .filter(p => p.subject !== 'nominee')
      .map(p => [p.subject, p.values])
  );
  // Every nominee on file, or the first one's empty slot when none is yet.
  const nominees = parties.rows.filter(p => p.subject === 'nominee');
  const nomineeRows =
    nomineeFields.length === 0
      ? []
      : nominees.length > 0
        ? nominees
        : [{ ordinal: 1, values: {} as Record<string, string> }];

  return [
    ...applicantFields.map(f => {
      const value = valuesBySubject.get('applicant')?.[f.fieldKey] ?? '';
      return {
        subject: 'applicant' as const,
        ordinal: 1,
        fieldKey: f.fieldKey,
        editable:
          options.allDetails === true ||
          ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS.has(f.fieldKey) ||
          value === '',
        label: f.label,
        dataType: f.dataType,
        choices: f.choices,
        value,
      };
    }),
    ...employmentFields.map(f => ({
      subject: 'employment' as const,
      ordinal: 1,
      fieldKey: f.fieldKey,
      editable: true,
      label: f.label,
      dataType: f.dataType,
      choices: f.choices,
      value: valuesBySubject.get('employment')?.[f.fieldKey] ?? '',
    })),
    ...guardianFields.map(f => ({
      subject: 'guardian' as const,
      ordinal: 1,
      fieldKey: f.fieldKey,
      editable: false,
      label: f.label,
      dataType: f.dataType,
      choices: f.choices,
      value: valuesBySubject.get('guardian')?.[f.fieldKey] ?? '',
    })),
    ...nomineeRows.flatMap(row =>
      nomineeFields.map(f => ({
        subject: 'nominee' as const,
        ordinal: row.ordinal,
        fieldKey: f.fieldKey,
        editable: true,
        label: f.label,
        dataType: f.dataType,
        choices: f.choices,
        value: row.values[f.fieldKey] ?? '',
      }))
    ),
  ];
}

interface CorrectableFields {
  applicant: Map<string, MembershipTypeField>;
  nominee: Map<string, MembershipTypeField>;
  nomineeCount: number;
}

// The applicant and nominee fields this application's type configures, by
// key — what a correction is checked against — and how many nominees it
// asks for at most.
async function correctableFieldsOf(
  applicationId: string
): Promise<CorrectableFields> {
  const application = await query<{ membership_type_id: string }>(
    `select membership_type_id from membership_application where id = $1`,
    [applicationId]
  );
  const type = (await listMembershipTypes()).find(
    t => t.id === application.rows[0]?.membership_type_id
  );
  const bySubject = (subject: string) =>
    new Map(
      (type?.fields ?? [])
        .filter(f => f.subject === subject && f.isVisible)
        .map(f => [f.fieldKey, f])
    );
  return {
    applicant: bySubject('applicant'),
    nominee: bySubject('nominee'),
    nomineeCount: type?.nomineeCount ?? 0,
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// One corrected value, checked the way capture checks it: not emptied if
// required, a configured choice, a real date not in the future, a phone
// number that can be placed — and, for the applicant, an NIC nobody else
// holds. A nominee's NIC is anyone's: a member names a relative who may
// well be a member too. Only the first nominee's required fields are
// required, as at capture; a second or third is optional throughout.
async function checkedValue(
  field: MembershipTypeField,
  raw: string,
  applicationId: string,
  entity: ContactEntity,
  client: PoolClient,
  party: { subject: 'applicant' | 'nominee'; ordinal: number }
): Promise<string> {
  if (raw === '') {
    if (field.isMandatory && party.ordinal === 1) {
      throw new ContactUpdateError(`${field.label} is required.`);
    }
    return '';
  }
  const { values, errors } = normalise({ [field.fieldKey]: raw }, [field]);
  if (errors.length > 0) throw new ContactUpdateError(errors[0].label);
  const value = values[field.fieldKey] ?? raw;

  if (field.dataType === 'date') {
    const match = ISO_DATE.exec(value);
    const date = match
      ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
      : null;
    if (
      !match ||
      !date ||
      date.getUTCDate() !== +match[3] ||
      date.getUTCMonth() !== +match[2] - 1 ||
      date.getTime() > Date.now()
    ) {
      throw new ContactUpdateError(`${field.label} is not a possible date.`);
    }
  }

  if (party.subject === 'applicant' && field.fieldKey === 'nic') {
    // Checked as a new application's NIC is: someone else — a member, a
    // non-member, an application in progress — already holding it. This
    // person's own records are theirs, not a clash.
    const holder = await findNicHolder(
      value,
      applicationId,
      entity.entityType === 'customer' ? entity.entityId : null,
      entity.entityType === 'member' ? entity.entityId : null,
      client
    );
    if (holder) {
      const who =
        holder.kind === 'member'
          ? `member ${holder.reference}`
          : holder.kind === 'customer'
            ? holder.reference
              ? `non-member ${holder.reference}`
              : 'another non-member'
            : `application ${holder.reference}`;
      throw new ContactUpdateError(`This NIC is already on file for ${who}.`);
    }
  }
  return value;
}

export interface ContactEntity {
  entityType: 'member' | 'customer';
  entityId: string;
}

export interface ContactFieldChange {
  subject: EditableSubject;
  // Which nominee; 1, and ignored, for every other subject.
  ordinal?: number;
  fieldKey: string;
  value: string;
}

// How a change is named in what is returned and on the audit trail: the
// field's key, or for a nominee which one it was.
function changeKey(subject: EditableSubject, ordinal: number, key: string) {
  return subject === 'nominee' ? `nominee.${ordinal}.${key}` : key;
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
  entity: ContactEntity,
  principal: Principal
): Promise<{ updated: string[] }> {
  assertMayEdit(principal);
  const allDetails = mayEditAllDetails(principal);
  const fields: CorrectableFields = allDetails
    ? await correctableFieldsOf(applicationId)
    : { applicant: new Map(), nominee: new Map(), nomineeCount: 0 };
  const applicantFields = fields.applicant;

  return withTransaction(async client => {
    // By party: the subject, and for a nominee which one.
    const byParty = new Map<
      string,
      {
        subject: EditableSubject;
        ordinal: number;
        changes: ContactFieldChange[];
      }
    >();
    for (const change of changes) {
      if (change.subject === 'guardian') continue;
      // A nominee only with member.edit_all_details, and only one of those
      // the type asks for.
      let ordinal = 1;
      if (change.subject === 'nominee') {
        ordinal = Number(change.ordinal ?? 1);
        if (
          !allDetails ||
          !Number.isInteger(ordinal) ||
          ordinal < 1 ||
          ordinal > fields.nomineeCount
        ) {
          continue;
        }
      }
      const key = `${change.subject}:${ordinal}`;
      const party = byParty.get(key) ?? {
        subject: change.subject,
        ordinal,
        changes: [],
      };
      party.changes.push(change);
      byParty.set(key, party);
    }

    const updated: string[] = [];
    const previousValue: Record<string, string> = {};
    const newValue: Record<string, string> = {};
    let nomineesChanged = false;

    for (const {
      subject,
      ordinal,
      changes: subjectChanges,
    } of byParty.values()) {
      const current = await client.query<{ values: Record<string, string> }>(
        `select values from application_party
          where application_id = $1 and subject = $2 and ordinal = $3
          for no key update`,
        [applicationId, subject, ordinal]
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
          !allDetails &&
          subject === 'applicant' &&
          !ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS.has(fieldKey) &&
          (before ?? {})[fieldKey]
        ) {
          continue;
        }
        let value = raw.trim();
        if (allDetails && (subject === 'applicant' || subject === 'nominee')) {
          const field = fields[subject].get(fieldKey);
          if (!field) continue;
          value = await checkedValue(
            field,
            value,
            applicationId,
            entity,
            client,
            { subject, ordinal }
          );
        }
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
         values ($1, $2, $3, $4::jsonb)
         on conflict (application_id, subject, ordinal)
         do update set values = application_party.values || excluded.values`,
        [applicationId, subject, ordinal, JSON.stringify(patch)]
      );
      if (subject === 'nominee') nomineesChanged = true;

      for (const key of Object.keys(patch)) {
        const named = changeKey(subject, ordinal, key);
        updated.push(named);
        previousValue[named] = (before ?? {})[key] ?? '';
        newValue[named] = patch[key];
      }
    }

    if (updated.length === 0) {
      return { updated: [] };
    }

    // S-602, as at capture: where the type divides the membership between
    // nominees by a required percentage, the split still has to come to
    // 100% once every nominee has one. Checked after the writes, inside the
    // transaction, so a refusal leaves nothing saved.
    if (nomineesChanged && fields.nominee.get('percentage')?.isMandatory) {
      const split = await client.query<{ percentage: string | null }>(
        `select values->>'percentage' as percentage from application_party
          where application_id = $1 and subject = 'nominee'`,
        [applicationId]
      );
      const entered = split.rows.map(r => (r.percentage ?? '').trim());
      if (entered.length > 0 && entered.every(v => v !== '')) {
        const total = entered.reduce((sum, v) => sum + Number(v), 0);
        if (Math.round(total * 100) / 100 !== 100) {
          throw new ContactUpdateError(
            `Nominee percentages must add up to 100% (currently ${total}%).`
          );
        }
      }
    }

    // A field the counter edit could not have changed (a filled-in name,
    // NIC, a nominee's details…) is recorded as a correction, so it stands
    // out on the trail.
    const corrected = Object.keys(newValue).some(
      key =>
        previousValue[key] !== '' &&
        (key.startsWith('nominee.') ||
          (applicantFields.has(key) &&
            !ALWAYS_EDITABLE_APPLICANT_FIELD_KEYS.has(key)))
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: corrected ? ACTION_CORRECTED : ACTION_UPDATED,
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
