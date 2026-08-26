// Creating the Member and their default account on approval (S-308, S-309).
//
// Both happen inside the transaction that approves the application, passed in
// as a client rather than opening their own. That is the whole of S-308's
// "given creation fails part-way then nothing is half-created": an approved
// application with no member, or a member with no account, are states nobody
// can act on and no report would explain.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query } from '../db/pool';
import type { Actor, Application } from '../applications/capture';

export class MemberCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberCreationError';
  }
}

export interface CreatedMember {
  id: string;
  memberNo: string;
  accountNo: string;
}

/**
 * Turn an approved application into a Member with their default account.
 *
 * The account type is whichever one is configured as the membership default
 * (S-206), read now rather than cached — so an administrator who changed it
 * this morning gets the new product on this afternoon's approvals, which is
 * the acceptance criterion S-206 states.
 */
export async function createMemberFromApplication(
  client: PoolClient,
  application: Application,
  actor: Actor
): Promise<CreatedMember> {
  const defaultType = await client.query<{
    id: string;
    code: string;
    name: string;
  }>(
    `select id, code, name from account_type
      where is_membership_default and is_active
      limit 1`
  );

  if (defaultType.rowCount === 0) {
    // Refusing is right: approving without opening the account would leave a
    // member the Society has to remember to finish by hand, which is exactly
    // what decision 1 and S-309 exist to prevent.
    throw new MemberCreationError(
      'No active account type is configured as the membership default, so ' +
        'there is no account to open. Set one in Configuration → Account ' +
        'types before approving.'
    );
  }

  const member = await client.query<{ id: string; member_no: string }>(
    `insert into member (application_id, membership_type_id)
     values ($1, $2)
     returning id, member_no`,
    [application.id, application.membershipTypeId]
  );
  const { id: memberId, member_no: memberNo } = member.rows[0];

  // is_membership_default carries a partial unique index per member, so a
  // retry that somehow ran twice fails here rather than quietly opening a
  // second MSA (S-309: "exactly one MSA is created").
  const account = await client.query<{ id: string; account_no: string }>(
    `insert into account (member_id, account_type_id, is_membership_default, status)
     values ($1, $2, true, $3)
     returning id, account_no`,
    [memberId, defaultType.rows[0].id, 'active']
  );
  const { id: accountId, account_no: accountNo } = account.rows[0];

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'member.created',
      entityType: 'member',
      entityId: memberId,
      newValue: {
        memberNo,
        fromApplication: application.reference,
        membershipType: application.membershipTypeCode,
      },
    },
    client
  );

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'account.opened',
      entityType: 'account',
      entityId: accountId,
      newValue: {
        accountNo,
        memberNo,
        accountType: defaultType.rows[0].code,
        openedBecause: 'membership approved',
      },
    },
    client
  );

  return { id: memberId, memberNo, accountNo };
}

export interface MemberSummary {
  id: string;
  memberNo: string;
  membershipTypeName: string;
  status: string;
  name: string;
  joinedAt: Date;
  applicationReference: string | null;
}

export interface MemberAccount {
  id: string;
  accountNo: string;
  accountTypeName: string;
  category: string;
  status: string;
  isMembershipDefault: boolean;
  openedAt: Date;
}

export interface MemberDetail extends MemberSummary {
  accounts: MemberAccount[];
  applicantValues: Record<string, string>;
}

// The name is assembled from the application's applicant party, because what
// counts as a name differs by membership type: an Individual has a surname and
// a name, a Corporate entity has one registered name.
const NAME_SQL = `
  trim(coalesce(p.values->>'name', '') || ' ' || coalesce(p.values->>'surname', ''))
`;

export async function listMembers(
  options: { search?: string; limit?: number } = {}
) {
  const search = options.search?.trim() ? options.search.trim() : null;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);

  const result = await query<{
    id: string;
    member_no: string;
    membership_type_name: string;
    status: string;
    name: string;
    joined_at: Date;
    application_reference: string | null;
    total_count: string;
  }>(
    `select m.id, m.member_no, t.name as membership_type_name, m.status,
            ${NAME_SQL} as name, m.joined_at,
            a.reference as application_reference,
            count(*) over () as total_count
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join membership_application a on a.id = m.application_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where $1::text is null
         or strpos(lower(m.member_no), lower($1::text)) > 0
         or strpos(lower(${NAME_SQL}), lower($1::text)) > 0
      order by m.member_no
      limit $2::int`,
    [search, limit]
  );

  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

  return {
    members: result.rows.map(r => ({
      id: r.id,
      memberNo: r.member_no,
      membershipTypeName: r.membership_type_name,
      status: r.status,
      name: r.name || '(unnamed)',
      joinedAt: r.joined_at,
      applicationReference: r.application_reference,
    })),
    total,
    truncated: result.rows.length < total,
  };
}

// S-310 · A member and their accounts, so the created record can be confirmed.
export async function loadMember(id: string): Promise<MemberDetail | null> {
  const result = await query<{
    id: string;
    member_no: string;
    membership_type_name: string;
    status: string;
    name: string;
    joined_at: Date;
    application_reference: string | null;
    applicant_values: Record<string, string> | null;
  }>(
    `select m.id, m.member_no, t.name as membership_type_name, m.status,
            ${NAME_SQL} as name, m.joined_at,
            a.reference as application_reference,
            p.values as applicant_values
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join membership_application a on a.id = m.application_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where m.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];

  const accounts = await query<{
    id: string;
    account_no: string;
    account_type_name: string;
    category: string;
    status: string;
    is_membership_default: boolean;
    opened_at: Date;
  }>(
    `select a.id, a.account_no, t.name as account_type_name, t.category,
            a.status, a.is_membership_default, a.opened_at
       from account a
       join account_type t on t.id = a.account_type_id
      where a.member_id = $1
      order by a.opened_at`,
    [id]
  );

  return {
    id: row.id,
    memberNo: row.member_no,
    membershipTypeName: row.membership_type_name,
    status: row.status,
    name: row.name || '(unnamed)',
    joinedAt: row.joined_at,
    applicationReference: row.application_reference,
    applicantValues: row.applicant_values ?? {},
    accounts: accounts.rows.map(a => ({
      id: a.id,
      accountNo: a.account_no,
      accountTypeName: a.account_type_name,
      category: a.category,
      status: a.status,
      isMembershipDefault: a.is_membership_default,
      openedAt: a.opened_at,
    })),
  };
}
