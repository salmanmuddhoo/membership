// A Minor member's guardian: who it is now, whether they are still there,
// and changing them (migration 0107).
//
// The guardian block lives on the minor's founding application, as capture
// wrote it (application_party, subject 'guardian'): surname, name, NIC, the
// guardian's own Member No., relationship and mobile. It is read-only on
// the member page. The one way to change it is a guardian_change: an
// officer records the new guardian — an existing member, whose identity is
// already on file under their own membership — and a second person
// approves it; only then is the block replaced. The block before and after
// are kept on the change and in the audit trail.
//
// While a minor's guardian is demised and not yet replaced, no money leaves
// the minor's accounts (officer direction): a withdrawal, a transfer out, a
// closure or the minor's resignation is refused with guardianGoneMessage.
// Money in still arrives, and a demised claim on the minor is still made —
// it is paid to the nominee. A minor who is not a member has no change of
// guardian to make here, so is not held back either.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_CHANGE = 'member.guardian_change';
export const PERMISSION_APPROVE = 'member.guardian_approve';

export class GuardianChangeError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'conflict' | 'forbidden' | 'invalid' = 'invalid'
  ) {
    super(message);
    this.name = 'GuardianChangeError';
  }
}

export interface CurrentGuardian {
  // The guardian block as it stands, empty when none was captured.
  values: Record<string, string>;
  // The guardian's own member record, where the block names one.
  memberId: string | null;
  memberNo: string;
  name: string;
  status: string | null;
}

