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
  // Empty for a customer (S-614's openAccountsForCustomerApplication) — a
  // customer has no number of their own the way a member's AB number is one;
  // each of their accounts carries its own instead (see accountNo below).
  memberNo: string;
  // The accounts opened alongside the member, in configured order. A
  // member's carry no number of their own — the member's own number (above)
  // already identifies them, which is why accountNo is optional here and set
  // only by openAccountsForCustomerApplication.
  accounts: {
    id: string;
    typeCode: string;
    typeName: string;
    accountNo?: string;
  }[];
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
  // S-613: an additional-account application already has its member —
  // opening one is exactly what it is not allowed to do (S-612's own
  // check constraint agrees: existing_member_id and membership_type_id are
  // never both set). Its own approval path opens the selected account
  // type(s) under existing_member_id instead; nothing wires that up to this
  // function yet, but the guard is here so a mistake in that wiring fails
  // loudly rather than creating a member nobody asked for.
  if (application.applicationKind !== 'membership') {
    throw new MemberCreationError(
      'This application does not create a member — it opens an account for ' +
        'one that already exists.'
    );
  }

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

/**
 * S-613 · Turn an approved additional_account application into the
 * selected account(s), under the member it already names.
 *
 * The counterpart to createMemberFromApplication above, and deliberately not
 * a branch inside it — the same reason startAdditionalAccountApplication
 * sits beside startApplication rather than inside it. Nothing here creates a
 * member: existingMemberId already is one, and which account(s) to open
 * comes from this application's own selection (S-612), not
 * is_membership_default.
 */
export async function openAccountsForApplication(
  client: PoolClient,
  application: Application,
  actor: Actor
): Promise<CreatedMember> {
  if (application.applicationKind !== 'additional_account') {
    throw new MemberCreationError(
      'This application creates a member — it does not open an account for ' +
        'one that already exists.'
    );
  }

  const member = await client.query<{ member_no: string; status: string }>(
    `select member_no, status from member where id = $1 for no key update`,
    [application.existingMemberId]
  );
  if (member.rowCount === 0) {
    throw new MemberCreationError('That member no longer exists.');
  }
  if (member.rows[0].status !== 'active') {
    throw new MemberCreationError(
      'This member is no longer active, so no account can be opened for them.'
    );
  }
  const memberNo = member.rows[0].member_no;

  // Re-read now, not trusted from when the application was captured — the
  // same reason createMemberFromApplication above reads the membership
  // default fresh rather than caching it (S-206): an administrator may have
  // deactivated one of these since.
  const typeIds = application.selectedAccountTypes.map(t => t.id);
  const types = await client.query<{
    id: string;
    code: string;
    name: string;
    default_status: string;
    is_active: boolean;
  }>(
    `select id, code, name, default_status, is_active
       from account_type where id = any($1::uuid[])`,
    [typeIds]
  );
  const byId = new Map(types.rows.map(t => [t.id, t]));
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id);
    if (!type || !type.is_active) {
      throw new MemberCreationError(
        `${selected.name} is no longer available to open. Ask an ` +
          'administrator before approving this application.'
      );
    }
  }

  // Refused here, one at a time, rather than left to the database's own
  // unique index (account_one_per_type_per_member_idx, migration 0018) to
  // turn a second HSA into an opaque constraint violation for whoever
  // approves this.
  const already = await client.query<{ name: string }>(
    `select t.name
       from account a
       join account_type t on t.id = a.account_type_id
      where a.member_id = $1 and a.account_type_id = any($2::uuid[])`,
    [application.existingMemberId, typeIds]
  );
  if ((already.rowCount ?? 0) > 0) {
    throw new MemberCreationError(
      `${memberNo} already has ${already.rows.map(r => r.name).join(', ')} open.`
    );
  }

  const accounts: CreatedMember['accounts'] = [];
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id)!;
    const account = await client.query<{ id: string }>(
      `insert into account (member_id, account_type_id, is_membership_default, status)
       values ($1, $2, false, $3)
       returning id`,
      [application.existingMemberId, type.id, type.default_status]
    );
    accounts.push({
      id: account.rows[0].id,
      typeCode: type.code,
      typeName: type.name,
    });
  }

  // One entry per account, the same reason createMemberFromApplication
  // above audits each one separately: they opened together, but each is its
  // own thing to answer for.
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
          openedBecause: 'additional-account application approved',
        },
      },
      client
    );
  }

  return { id: application.existingMemberId, memberNo, accounts };
}

