// Verifying what a member said about themselves from the app.
//
// A member can correct their own details on their phone (docs/member-app.md),
// but what KYC verified must not change on their say-so alone: the app
// records a `member_details_request` and the member sees "pending" until
// someone here applies or declines it. This is that side.
//
// Applying writes the proposed values over `application_party` on the
// member's founding application, which is where a member's details actually
// live — the `member` row carries none of its own. That write is in place
// and has no history, so the request keeps `previous_parties` (migration
// 0042) and the audit entry carries both halves.
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import type { PartyValues } from '../applications/capture';
import {
  listMembershipTypes,
  type FieldSubject,
  type MembershipTypeField,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_VERIFY = 'member.details_verify';
export const ENTITY_TYPE = 'member_details_request';
export const ACTION_APPLIED = 'member.details.applied';
export const ACTION_DECLINED = 'member.details.declined';

export class DetailsRequestError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'conflict' | 'forbidden' | 'invalid' = 'invalid'
  ) {
    super(message);
    this.name = 'DetailsRequestError';
  }
}

export type RequestStatus = 'pending' | 'applied' | 'declined';

export interface DetailsRequestSummary {
  id: string;
  memberId: string;
  memberNo: string;
  memberName: string;
  membershipTypeName: string;
  status: RequestStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  comment: string | null;
  // How many fields this request would change. What the queue is sorted and
  // read by: "3 changes" is the whole story at a glance.
  changeCount: number;
}

// One field the member wants changed, named the way their form names it.
export interface FieldChange {
  subject: FieldSubject;
  ordinal: number;
  fieldKey: string;
  label: string;
  dataType: string;
  before: string;
  after: string;
}

export interface DetailsRequestDetail extends DetailsRequestSummary {
  changes: FieldChange[];
  // The mobile the member verified to send this. Not a change — it cannot
  // be moved from the app — but the reviewer wants to see whose phone it was.
  mobile: string;
}

interface Row {
  id: string;
  member_id: string;
  member_no: string;
  member_name: string;
  membership_type_id: string;
  membership_type_name: string;
  status: RequestStatus;
  submitted_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
  comment: string | null;
  parties: PartyValues[];
  previous_parties: PartyValues[] | null;
  application_id: string | null;
  mobile: string | null;
}

const SELECT = `
  select r.id, r.member_id, m.member_no,
         trim(coalesce(p.values->>'name', '') || ' ' || coalesce(p.values->>'surname', ''))
           as member_name,
         m.membership_type_id, t.name as membership_type_name,
         r.status, r.submitted_at, r.decided_at, u.display_name as decided_by_name,
         r.comment, r.parties, r.previous_parties,
         m.application_id, s.mobile
    from member_details_request r
    join member m           on m.id = r.member_id
    join membership_type t  on t.id = m.membership_type_id
    join member_session s   on s.id = r.session_id
    left join app_user u    on u.id = r.decided_by
    left join application_party p
      on p.application_id = m.application_id
     and p.subject = 'applicant' and p.ordinal = 1
`;

// The fields this member's type configures, so a change can be named the way
// the form names it rather than by its column key.
async function fieldsFor(
  membershipTypeId: string
): Promise<Map<string, MembershipTypeField>> {
  const type = (await listMembershipTypes()).find(
    t => t.id === membershipTypeId
  );
  const byPath = new Map<string, MembershipTypeField>();
  for (const field of type?.fields ?? []) {
    byPath.set(`${field.subject}.${field.fieldKey}`, field);
  }
  return byPath;
}

// What the member actually changed.
//
// Measured against what the record held WHEN THEY SUBMITTED, never against
// what it holds now. The app sends the whole form back — a member
// correcting one field returns all forty — so a field they did not touch
// still arrives carrying the value they were shown. Diffed against the
// record as it stands, every such field would read as a change and applying
// would write the member's stale copy over anything an officer corrected at
// the branch in the meantime. Diffed against what they were shown, only
// what they meant to change is a change.
export function changesIn(
  proposed: PartyValues[],
  previous: PartyValues[],
  fields: Map<string, MembershipTypeField>
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const party of proposed) {
    const before = previous.find(
      p => p.subject === party.subject && p.ordinal === party.ordinal
    );
    for (const [fieldKey, after] of Object.entries(party.values)) {
      const was = before?.values[fieldKey] ?? '';
      if (was === after) continue;
      const field = fields.get(`${party.subject}.${fieldKey}`);
      changes.push({
        subject: party.subject,
        ordinal: party.ordinal,
        fieldKey,
        label: field?.label ?? fieldKey,
        dataType: field?.dataType ?? 'text',
        before: was,
        after,
      });
    }
  }
  return changes;
}

