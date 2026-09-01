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
  // The accounts opened alongside the member, in configured order. They all
  // carry the member's number — AB0001 is the member, their Shares account and
  // their MSA — so the number is not repeated here.
  accounts: { id: string; typeCode: string; typeName: string }[];
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
  // Every type configured to open on approval, not one: a membership opens a
  // Shares account and an MSA together, and which types those are is
  // configuration read at approval time (S-206).
  const openOnApproval = await client.query<{
    id: string;
    code: string;
    name: string;
    default_status: string;
  }>(
    `select id, code, name, default_status from account_type
      where is_membership_default and is_active
      order by sort_order, name`
  );

  if (openOnApproval.rowCount === 0) {
    // Refusing is right: approving without opening the accounts would leave a
    // member the Society has to remember to finish by hand, which is exactly
    // what decision 1 and S-309 exist to prevent.
    throw new MemberCreationError(
      'No active account type is set to open when a membership is approved, ' +
        'so there is no account to open. Set one in Configuration → Account ' +
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

  // The application's own reference — APP-2026-000003, allocated at capture,
  // before anyone was a member — is replaced by the member's number. From
  // here on there is one identifier, not two: AB0001 is the application that
  // admitted them just as much as it is their Shares account and their MSA.
  // `reference` carries no trigger against being changed (unlike the
  // append-only tables), so this is a plain update inside the same
  // transaction as the member it now matches.
  //
  // What this does not reach back and rename: the signed form already
  // printed carries the old reference on paper, and any document already
  // filed sits in a SharePoint folder named after it (applicationFolderPath
  // reads the CURRENT reference, so a document filed after this point goes
  // to a new, AB-numbered folder instead). Both are archives of a moment,
  // not live views, and are expected to read differently from the record
  // that has since moved on.
  await client.query(
    `update membership_application set reference = $2 where id = $1`,
    [application.id, memberNo]
  );

  // A unique index on (member_id, account_type_id) means a retry that somehow
  // ran twice fails here rather than quietly opening a second Shares account
  // (S-309: exactly one of each).
  const accounts: CreatedMember['accounts'] = [];
  for (const type of openOnApproval.rows) {
    const account = await client.query<{ id: string }>(
      `insert into account (member_id, account_type_id, is_membership_default, status)
       values ($1, $2, true, $3)
       returning id`,
      [memberId, type.id, type.default_status]
    );
    accounts.push({
      id: account.rows[0].id,
      typeCode: type.code,
      typeName: type.name,
    });
  }

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

  // Against the APPLICATION, not the member: someone reading that record's
  // own history should see why its reference changed, not only find out by
  // noticing the member entry above.
  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'membership.application.renumbered',
      entityType: 'membership_application',
      entityId: application.id,
      previousValue: { reference: application.reference },
      newValue: { reference: memberNo },
    },
    client
  );

  // One entry per account. They opened together, but they are separate
  // accounts and each one's opening is its own thing to answer for.
  for (const account of accounts) {
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'account.opened',
        entityType: 'account',
        entityId: account.id,
        newValue: {
          memberNo,
          accountType: account.typeCode,
          openedBecause: 'membership approved',
        },
      },
      client
    );
  }

  return { id: memberId, memberNo, accounts };
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
  // The member's number. Both of a member's accounts carry it, which is why it
  // is read from the member rather than stored on the account.
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
  // Null for a legacy record imported in M7, which has no application here.
  applicationId: string | null;
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
    application_id: string | null;
    applicant_values: Record<string, string> | null;
  }>(
    `select m.id, m.member_no, t.name as membership_type_name, m.status,
            ${NAME_SQL} as name, m.joined_at,
            a.reference as application_reference,
            m.application_id,
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
    account_type_name: string;
    category: string;
    status: string;
    is_membership_default: boolean;
    opened_at: Date;
  }>(
    `select a.id, t.name as account_type_name, t.category,
            a.status, a.is_membership_default, a.opened_at
       from account a
       join account_type t on t.id = a.account_type_id
      where a.member_id = $1
      -- Both accounts open inside one transaction, so opened_at is the same
      -- instant on each and cannot order them. The configured order can, and
      -- it is the order the Society lists them in.
      order by t.sort_order, t.name`,
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
    applicationId: row.application_id,
    applicantValues: row.applicant_values ?? {},
    accounts: accounts.rows.map(a => ({
      id: a.id,
      accountNo: row.member_no,
      accountTypeName: a.account_type_name,
      category: a.category,
      status: a.status,
      isMembershipDefault: a.is_membership_default,
      openedAt: a.opened_at,
    })),
  };
}