/**
 * S-614 · Turn an approved customer_account application into a customer and
 * the selected account(s), numbered from account_type.number_prefix
 * (next_customer_account_number, migration 0027).
 *
 * The counterpart to openAccountsForApplication above, for someone who was
 * never a member to begin with rather than one who already is — same reason
 * that one sits beside createMemberFromApplication instead of inside it.
 * `application.parties` already carries what a customer needs (captured the
 * same way a membership application's applicant is); this only opens the
 * accounts and creates the bare `customer` row (as bare as `member`, for the
 * same reason — migration 0027) that ties them to it.
 */
export async function openAccountsForCustomerApplication(
  client: PoolClient,
  application: Application,
  actor: Actor
): Promise<CreatedMember> {
  if (application.applicationKind !== 'customer_account') {
    throw new MemberCreationError(
      'This application does not open accounts for a non-member applicant.'
    );
  }

  // Re-read now, not trusted from capture time — the same reason
  // openAccountsForApplication above re-reads its own selection fresh.
  const typeIds = application.selectedAccountTypes.map(t => t.id);
  const types = await client.query<{
    id: string;
    code: string;
    name: string;
    default_status: string;
    is_active: boolean;
    number_prefix: string | null;
  }>(
    `select id, code, name, default_status, is_active, number_prefix
       from account_type where id = any($1::uuid[])`,
    [typeIds]
  );
  const byId = new Map(types.rows.map(t => [t.id, t]));
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id);
    if (!type || !type.is_active) {
      throw new MemberCreationError(
        `${selected.name} is no longer available to open. Ask an ` +
          'administrator before approving this application.'
      );
    }
    // Checked here, not left to next_customer_account_number's own refusal,
    // so a missing prefix is named against the type an administrator needs
    // to fix rather than surfacing as a database error to whoever approves.
    if (!type.number_prefix?.trim()) {
      throw new MemberCreationError(
        `${selected.name} has no account numbering set. Set one in ` +
          'Configuration → Account types before approving.'
      );
    }
  }

  const customer = await client.query<{ id: string }>(
    `insert into customer (application_id) values ($1) returning id`,
    [application.id]
  );
  const customerId = customer.rows[0].id;

  const accounts: CreatedMember['accounts'] = [];
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id)!;
    const numbered = await client.query<{ account_no: string }>(
      `select next_customer_account_number($1) as account_no`,
      [type.id]
    );
    const accountNo = numbered.rows[0].account_no;

    const account = await client.query<{ id: string }>(
      `insert into account
         (customer_id, account_type_id, account_no, is_membership_default,
          status)
       values ($1, $2, $3, false, $4)
       returning id`,
      [customerId, type.id, accountNo, type.default_status]
    );
    accounts.push({
      id: account.rows[0].id,
      typeCode: type.code,
      typeName: type.name,
      accountNo,
    });
  }

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'customer.created',
      entityType: 'customer',
      entityId: customerId,
      newValue: { fromApplication: application.reference },
    },
    client
  );

  // One entry per account, the same reason the other two creation paths
  // above audit each one separately: they opened together, but each is its
  // own thing to answer for.
  for (const account of accounts) {
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'account.opened',
        entityType: 'account',
        entityId: account.id,
        newValue: {
          accountNo: account.accountNo,
          accountType: account.typeCode,
          openedBecause: 'customer-account application approved',
        },
      },
      client
    );
  }

  return { id: customerId, memberNo: '', accounts };
}

export interface MemberSummary {
  id: string;
  // S-614: a customer never was, and never becomes, a member — kept in the
  // same list because an officer looking someone up does not know in
  // advance which one they are, but always tagged so the two are never
  // mistaken for each other.
  kind: 'member' | 'customer';
  // A member's own AB number. A customer has none of their own — this is
  // their held account number(s) instead (comma-joined; empty if none has
  // opened yet, which openAccountsForCustomerApplication never actually
  // leaves true, but nothing stops a read the instant after approval).
  memberNo: string;
  // A member's own membership type. For a customer, the account type(s)
  // they hold instead — there is no membership type to name.
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

