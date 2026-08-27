// Capturing a membership application (S-301, S-302, S-303).
//
// The form is not written down anywhere in this file. Which fields appear,
// which are mandatory and which subjects exist all come from the membership
// type configuration of M2 (S-205) — so adding a field to the Corporate form
// is a configuration change, and this code does not need to know it happened.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';
import {
  listMembershipTypes,
  type FieldSubject,
  type MembershipType,
  type MembershipTypeField,
} from '../config/reference';
import { discardApplicationFiles } from '../documents/documents';
import type { Principal } from '../access/principal';
import { toInternational, PhoneFormatError } from './phone';

export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'invalid' | 'locked' | 'forbidden' = 'invalid'
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export interface Actor {
  userId: string;
  email: string;
}

export const DRAFT_STATUS = 'draft';

// Which statuses regional staff may still edit. Anything else has left their
// hands (S-304).
const EDITABLE_STATUSES = new Set([DRAFT_STATUS, 'returned']);

export interface PartyValues {
  subject: FieldSubject;
  ordinal: number;
  values: Record<string, string>;
}

export interface Application {
  id: string;
  reference: string;
  membershipTypeId: string;
  membershipTypeCode: string;
  membershipTypeName: string;
  status: string;
  capturedBy: string;
  // Both, deliberately: the screen shows the name, because that is how a
  // colleague is known; the audit trail records the address, because that is
  // what identifies the account beyond doubt.
  capturedByName: string;
  capturedByEmail: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
  updatedAt: Date;
  parties: PartyValues[];
}

// A field that must be filled in but is not, named the way the form names it.
export interface MissingField {
  subject: FieldSubject;
  ordinal: number;
  fieldKey: string;
  label: string;
}

export async function startApplication(
  membershipTypeCode: string,
  actor: Actor
): Promise<{ id: string; reference: string }> {
  const type = (await listMembershipTypes()).find(
    t => t.code === membershipTypeCode
  );
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }
  if (!type.isActive) {
    throw new ApplicationError(
      `${type.name} applications are not currently accepted.`
    );
  }

  return withTransaction(async client => {
    const created = await client.query<{ id: string; reference: string }>(
      `insert into membership_application (membership_type_id, captured_by)
       values ($1, $2) returning id, reference`,
      [type.id, actor.userId]
    );
    const { id, reference } = created.rows[0];

    // One empty party per subject the type configures, so the form has
    // something to render into and a draft save has somewhere to land.
    const subjects = [...new Set(type.fields.map(f => f.subject))];
    for (const subject of subjects) {
      await client.query(
        `insert into application_party (application_id, subject, ordinal)
         values ($1, $2, 1)`,
        [id, subject]
      );
    }

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.started',
        entityType: 'membership_application',
        entityId: id,
        newValue: { reference, membershipType: type.code },
      },
      client
    );

    return { id, reference };
  });
}