function fullName(values: Record<string, string> | null | undefined): string {
  return [values?.name, values?.surname]
    .map(v => (v ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

async function minorFor(
  memberId: string,
  client?: PoolClient
): Promise<{
  id: string;
  memberNo: string;
  status: string;
  typeCode: string;
  applicationId: string | null;
} | null> {
  const run = client ? client.query.bind(client) : query;
  const result = await run<{
    id: string;
    member_no: string;
    status: string;
    type_code: string;
    application_id: string | null;
  }>(
    `select m.id, m.member_no, m.status, t.code as type_code, m.application_id
       from member m
       join membership_type t on t.id = m.membership_type_id
      where m.id = $1`,
    [memberId]
  );
  const r = result.rows[0];
  return r
    ? {
        id: r.id,
        memberNo: r.member_no,
        status: r.status,
        typeCode: r.type_code,
        applicationId: r.application_id,
      }
    : null;
}

/**
 * The guardian a Minor member has now. Null for anyone who is not a Minor
 * member. The guardian's own record is found as capture found it: by the
 * Member No. in the block, or failing that by its NIC.
 */
export async function currentGuardian(
  memberId: string
): Promise<CurrentGuardian | null> {
  const result = await query<{
    values: Record<string, string> | null;
    guardian_id: string | null;
    guardian_no: string | null;
    guardian_status: string | null;
  }>(
    `select g.values, gm.id as guardian_id, gm.member_no as guardian_no,
            gm.status as guardian_status
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join application_party g
         on g.application_id = m.application_id
        and g.subject = 'guardian' and g.ordinal = 1
       left join lateral (
         select gm.id, gm.member_no, gm.status
           from member gm
           left join application_party ga
             on ga.application_id = gm.application_id
            and ga.subject = 'applicant' and ga.ordinal = 1
          where gm.id <> m.id
            and ((coalesce(g.values->>'member_id', '') <> ''
                  and lower(gm.member_no) = lower(g.values->>'member_id'))
                 or (coalesce(g.values->>'nic', '') <> ''
                     and ga.values->>'nic' = g.values->>'nic'))
          order by (lower(gm.member_no) = lower(coalesce(g.values->>'member_id', ''))) desc
          limit 1
       ) gm on true
      where m.id = $1 and t.code = 'minor'`,
    [memberId]
  );
  const r = result.rows[0];
  if (!r) return null;
  const values = r.values ?? {};
  return {
    values,
    memberId: r.guardian_id,
    memberNo: r.guardian_no ?? values.member_id ?? '',
    name: fullName(values),
    status: r.guardian_status,
  };
}

/**
 * Why no money may leave a member's accounts because of their guardian, or
 * null when nothing stands in the way: a Minor member whose guardian is
 * demised and not yet replaced. Every money-out path asks this before it
 * records anything.
 */
export async function guardianGoneMessage(
  memberId: string | null
): Promise<string | null> {
  if (!memberId) return null;
  const guardian = await currentGuardian(memberId);
  if (!guardian || guardian.status !== 'demised') return null;
  const who = [guardian.name, guardian.memberNo].filter(Boolean).join(' · ');
  return `The guardian${who ? `, ${who},` : ''} is demised. Record a new guardian first.`;
}

export interface GuardianChange {
  id: string;
  memberId: string;
  previousValues: Record<string, string>;
  newValues: Record<string, string>;
  status: 'submitted' | 'approved' | 'rejected' | 'cancelled';
  capturedById: string | null;
  capturedByName: string | null;
  capturedAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  comment: string | null;
}

const SELECT_CHANGE = `
  select c.id, c.member_id, c.previous_values, c.new_values, c.status,
         c.captured_by, cu.display_name as captured_by_name, c.captured_at,
         du.display_name as decided_by_name, c.decided_at, c.comment
    from guardian_change c
    left join app_user cu on cu.id = c.captured_by
    left join app_user du on du.id = c.decided_by`;

interface ChangeRow {
  id: string;
  member_id: string;
  previous_values: Record<string, string>;
  new_values: Record<string, string>;
  status: GuardianChange['status'];
  captured_by: string | null;
  captured_by_name: string | null;
  captured_at: Date;
  decided_by_name: string | null;
  decided_at: Date | null;
  comment: string | null;
}

function toChange(r: ChangeRow): GuardianChange {
  return {
    id: r.id,
    memberId: r.member_id,
    previousValues: r.previous_values,
    newValues: r.new_values,
    status: r.status,
    capturedById: r.captured_by,
    capturedByName: r.captured_by_name,
    capturedAt: r.captured_at,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
    comment: r.comment,
  };
}

async function loadChange(id: string): Promise<GuardianChange> {
  const result = await query<ChangeRow>(`${SELECT_CHANGE} where c.id = $1`, [
    id,
  ]);
  return toChange(result.rows[0]);
}

/** The change waiting on a minor, if any. */
export async function openGuardianChange(
  memberId: string
): Promise<GuardianChange | null> {
  const result = await query<ChangeRow>(
    `${SELECT_CHANGE} where c.member_id = $1 and c.status = 'submitted'`,
    [memberId]
  );
  return result.rows[0] ? toChange(result.rows[0]) : null;
}

/** Every change made or asked for on a minor, newest first. */
export async function guardianChanges(
  memberId: string
): Promise<GuardianChange[]> {
  const result = await query<ChangeRow>(
    `${SELECT_CHANGE} where c.member_id = $1 order by c.captured_at desc`,
    [memberId]
  );
  return result.rows.map(toChange);
}

export interface GuardianChangeInput {
  // The new guardian's Member No.
  guardianMemberNo: string;
  relationship: string;
  // Left blank, the guardian's own mobile on file.
  mobile?: string;
}

/**
 * Record a new guardian for a Minor member, waiting on approval. The
 * guardian block is untouched until then.
 */
export async function recordGuardianChange(
  memberId: string,
  input: GuardianChangeInput,
  principal: Principal
): Promise<GuardianChange> {
  if (!principal.permissions.has(PERMISSION_CHANGE)) {
    throw new GuardianChangeError(
      'You do not have permission to change a guardian.',
      'forbidden'
    );
  }
  const minor = await minorFor(memberId);
  if (!minor) {
    throw new GuardianChangeError('That member no longer exists.', 'not_found');
  }
  if (minor.typeCode !== 'minor' || !minor.applicationId) {
    throw new GuardianChangeError('Only a Minor member has a guardian.');
  }
  if (minor.status === 'resigned' || minor.status === 'demised') {
    throw new GuardianChangeError(
      `This member is ${minor.status}.`,
      'conflict'
    );
  }
  const relationship = input.relationship.trim();
  if (!relationship) {
    throw new GuardianChangeError('Enter the relationship to the minor.');
  }
  const memberNo = input.guardianMemberNo.trim();
  if (!memberNo) throw new GuardianChangeError('Choose the new guardian.');

  const found = await query<{
    id: string;
    member_no: string;
    status: string;
    type_code: string;
    values: Record<string, string> | null;
  }>(
    `select m.id, m.member_no, m.status, t.code as type_code, p.values
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where lower(m.member_no) = lower($1)`,
    [memberNo]
  );
  const guardian = found.rows[0];
  if (!guardian) {
    throw new GuardianChangeError(`No member ${memberNo}.`, 'not_found');
  }
  if (guardian.id === minor.id) {
    throw new GuardianChangeError('A minor cannot be their own guardian.');
  }
  if (guardian.type_code !== 'individual') {
    throw new GuardianChangeError(
      `${guardian.member_no} is not an Individual member, so cannot be a guardian.`
    );
  }
  if (guardian.status !== 'active') {
    throw new GuardianChangeError(
      `${guardian.member_no} is ${guardian.status}, so cannot be a guardian.`
    );
  }
  const current = await currentGuardian(minor.id);
  if (
    current?.memberNo &&
    current.memberNo.toLowerCase() === guardian.member_no.toLowerCase() &&
    current.status !== 'demised'
  ) {
    throw new GuardianChangeError(
      `${guardian.member_no} is already the guardian.`,
      'conflict'
    );
  }

  const values = guardian.values ?? {};
  const newValues: Record<string, string> = {
    surname: (values.surname ?? '').trim(),
    name: (values.name ?? '').trim(),
    nic: (values.nic ?? '').trim(),
    member_id: guardian.member_no,
    relationship,
    mobile: (input.mobile ?? '').trim() || (values.mobile ?? '').trim(),
  };
  const previousValues = current?.values ?? {};

  const id = await withTransaction(async client => {
    const open = await client.query(
      `select 1 from guardian_change
        where member_id = $1 and status = 'submitted' for update`,
      [minor.id]
    );
    if (open.rowCount) {
      throw new GuardianChangeError(
        'A change of guardian is already waiting for approval.',
        'conflict'
      );
    }
    const inserted = await client.query<{ id: string }>(
      `insert into guardian_change
         (member_id, previous_values, new_values, captured_by)
       values ($1, $2, $3, $4)
       returning id`,
      [
        minor.id,
        JSON.stringify(previousValues),
        JSON.stringify(newValues),
        principal.userId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'member.guardian_change.recorded',
        entityType: 'member',
        entityId: minor.memberNo,
        previousValue: previousValues,
        newValue: newValues,
      },
      client
    );
    return inserted.rows[0].id;
  });
  return loadChange(id);
}

/**
 * Approve or reject a change. Approval replaces the minor's guardian block
 * with the one the change carries; a rejection needs a reason. Never by the
 * person who recorded it.
 */
export async function decideGuardianChange(
  changeId: string,
  outcome: 'approve' | 'reject',
  comment: string,
  principal: Principal
): Promise<GuardianChange> {
  if (!principal.permissions.has(PERMISSION_APPROVE)) {
    throw new GuardianChangeError(
      'You do not have permission to approve a change of guardian.',
      'forbidden'
    );
  }
  const reason = comment.trim();
  if (outcome === 'reject' && !reason) {
    throw new GuardianChangeError('Give a reason for rejecting it.');
  }
  await withTransaction(async client => {
    const found = await client.query<{
      member_id: string;
      status: string;
      captured_by: string | null;
      new_values: Record<string, string>;
      previous_values: Record<string, string>;
    }>(
      `select member_id, status, captured_by, new_values, previous_values
         from guardian_change where id = $1 for update`,
      [changeId]
    );
    const change = found.rows[0];
    if (!change) {
      throw new GuardianChangeError(
        'That change no longer exists.',
        'not_found'
      );
    }
    if (change.status !== 'submitted') {
      throw new GuardianChangeError(
        `This change is already ${change.status}.`,
        'conflict'
      );
    }
    if (change.captured_by === principal.userId) {
      throw new GuardianChangeError(
        'Someone other than the officer who recorded it must decide it.',
        'forbidden'
      );
    }
    const minor = await minorFor(change.member_id, client);
    if (!minor?.applicationId) {
      throw new GuardianChangeError(
        'That member no longer exists.',
        'not_found'
      );
    }

    if (outcome === 'approve') {
      // The new guardian may have left since it was recorded.
      const guardian = await client.query<{ status: string }>(
        `select status from member where lower(member_no) = lower($1)`,
        [change.new_values.member_id ?? '']
      );
      const status = guardian.rows[0]?.status;
      if (status !== 'active') {
        throw new GuardianChangeError(
          `${change.new_values.member_id} is ${status ?? 'not a member'}, so cannot be a guardian.`,
          'conflict'
        );
      }
      const updated = await client.query(
        `update application_party
            set values = $2, updated_at = now()
          where application_id = $1 and subject = 'guardian' and ordinal = 1`,
        [minor.applicationId, JSON.stringify(change.new_values)]
      );
      if (!updated.rowCount) {
        await client.query(
          `insert into application_party (application_id, subject, ordinal, values)
           values ($1, 'guardian', 1, $2)`,
          [minor.applicationId, JSON.stringify(change.new_values)]
        );
      }
    }

    await client.query(
      `update guardian_change
          set status = $2, decided_by = $3, decided_at = now(), comment = $4
        where id = $1`,
      [
        changeId,
        outcome === 'approve' ? 'approved' : 'rejected',
        principal.userId,
        reason || null,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action:
          outcome === 'approve'
            ? 'member.guardian_changed'
            : 'member.guardian_change.rejected',
        entityType: 'member',
        entityId: minor.memberNo,
        previousValue: change.previous_values,
        newValue:
          outcome === 'approve'
            ? change.new_values
            : { rejected: change.new_values, comment: reason },
      },
      client
    );
  });
  return loadChange(changeId);
}

/** The officer who recorded a change withdraws it before it is decided. */
export async function cancelGuardianChange(
  changeId: string,
  principal: Principal
): Promise<void> {
  await withTransaction(async client => {
    const found = await client.query<{
      member_id: string;
      status: string;
      captured_by: string | null;
      new_values: Record<string, string>;
    }>(
      `select member_id, status, captured_by, new_values
         from guardian_change where id = $1 for update`,
      [changeId]
    );
    const change = found.rows[0];
    if (!change) {
      throw new GuardianChangeError(
        'That change no longer exists.',
        'not_found'
      );
    }
    if (change.status !== 'submitted') {
      throw new GuardianChangeError(
        `This change is already ${change.status}.`,
        'conflict'
      );
    }
    if (change.captured_by !== principal.userId) {
      throw new GuardianChangeError(
        'Only the officer who recorded it can withdraw it.',
        'forbidden'
      );
    }
    await client.query(
      `update guardian_change
          set status = 'cancelled', decided_by = $2, decided_at = now()
        where id = $1`,
      [changeId, principal.userId]
    );
    const minor = await minorFor(change.member_id, client);
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'member.guardian_change.cancelled',
        entityType: 'member',
        entityId: minor?.memberNo ?? change.member_id,
        newValue: { withdrawn: change.new_values },
      },
      client
    );
  });
}

/**
 * The changes waiting on an approver: every one still submitted that they
 * did not record themselves. Empty without member.guardian_approve.
 */
export async function guardianChangesWaitingOn(
  principal: Principal
): Promise<{ memberId: string; memberNo: string; name: string }[]> {
  if (!principal.permissions.has(PERMISSION_APPROVE)) return [];
  const result = await query<{
    member_id: string;
    member_no: string;
    values: Record<string, string> | null;
  }>(
    `select c.member_id, m.member_no, p.values
       from guardian_change c
       join member m on m.id = c.member_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where c.status = 'submitted'
        and c.captured_by is distinct from $1
      order by c.captured_at`,
    [principal.userId]
  );
  return result.rows.map(r => ({
    memberId: r.member_id,
    memberNo: r.member_no,
    name: fullName(r.values),
  }));
}
