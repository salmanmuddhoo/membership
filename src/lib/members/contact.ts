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
// Officer feedback, second round: every applicant field is now editable
// here, not a fixed Telephone/Mobile/Address subset — the same edit
// affordance is how a field migration left blank (an optional one the
// legacy register never carried) gets filled in later, so narrowing it
// would leave those permanently stuck. member.details_verify's own review
// workflow is for what a member submits unattended from the app; it was
// never actually reopened by widening what an officer standing at the
// counter can correct on the spot.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { findGuardian } from '../applications/capture';
import { toInternational, PhoneFormatError } from '../applications/phone';
import { listMembershipTypes } from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_EDIT_CONTACT = 'member.edit_contact';
const ACTION_UPDATED = 'member.contact.updated';

const PHONE_FIELD_KEYS = new Set(['telephone', 'mobile']);

// A Minor's guardian (Minor only — every other type configures no
// 'guardian' subject). Only the Member ID and the relationship are
// editable here: surname, name, NIC and mobile always mirror the
// guardian's own record (the same auto-fill migration/members.ts's own
// import gives it) and are recomputed whenever the Member ID changes, not
// independently correctable — a stale copy next to the guardian's own
// record editable elsewhere would just be a second place for the same
// fact to go wrong. Relationship has no such source and is exactly the
// field a migrated Minor is most likely to still be missing.
const EDITABLE_GUARDIAN_FIELD_KEYS = new Set(['member_id', 'relationship']);
// The guardian fields that mirror the guardian's own applicant record —
// recomputed, never taken from what was typed, whenever member_id changes.
const GUARDIAN_MIRRORED_FIELD_KEYS = ['surname', 'name', 'nic', 'mobile'];

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
  // Whether this specific field accepts an edit — true for every applicant
  // and Employment Details field, but only Member ID and relationship on a
  // guardian (see EDITABLE_GUARDIAN_FIELD_KEYS). Every OTHER guardian field
  // (surname, name, NIC, mobile) is still returned, read-only, so the page
  // can show — and, after a save elsewhere on the same request, refresh —
  // what the resolved guardian's own record says, without a second round
  // trip: it is not independently correctable here, only a mirror of it.
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
    ...applicantFields.map(f => ({
      subject: 'applicant' as const,
      fieldKey: f.fieldKey,
      editable: true,
      label: f.label,
      dataType: f.dataType,
      value: valuesBySubject.get('applicant')?.[f.fieldKey] ?? '',
    })),
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
      editable: EDITABLE_GUARDIAN_FIELD_KEYS.has(f.fieldKey),
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
 * A guardian's Member ID has to resolve the same way migration's own
 * import and problemsBlockingSubmission's own S-604 relaxation both do
 * (findGuardian) before it is accepted; once it does, surname, name, NIC
 * and mobile are recomputed from the guardian's own record in the same
 * write, never left to whatever was typed for them (they are not
 * independently editable — see EDITABLE_GUARDIAN_FIELD_KEYS).
 */
export async function updateContactDetails(
  applicationId: string,
  changes: ContactFieldChange[],
  entity: { entityType: 'member' | 'customer'; entityId: string },
  principal: Principal
): Promise<{ updated: string[] }> {
  assertMayEdit(principal);

  // Resolved before the transaction opens, not from inside it: findGuardian
  // runs against the pool (query(), not a client passed through), and a
  // second pool checkout while withTransaction's own is still held is
  // exactly the deadlock a small pool hits — the same reason
  // migration/members.ts's own allocateReceiptNumber/migrationFeeVersionId
  // are read fresh before its transaction opens. Whether this change is
  // even a real one (not identical to what is already on file) is not yet
  // known here, so an unnecessary resolve is the cost of avoiding the
  // deadlock, not a correctness issue — the write below still checks.
  const guardianMemberIdChange = changes.find(
    c => c.subject === 'guardian' && c.fieldKey === 'member_id'
  );
  let resolvedGuardian: Awaited<ReturnType<typeof findGuardian>> = null;
  if (guardianMemberIdChange) {
    const candidate = guardianMemberIdChange.value.trim();
    if (candidate === '') {
      throw new ContactUpdateError(
        'Guardian Member ID is required.',
        'invalid'
      );
    }
    resolvedGuardian = await findGuardian(candidate, '');
    if (!resolvedGuardian) {
      throw new ContactUpdateError(
        `Guardian Member ID "${candidate}" does not match any member or ` +
          'in-progress application on file.',
        'invalid'
      );
    }
    if (resolvedGuardian.isMember && resolvedGuardian.status !== 'active') {
      throw new ContactUpdateError(
        `The guardian (${resolvedGuardian.memberNo}) is not an active member.`,
        'invalid'
      );
    }
  }

  return withTransaction(async client => {
    const bySubject = new Map<EditableSubject, ContactFieldChange[]>();
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
        subject === 'guardian' ? EDITABLE_GUARDIAN_FIELD_KEYS : null;

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

      if (subject === 'guardian' && 'member_id' in patch && resolvedGuardian) {
        // The canonical casing (AB1610, not ab1610), and every mirrored
        // field recomputed from the newly-resolved guardian's own record —
        // whatever the previous guardian's values were, they do not carry
        // over to a different person.
        patch.member_id = resolvedGuardian.memberNo;
        for (const key of GUARDIAN_MIRRORED_FIELD_KEYS) {
          patch[key] = resolvedGuardian.applicantValues[key] ?? '';
        }
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
        // A mirrored field's own before-value is folded into the same
        // "member_id changed" story rather than reported as its own —
        // otherwise every Member ID correction would also claim to have
        // changed the guardian's surname, name, NIC and mobile even when
        // the officer only touched one field.
        if (
          subject === 'guardian' &&
          GUARDIAN_MIRRORED_FIELD_KEYS.includes(key)
        )
          continue;
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