export async function loadApplication(id: string): Promise<Application | null> {
  const result = await query<{
    id: string;
    reference: string;
    membership_type_id: string;
    membership_type_code: string;
    membership_type_name: string;
    status: string;
    captured_by: string;
    captured_by_name: string;
    captured_by_email: string;
    submitted_at: Date | null;
    decided_at: Date | null;
    updated_at: Date;
  }>(
    `select a.id, a.reference, a.membership_type_id,
            m.code as membership_type_code, m.name as membership_type_name,
            a.status, a.captured_by,
            u.display_name as captured_by_name,
            u.email::text as captured_by_email,
            a.submitted_at, a.decided_at, a.updated_at
       from membership_application a
       join membership_type m on m.id = a.membership_type_id
       join app_user u        on u.id = a.captured_by
      where a.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];

  const parties = await query<{
    subject: FieldSubject;
    ordinal: number;
    values: Record<string, string>;
  }>(
    `select subject, ordinal, values
       from application_party
      where application_id = $1
      order by subject, ordinal`,
    [id]
  );

  return {
    id: row.id,
    reference: row.reference,
    membershipTypeId: row.membership_type_id,
    membershipTypeCode: row.membership_type_code,
    membershipTypeName: row.membership_type_name,
    status: row.status,
    capturedBy: row.captured_by,
    capturedByName: row.captured_by_name,
    capturedByEmail: row.captured_by_email,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at,
    parties: parties.rows.map(p => ({
      subject: p.subject,
      ordinal: p.ordinal,
      values: p.values,
    })),
  };
}

// The fields this application's type configures, grouped as the form shows
// them. Hidden fields are dropped: a field an administrator has switched off
// is not part of this form.
export function visibleFields(
  type: MembershipType
): Map<FieldSubject, MembershipTypeField[]> {
  const bySubject = new Map<FieldSubject, MembershipTypeField[]>();
  for (const field of type.fields) {
    if (!field.isVisible) continue;
    const list = bySubject.get(field.subject) ?? [];
    list.push(field);
    bySubject.set(field.subject, list);
  }
  for (const list of bySubject.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return bySubject;
}

/**
 * Normalise what was typed into what is stored.
 *
 * Phone fields become E.164 here rather than at display time, because the
 * stored value is the one M9 will send to. A number that cannot be placed
 * fails the save — see phone.ts for why guessing is worse.
 */
function normalise(
  values: Record<string, string>,
  fields: MembershipTypeField[]
): { values: Record<string, string>; errors: MissingField[] } {
  const out: Record<string, string> = {};
  const errors: MissingField[] = [];

  for (const field of fields) {
    const raw = (values[field.fieldKey] ?? '').trim();
    if (raw === '') continue;

    if (field.dataType === 'phone') {
      try {
        out[field.fieldKey] = toInternational(raw);
      } catch (error) {
        if (error instanceof PhoneFormatError) {
          errors.push({
            subject: field.subject,
            ordinal: 1,
            fieldKey: field.fieldKey,
            label: `${field.label}: ${error.message}`,
          });
          // Keep what was typed so the officer sees their own input to fix,
          // rather than an empty box and no idea what they entered.
          out[field.fieldKey] = raw;
          continue;
        }
        throw error;
      }
    } else if (field.dataType === 'choice') {
      if (field.choices.length > 0 && !field.choices.includes(raw)) {
        errors.push({
          subject: field.subject,
          ordinal: 1,
          fieldKey: field.fieldKey,
          label: `${field.label} must be one of: ${field.choices.join(', ')}`,
        });
      }
      out[field.fieldKey] = raw;
    } else {
      out[field.fieldKey] = raw;
    }
  }

  return { values: out, errors };
}

/**
 * Save a draft (S-302).
 *
 * Partial by design: an officer on a tablet is interrupted mid-form, and the
 * point of saving continuously is that whatever has been typed survives. So
 * mandatory fields are NOT enforced here — that check belongs at submission
 * (S-304), where the application leaves their hands. Format errors are
 * reported but do not block the save, for the same reason.
 */
export async function saveDraft(
  applicationId: string,
  parties: PartyValues[],
  actor: Actor
): Promise<{ savedAt: Date; problems: MissingField[] }> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }
  if (!EDITABLE_STATUSES.has(application.status)) {
    throw new ApplicationError(
      `This application has been submitted and can no longer be edited ` +
        `(status: ${application.status}).`,
      'locked'
    );
  }

  const type = (await listMembershipTypes()).find(
    t => t.id === application.membershipTypeId
  );
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }
  const fields = visibleFields(type);

  const problems: MissingField[] = [];

  const savedAt = await withTransaction(async client => {
    for (const party of parties) {
      const subjectFields = fields.get(party.subject) ?? [];
      const { values, errors } = normalise(party.values, subjectFields);
      problems.push(...errors.map(e => ({ ...e, ordinal: party.ordinal })));

      await client.query(
        `insert into application_party (application_id, subject, ordinal, values)
         values ($1, $2, $3, $4)
         on conflict (application_id, subject, ordinal)
         do update set values = excluded.values`,
        [applicationId, party.subject, party.ordinal, JSON.stringify(values)]
      );
    }

    const touched = await client.query<{ updated_at: Date }>(
      `update membership_application set updated_at = now()
        where id = $1 returning updated_at`,
      [applicationId]
    );
    return touched.rows[0].updated_at;
  });

  return { savedAt, problems };
}

/**
 * What stops this application being submitted (S-301, S-304).
 *
 * Returns every problem, not the first: an officer told about one missing
 * field at a time, on a form of forty, will fill it in and be told about the
 * next one. Nothing is submitted while this is non-empty.
 */
export async function problemsBlockingSubmission(
  application: Application
): Promise<MissingField[]> {
  const type = (await listMembershipTypes()).find(
    t => t.id === application.membershipTypeId
  );
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }

  const fields = visibleFields(type);
  const problems: MissingField[] = [];

  for (const [subject, subjectFields] of fields) {
    const parties = application.parties.filter(p => p.subject === subject);
    // A subject the type configures but the application has no row for is
    // itself the problem: every mandatory field on it is missing.
    const rows =
      parties.length > 0 ? parties : [{ subject, ordinal: 1, values: {} }];

    for (const party of rows) {
      for (const field of subjectFields) {
        if (!field.isMandatory) continue;
        const value = (party.values[field.fieldKey] ?? '').trim();
        if (value === '') {
          problems.push({
            subject,
            ordinal: party.ordinal,
            fieldKey: field.fieldKey,
            label: field.label,
          });
        }
      }
    }
  }

  return problems;
}

/**
 * Delete a draft the officer no longer needs.
 *
 * Only a draft, and only the officer's own. A draft is the one state where
 * deleting loses nothing: it has never been submitted, so no one else has read
 * it, no one has reviewed or decided it, and there is no member behind it. A
 * `returned` application looks editable for the same reason a draft does, but
 * it has been through central processing and carries that history — it is
 * corrected and resubmitted, never deleted.
 *
 * The row is deleted rather than flagged, because a draft that was started by
 * mistake is not history worth keeping and holding an applicant's details
 * indefinitely for a form nobody submitted is not something to do by default.
 * What remains is the audit entry below.
 */
export async function deleteDraftApplication(
  applicationId: string,
  principal: Principal,
  discardFiles: (reference: string) => Promise<void> = discardApplicationFiles
): Promise<{ reference: string }> {
  if (!principal.permissions.has('application.capture')) {
    throw new ApplicationError(
      'You do not have permission to delete applications.',
      'forbidden'
    );
  }

  return withTransaction(async client => {
    // Re-read under a lock. Without it, a delete and a submit racing on the
    // same draft could both read `draft` and both proceed, and the submitted
    // application would vanish from under central processing.
    const locked = await client.query<{
      reference: string;
      status: string;
      captured_by: string;
      created_at: Date;
      membership_type_code: string;
    }>(
      `select a.reference, a.status, a.captured_by, a.created_at,
              m.code as membership_type_code
         from membership_application a
         join membership_type m on m.id = a.membership_type_id
        where a.id = $1
          for no key update of a`,
      [applicationId]
    );
    if (locked.rowCount === 0) {
      throw new ApplicationError(
        'That application no longer exists.',
        'not_found'
      );
    }
    const row = locked.rows[0];

    if (row.status !== DRAFT_STATUS) {
      throw new ApplicationError(
        'Only a draft can be deleted. This application has already been ' +
          `submitted (status: ${row.status}), so it has a history that has to ` +
          'be kept.',
        'locked'
      );
    }
    if (row.captured_by !== principal.userId) {
      throw new ApplicationError(
        'This draft belongs to another member of staff. Only the person ' +
          'capturing it can delete it.',
        'forbidden'
      );
    }

    // Belt and braces against a status that arrived some other way: anything
    // with a transition behind it has been acted on by someone.
    const acted = await client.query<{ n: number }>(
      `select count(*)::int as n from application_transition
        where application_id = $1`,
      [applicationId]
    );
    if (acted.rows[0].n > 0) {
      throw new ApplicationError(
        'This application has already been acted on and cannot be deleted.',
        'locked'
      );
    }

    const filed = await client.query<{ n: number }>(
      `select count(*)::int as n
         from document_version v
         join document d on d.id = v.document_id
        where d.application_id = $1`,
      [applicationId]
    );

    // The row is about to go, so this entry is the whole record of it. It
    // deliberately does not copy what was captured: the point of deleting an
    // abandoned draft is not to keep an applicant's details, and the audit log
    // cannot be edited afterwards.
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'membership.application.deleted',
        entityType: 'membership_application',
        entityId: applicationId,
        previousValue: {
          reference: row.reference,
          membershipType: row.membership_type_code,
          status: row.status,
          startedAt: row.created_at,
          documentsDiscarded: filed.rows[0].n,
        },
      },
      client
    );

    await client.query('delete from membership_application where id = $1', [
      applicationId,
    ]);

    // Inside the transaction, deliberately. The parties, transitions and
    // document rows cascade away here; the files in SharePoint do not, and a
    // failure to remove them has to take the deletion down with it rather than
    // leave scans behind that nothing accounts for. Skipped entirely when
    // nothing was ever uploaded, which is the usual case for an abandoned
    // draft — and means deleting one does not depend on Graph being reachable.
    if (filed.rows[0].n > 0) {
      await discardFiles(row.reference);
    }

    return { reference: row.reference };
  });
}

export async function listApplications(options: {
  capturedBy?: string;
  statuses?: string[];
  limit?: number;
}): Promise<
  Array<{
    id: string;
    reference: string;
    membershipTypeName: string;
    status: string;
    applicantName: string;
    capturedByName: string;
    updatedAt: Date;
  }>
> {
  const result = await query<{
    id: string;
    reference: string;
    membership_type_name: string;
    status: string;
    applicant_name: string | null;
    captured_by_name: string;
    updated_at: Date;
  }>(
    `select a.id, a.reference, m.name as membership_type_name, a.status,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as applicant_name,
            u.display_name as captured_by_name,
            a.updated_at
       from membership_application a
       join membership_type m on m.id = a.membership_type_id
       join app_user u        on u.id = a.captured_by
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where ($1::uuid is null or a.captured_by = $1::uuid)
        and ($2::text[] is null or a.status = any($2::text[]))
      order by a.updated_at desc
      limit $3::int`,
    [options.capturedBy ?? null, options.statuses ?? null, options.limit ?? 100]
  );

  return result.rows.map(r => ({
    id: r.id,
    reference: r.reference,
    membershipTypeName: r.membership_type_name,
    status: r.status,
    applicantName: r.applicant_name || '(no name yet)',
    capturedByName: r.captured_by_name,
    updatedAt: r.updated_at,
  }));
}