async function hydrate(row: Row): Promise<DetailsRequestDetail> {
  const fields = await fieldsFor(row.membership_type_id);
  // previous_parties is null only on a request made before migration 0042.
  // For one still pending the record has not moved, so reading it now says
  // the same thing; for a decided one it is the best that can be had, and
  // the audit entry has the rest.
  const previous =
    row.previous_parties ?? (await partiesOf(row.application_id));
  const changes = changesIn(row.parties, previous, fields);
  return {
    id: row.id,
    memberId: row.member_id,
    memberNo: row.member_no,
    memberName: row.member_name || '(unnamed)',
    membershipTypeName: row.membership_type_name,
    status: row.status,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    decidedByName: row.decided_by_name,
    comment: row.comment,
    mobile: row.mobile ?? '',
    changes,
    changeCount: changes.length,
  };
}

// `client` is not optional decoration: inside withTransaction the pool may
// have no second connection to give (DATABASE_POOL_MAX is 3 deployed and 1
// under test), so a nested query() on its own connection would wait for one
// the open transaction is holding — a deadlock that looks like a hang.
async function partiesOf(
  applicationId: string | null,
  client?: PoolClient
): Promise<PartyValues[]> {
  if (!applicationId) return [];
  const run = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
        client.query<T>(sql, params)
    : <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
        query<T>(sql, params);
  const result = await run<{
    subject: FieldSubject;
    ordinal: number;
    values: Record<string, string>;
  }>(
    `select subject, ordinal, values from application_party
      where application_id = $1 order by subject, ordinal`,
    [applicationId]
  );
  return result.rows.map(r => ({
    subject: r.subject,
    ordinal: r.ordinal,
    values: r.values,
  }));
}

/**
 * The queue. Pending first and oldest first inside it — a member waiting on
 * a verification has been waiting longest — then the decided ones, newest
 * first, so the page can show recent history under the work.
 *
 * Every row carries its own changes rather than a count alone: the queue
 * IS the review screen (there is nothing to see on a request beyond what
 * differs), so a second read per row to open one would be a round trip for
 * data this already computed.
 */
export async function listDetailsRequests(
  options: { status?: RequestStatus; limit?: number } = {}
): Promise<DetailsRequestDetail[]> {
  const result = await query<Row>(
    `${SELECT}
      where ($1::text is null or r.status = $1::text)
      order by (r.status = 'pending') desc,
               case when r.status = 'pending' then r.submitted_at end asc,
               r.decided_at desc nulls last
      limit $2`,
    [options.status ?? null, options.limit ?? 100]
  );
  return Promise.all(result.rows.map(hydrate));
}

export async function countPendingDetailsRequests(): Promise<number> {
  const result = await query<{ n: number }>(
    `select count(*)::int as n from member_details_request where status = 'pending'`
  );
  return result.rows[0]?.n ?? 0;
}

export async function loadDetailsRequest(
  id: string
): Promise<DetailsRequestDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const result = await query<Row>(`${SELECT} where r.id = $1`, [id]);
  const row = result.rows[0];
  return row ? hydrate(row) : null;
}

function assertMayVerify(principal: Principal): void {
  if (!principal.permissions.has(PERMISSION_VERIFY)) {
    throw new DetailsRequestError(
      'You do not have permission to verify member details.',
      'forbidden'
    );
  }
}

/**
 * Apply the change to the member's record.
 *
 * Only the fields that actually differ are written, onto whichever party
 * they belong to — a request never replaces a party wholesale, so a field
 * an officer corrected at the branch while this sat in the queue is not
 * silently reverted by a request that never mentioned it.
 */
