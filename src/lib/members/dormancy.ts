// Dormancy (S-804, S-805; DOR-US-001, FRD 7.11; Phase 2 open point 3).
//
// Nobody asks for a member to go dormant — it is the absence of anything
// happening — so, like a minor's birthday (majority.ts), it is found by a
// scheduled job rather than on any request path. Activity is anything that
// moved money on the member's accounts: a posted ledger entry or a fee
// payment, with the day they joined as the floor for a member who has had
// neither. After dormancy.months of nothing (configuration, 0 for off), an
// active member becomes dormant: dated, audited with the job as the actor,
// and told. The status itself already blocks (S-1501, S-1701); this is what
// sets it.
//
// Reactivation is the backlog's default until the Society confirms a rule:
// an officer holding member.reactivate, on the member's page, with a reason
// that goes on the trail and to the member. dormancy.reactivation names the
// rule; "staff" is the only one there is.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { dormancyMonths, dormancyReactivation } from '../config/reference';
import { query, withTransaction } from '../db/pool';
import { tellMember } from './tell-member';

export const PERMISSION_REACTIVATE = 'member.reactivate';
export const ACTION_DETECTED = 'member.dormancy_detected';
export const ACTION_REACTIVATED = 'member.reactivated';
const JOB_ACTOR = 'scheduled job: dormancy detection';

export class DormancyError extends Error {
  constructor(
    message: string,
    readonly reason:
      'invalid' | 'forbidden' | 'not_found' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'DormancyError';
  }
}

// When something last moved on a member's accounts, or the day they
// joined. One expression, used by the job and by the report so the two can
// never disagree about who is close.
//
// Officer feedback: never earlier than the day the record came into this
// system (m.created_at). A migrated member's Joined Date is from the old
// register, which brought no activity with it; one with nothing to carry
// (0 balances) was otherwise marked dormant the first night.
export const LAST_ACTIVITY_SQL = `
  greatest(
    m.joined_at,
    m.created_at,
    (select max(e.posted_at)
       from account_entry e
       join account a on a.id = e.account_id
      where a.member_id = m.id),
    (select max(p.received_at)
       from payment p
      where p.member_id = m.id and p.voided_at is null)
  )`;

export interface DormancyMark {
  memberId: string;
  memberNo: string;
  lastActivity: Date;
}

const dateWords = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' });

/**
 * Mark dormant every active member with no activity for the configured
 * months. Written in one transaction, told afterwards; a second run the
 * same night finds nothing.
 */
export async function detectDormancy(
  now: Date = new Date()
): Promise<{ marked: DormancyMark[]; months: number }> {
  const months = await dormancyMonths();
  if (months <= 0) return { marked: [], months };

  const marked = await withTransaction(async client => {
    const due = await client.query<{
      id: string;
      member_no: string;
      last_activity: Date;
    }>(
      `select m.id, m.member_no, ${LAST_ACTIVITY_SQL} as last_activity
         from member m
        where m.status = 'active'
          and ${LAST_ACTIVITY_SQL}
              < $1::timestamptz - make_interval(months => $2::int)
        order by m.member_no`,
      [now, months]
    );
    const rows: DormancyMark[] = [];
    for (const row of due.rows) {
      await client.query(
        `update member set status = 'dormant', status_changed_at = $2
          where id = $1 and status = 'active'`,
        [row.id, now]
      );
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: JOB_ACTOR,
          action: ACTION_DETECTED,
          entityType: 'member',
          entityId: row.id,
          previousValue: { status: 'active' },
          newValue: {
            status: 'dormant',
            last_activity: row.last_activity.toISOString(),
            months,
          },
        },
        client
      );
      rows.push({
        memberId: row.id,
        memberNo: row.member_no,
        lastActivity: row.last_activity,
      });
    }
    return rows;
  });

  for (const mark of marked) {
    await tellMember(mark.memberId, 'member.dormant', {
      last_activity: dateWords.format(mark.lastActivity),
      months: String(months),
    });
  }
  return { marked, months };
}

/**
 * Bring a dormant member back, with a reason. The caller's permission is
 * the whole rule today (dormancy.reactivation = "staff"); a different rule
 * would be decided here.
 */
export async function reactivateMember(
  memberId: string,
  reason: string,
  principal: Principal
): Promise<{ memberId: string; memberNo: string }> {
  if (!principal.permissions.has(PERMISSION_REACTIVATE)) {
    throw new DormancyError(
      'You do not have permission to reactivate a member.',
      'forbidden'
    );
  }
  if ((await dormancyReactivation()) !== 'staff') {
    throw new DormancyError(
      'Reactivation is not done by an officer under the current rule.',
      'forbidden'
    );
  }
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new DormancyError('Say why the member is being reactivated.');
  }

  const member = await query<{ member_no: string; status: string }>(
    `select member_no, status from member where id = $1`,
    [memberId]
  );
  const row = member.rows[0];
  if (!row) throw new DormancyError('No such member.', 'not_found');
  if (row.status !== 'dormant') {
    throw new DormancyError(
      'Only a dormant member can be reactivated.',
      'conflict'
    );
  }

  await withTransaction(async client => {
    const updated = await client.query(
      `update member set status = 'active', status_changed_at = now()
        where id = $1 and status = 'dormant'`,
      [memberId]
    );
    if (updated.rowCount === 0) {
      throw new DormancyError(
        'Only a dormant member can be reactivated.',
        'conflict'
      );
    }
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_REACTIVATED,
        entityType: 'member',
        entityId: memberId,
        previousValue: { status: 'dormant' },
        newValue: { status: 'active', reason: trimmed },
      },
      client
    );
  });

  await tellMember(memberId, 'member.reactivated', { reason: trimmed });
  return { memberId, memberNo: row.member_no };
}