  // S-614: a customer (never a member — customer table, migration 0027)
  // appears in the same list, tagged, since an officer searching by name or
  // number does not know in advance which one they are looking for. Unioned
  // rather than two separate lists, so one search and one page of results
  // covers both.
  const result = await query<{
    id: string;
    kind: 'member' | 'customer';
    identifier: string;
    type_label: string;
    status: string;
    name: string;
    joined_at: Date;
    application_reference: string | null;
    total_count: string;
  }>(
    `with rows as (
       select m.id, 'member'::text as kind, m.member_no as identifier,
              t.name as type_label, m.status,
              ${NAME_SQL} as name, m.joined_at,
              a.reference as application_reference
         from member m
         join membership_type t on t.id = m.membership_type_id
         left join membership_application a on a.id = m.application_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
       union all
       select c.id, 'customer'::text as kind,
              coalesce(
                (select string_agg(acc.account_no, ', '
                          order by act.sort_order, acc.account_no)
                   from account acc
                   join account_type act on act.id = acc.account_type_id
                  where acc.customer_id = c.id),
                ''
              ) as identifier,
              coalesce(
                (select string_agg(distinct act.name, ' + ' order by act.name)
                   from account acc
                   join account_type act on act.id = acc.account_type_id
                  where acc.customer_id = c.id),
                ''
              ) as type_label,
              c.status,
              ${NAME_SQL} as name, c.joined_at,
              capp.reference as application_reference
         from customer c
         join membership_application capp on capp.id = c.application_id
         left join application_party p
           on p.application_id = c.application_id
          and p.subject = 'applicant' and p.ordinal = 1
     )
     select id, kind, identifier, type_label, status, name, joined_at,
            application_reference,
            count(*) over () as total_count
       from rows
      where $1::text is null
         or strpos(lower(identifier), lower($1::text)) > 0
         or strpos(lower(name), lower($1::text)) > 0
      order by identifier
      limit $2::int`,
    [search, limit]
  );

  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

  return {
    members: result.rows.map(r => ({
      id: r.id,
      kind: r.kind,
      memberNo: r.identifier,
      membershipTypeName: r.type_label,
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
    kind: 'member',
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

export interface CustomerAccount {
  id: string;
  // Unlike a member's, a customer's own — each carries its own number
  // (migration 0027), since there is no shared number to lean on.
  accountNo: string;
  accountTypeName: string;
  category: string;
  status: string;
  openedAt: Date;
}

export interface CustomerDetail {
  id: string;
  kind: 'customer';
  status: string;
  name: string;
  joinedAt: Date;
  applicationReference: string | null;
  applicationId: string;
  applicantValues: Record<string, string>;
  accounts: CustomerAccount[];
}

// S-614 · A customer and their accounts — the counterpart to loadMember
// above, for someone who was never a member to begin with. Read separately
// rather than folded into loadMember: the two tables share no primary key
// space to look up by id across, and the shapes differ (no member_no, no
// membership type) enough that a single function returning either would
// have to branch on every field anyway.
export async function loadCustomer(id: string): Promise<CustomerDetail | null> {
  const result = await query<{
    id: string;
    status: string;
    name: string;
    joined_at: Date;
    application_reference: string;
    application_id: string;
    applicant_values: Record<string, string> | null;
  }>(
    `select c.id, c.status, ${NAME_SQL} as name, c.joined_at,
            capp.reference as application_reference, c.application_id,
            p.values as applicant_values
       from customer c
       join membership_application capp on capp.id = c.application_id
       left join application_party p
         on p.application_id = c.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where c.id = $1`,
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
    opened_at: Date;
  }>(
    `select a.id, a.account_no, t.name as account_type_name, t.category,
            a.status, a.opened_at
       from account a
       join account_type t on t.id = a.account_type_id
      where a.customer_id = $1
      order by t.sort_order, t.name`,
    [id]
  );

  return {
    id: row.id,
    kind: 'customer',
    status: row.status,
    name: row.name || '(unnamed)',
    joinedAt: row.joined_at,
    applicationReference: row.application_reference,
    applicationId: row.application_id,
    applicantValues: row.applicant_values ?? {},
    accounts: accounts.rows.map(a => ({
      id: a.id,
      accountNo: a.account_no,
      accountTypeName: a.account_type_name,
      category: a.category,
      status: a.status,
      openedAt: a.opened_at,
    })),
  };
}