export async function applyDetailsRequest(
  id: string,
  principal: Principal
): Promise<{ memberId: string; applied: number }> {
  assertMayVerify(principal);

  // Read outside the transaction, on its own connection, for the reason
  // partiesOf explains: listMembershipTypes goes to the database (through a
  // short-lived cache), and a transaction holding the only connection
  // cannot wait for a second one.
  const owner = await query<{ membership_type_id: string }>(
    `select m.membership_type_id
       from member_details_request r
       join member m on m.id = r.member_id
      where r.id = $1`,
    [/^[0-9a-f-]{36}$/i.test(id) ? id : null]
  );
  if (owner.rowCount === 0) {
    throw new DetailsRequestError(
      'That request no longer exists.',
      'not_found'
    );
  }
  const fields = await fieldsFor(owner.rows[0].membership_type_id);

  return withTransaction(async client => {
    // Locked, so two people acting on the same request cannot both apply it.
    const locked = await client.query<{
      member_id: string;
      status: RequestStatus;
      parties: PartyValues[];
      previous_parties: PartyValues[] | null;
      application_id: string | null;
      member_no: string;
    }>(
      `select r.member_id, r.status, r.parties, r.previous_parties,
              m.application_id, m.member_no
         from member_details_request r
         join member m on m.id = r.member_id
        where r.id = $1
          for no key update of r`,
      [id]
    );
    const row = locked.rows[0];
    if (!row) {
      throw new DetailsRequestError(
        'That request no longer exists.',
        'not_found'
      );
    }
    if (row.status !== 'pending') {
      throw new DetailsRequestError(
        `This request has already been ${row.status}.`,
        'conflict'
      );
    }
    if (!row.application_id) {
      throw new DetailsRequestError(
        'This member has no application to write these details to.',
        'conflict'
      );
    }

    // What the member meant to change, against what they were shown — see
    // changesIn. The record as it stands is read too, but only to write
    // onto and to record as the previous value: a field the member did not
    // touch is not in `changes` at all, so an officer's correction made
    // while this waited survives applying.
    const before = await partiesOf(row.application_id, client);
    const shown = row.previous_parties ?? before;
    const changes = changesIn(row.parties, shown, fields);

    // Merged field by field into whatever the party holds now, never
    // replacing it: jsonb || jsonb keeps every key the request is silent
    // about.
    for (const party of row.parties) {
      const changed = changes.filter(
        c => c.subject === party.subject && c.ordinal === party.ordinal
      );
      if (changed.length === 0) continue;
      const patch = Object.fromEntries(changed.map(c => [c.fieldKey, c.after]));
      await client.query(
        `update application_party
            set values = values || $4::jsonb
          where application_id = $1 and subject = $2 and ordinal = $3`,
        [
          row.application_id,
          party.subject,
          party.ordinal,
          JSON.stringify(patch),
        ]
      );
    }

    await client.query(
      `update member_details_request
          set status = 'applied', decided_at = now(), decided_by = $2
        where id = $1`,
      [id, principal.userId]
    );

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_APPLIED,
        entityType: ENTITY_TYPE,
        entityId: id,
        previousValue: { parties: before },
        newValue: {
          memberNo: row.member_no,
          changes: changes.map(c => ({
            field: `${c.subject}.${c.ordinal}.${c.fieldKey}`,
            from: c.before,
            to: c.after,
          })),
        },
      },
      client
    );

    return { memberId: row.member_id, applied: changes.length };
  });
}

/**
 * Decline it, saying why. The member is told, so the comment is required —
 * "we could not match this to a document" is something they can act on;
 * silence is not.
 */
export async function declineDetailsRequest(
  id: string,
  comment: string,
  principal: Principal
): Promise<{ memberId: string }> {
  assertMayVerify(principal);

  const reason = comment.trim();
  if (reason === '') {
    throw new DetailsRequestError(
      'Declining a request needs a reason. The member is shown it.'
    );
  }

  return withTransaction(async client => {
    const updated = await client.query<{ member_id: string }>(
      `update member_details_request
          set status = 'declined', decided_at = now(), decided_by = $2,
              comment = $3
        where id = $1 and status = 'pending'
        returning member_id`,
      [id, principal.userId, reason]
    );
    const row = updated.rows[0];
    if (!row) {
      // Either it never existed or somebody else got there first; the
      // caller cannot act on either, and the page re-reads to say which.
      throw new DetailsRequestError(
        'That request is no longer pending.',
        'conflict'
      );
    }

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_DECLINED,
        entityType: ENTITY_TYPE,
        entityId: id,
        newValue: { comment: reason },
      },
      client
    );

    return { memberId: row.member_id };
  });
}
