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
import { postOpeningBalances } from '../ledger/ledger';
import { PAGE_SIZES } from '../paging';
import { canOpenAccount } from './status';
import type {
  Actor,
  Application,
  MembershipApplication,
} from '../applications/capture';

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
    // M26: brought back under its own number rather than opened.
    reopened?: boolean;
  }[];
  // M26: an existing member re-admitted, not a new one created.
  rejoined?: boolean;
  // Who they are, for the approval page to name them (lifecycle test).
  name?: string;
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
  actor: Actor,
  // M7 migration only: the AB number this member already carries in the
  // legacy register, rather than the next one off member_number_seq — an
  // ordinary approval never passes this, so it keeps assigning the next
  // number exactly as before. viaMigration marks the Shares/MSA accounts
  // opened below as migrated rather than opened (opened_via_migration,
  // migration 0050) — the member/customer page's own "migrated on" vs.
  // "opened" wording.
  options?: { memberNo?: string; viaMigration?: boolean }
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

  // M26 · A rejoin: the application names the resigned member it re-admits.
  // They come back as the member they were — same row, same AB number —
  // rather than as a second member with a second number, which is the
  // whole point of naming them. The Shares and MSA the resignation closed
  // are reactivated below under their own ids, so their history reads as
  // one account that closed and reopened.
  if (application.rejoinsMemberId) {
    return rejoinMember(client, application, actor);
  }

  const member = options?.memberNo
    ? await client.query<{ id: string; member_no: string }>(
        `insert into member (application_id, membership_type_id, member_no)
         values ($1, $2, $3)
         returning id, member_no`,
        [application.id, application.membershipTypeId, options.memberNo]
      )
    : await client.query<{ id: string; member_no: string }>(
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
      `insert into account
         (member_id, account_type_id, is_membership_default, status,
          opened_by_application_id, opened_via_migration)
       values ($1, $2, true, $3, $4, $5)
       returning id`,
      [
        memberId,
        type.id,
        type.default_status,
        application.id,
        options?.viaMigration ?? false,
      ]
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

  // S-614: this application was started from an existing non-member
  // (startMembershipApplicationFromCustomer) — whatever account(s) they
  // already held move to the member they now are, rather than being left
  // behind under a customer record nobody reaches from here on. Read fresh,
  // not trusted from capture time, the same reason the account types
  // opened above are (S-206): an administrator may have changed something
  // since.
  if (application.sourceCustomerId) {
    const held = await client.query<{
      id: string;
      account_type_id: string;
      code: string;
      name: string;
    }>(
      `select a.id, a.account_type_id, t.code, t.name
         from account a
         join account_type t on t.id = a.account_type_id
        where a.customer_id = $1`,
      [application.sourceCustomerId]
    );

    // Refused here, one at a time, rather than left to
    // account_one_per_type_per_member_idx (migration 0018) to turn a
    // collision into an opaque constraint violation — not expected in
    // practice (a customer never holds a membership-default type to begin
    // with, S-614), but a type reconfigured since is not this function's
    // to guess about.
    const alreadyHeld = new Set(accounts.map(a => a.typeCode));
    for (const row of held.rows) {
      if (alreadyHeld.has(row.code)) {
        throw new MemberCreationError(
          `${row.name} is opened for every new membership, and this member ` +
            'already held one as a customer. Resolve which one stands ' +
            'before approving.'
        );
      }
    }

    for (const row of held.rows) {
      // opened_by_application_id and account_no are both deliberately left
      // out of this SET list. opened_by_application_id already names the
      // customer_account application that actually funded this account
      // (openAccountsForCustomerApplication set it at creation), and that
      // answer does not change just because who holds the account now does
      // — transactionsForAccount and listMembers' own total_funds figure
      // both read it straight through the transfer. account_no is the same
      // story for the number itself: officer feedback — this used to be
      // cleared here, so HSA0001 read as the member's own AB0002 once
      // transferred, as if a new account had been issued rather than an
      // existing one carried over. Keeping it is what "carried over" means
      // (account_owner_shape, migration 0038, widened to allow a
      // member-owned account to still carry one).
      await client.query(
        `update account
            set member_id = $2, customer_id = null,
                is_membership_default = false
          where id = $1`,
        [row.id, memberId]
      );
      accounts.push({ id: row.id, typeCode: row.code, typeName: row.name });

      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.email,
          action: 'account.transferred',
          entityType: 'account',
          entityId: row.id,
          newValue: {
            memberNo,
            accountType: row.code,
            transferredBecause: 'customer became a member',
          },
        },
        client
      );
    }

    await client.query(
      `update customer set status = 'converted' where id = $1`,
      [application.sourceCustomerId]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'customer.converted',
        entityType: 'customer',
        entityId: application.sourceCustomerId,
        newValue: { becameMemberNo: memberNo },
      },
      client
    );
  }

  // S-1303: what the application's receipts paid into these accounts is
  // their opening balance, posted through the engine now that the accounts
  // exist. Nothing to carry — an import that records its balance after this
  // returns, an application paid nothing — posts nothing, and the next
  // caller with something to carry does it.
  await postOpeningBalances(
    application.id,
    { userId: actor.userId, description: actor.email },
    client
  );
  return { id: memberId, memberNo, accounts };
}

/**
 * M7 migration only: open one additional account type (HSA, Investment, …)
 * directly for a member or a customer the same row's own import just
 * created or already found on file — exactly one of owner.memberId /
 * owner.customerId, the same shape account_owner_shape has always required.
 *
 * Unlike openAccountsForApplication (S-613), which never gives a member's
 * own additional account a number of its own, this one carries the legacy
 * register's own number for the account — an officer feedback correction:
 * the legacy register numbered HSA/Investment accounts independently of the
 * member's own AB number, member or not, and that number is what staff
 * still know the account by. The same shape account_owner_shape already
 * allows a member-owned account to carry (migration 0038, for an account
 * carried over from the customer a member used to be) — this is that same
 * shape, reused for one carried over from the legacy register instead.
 * Required (never null) for a customer-owned account, same as
 * account_owner_shape enforces for every other customer account.
 *
 * opened_by_application_id names the migration's own application, since
 * there is no separate additional_account/customer_account application
 * here to point at.
 */
export async function openMigrationAccount(
  client: PoolClient,
  owner: { memberId: string } | { customerId: string },
  applicationId: string,
  accountNo: string | null,
  type: { id: string; code: string; name: string; defaultStatus: string },
  actor: Actor
): Promise<{ id: string; typeCode: string; typeName: string }> {
  const account = await client.query<{ id: string }>(
    `insert into account
       (member_id, customer_id, account_type_id, account_no,
        is_membership_default, status, opened_by_application_id,
        opened_via_migration)
     values ($1, $2, $3, $4, false, $5, $6, true)
     returning id`,
    [
      'memberId' in owner ? owner.memberId : null,
      'customerId' in owner ? owner.customerId : null,
      type.id,
      accountNo,
      type.defaultStatus,
      applicationId,
    ]
  );

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'account.opened',
      entityType: 'account',
      entityId: account.rows[0].id,
      newValue: {
        accountType: type.code,
        accountNo,
        openedBecause: 'legacy migration',
      },
    },
    client
  );

  return { id: account.rows[0].id, typeCode: type.code, typeName: type.name };
}

/**
 * M7 migration only: the customer_account counterpart to
 * createMemberFromApplication above. Someone whose only legacy accounts are
 * HSA/Investment — never Shares, never the MSA — was never a Member
 * (S-614's own member/customer distinction), and gets a bare `customer` row
 * instead, tied to the same migration application their captured details
 * (application_party) already live against.
 */
export async function createMigratedCustomer(
  client: PoolClient,
  applicationId: string
): Promise<{ id: string }> {
  const customer = await client.query<{ id: string }>(
    `insert into customer (application_id) values ($1) returning id`,
    [applicationId]
  );
  return { id: customer.rows[0].id };
}

// M26 · Which of a member's accounts of the given types stand closed, so
// approval reactivates them rather than opening a second one — the unique
// index (account_one_per_type_per_member_idx) ignores closed rows, so a
// second row of the type would be allowed, and the member would then hold
// two of one type, one of them the old number nobody could reach.
async function closedAccountsOf(
  client: PoolClient,
  owner: { memberId: string } | { customerId: string },
  accountTypeIds: string[]
): Promise<Map<string, string>> {
  const closed = await client.query<{ id: string; account_type_id: string }>(
    'memberId' in owner
      ? `select id, account_type_id from account
          where member_id = $1 and account_type_id = any($2::uuid[])
            and status = 'closed'
          order by closed_at desc`
      : `select id, account_type_id from account
          where customer_id = $1 and account_type_id = any($2::uuid[])
            and status = 'closed'
          order by closed_at desc`,
    ['memberId' in owner ? owner.memberId : owner.customerId, accountTypeIds]
  );
  const byType = new Map<string, string>();
  for (const row of closed.rows) {
    if (!byType.has(row.account_type_id))
      byType.set(row.account_type_id, row.id);
  }
  return byType;
}

// M26 · Bring a closed account back under its own id and number, dated so
// the page can say "reopened on". The balance is whatever the ledger says
// it is — a closure paid it out, so it stands at nil until the opening
// receipt posts.
async function reopenClosedAccount(
  client: PoolClient,
  accountId: string,
  status: string,
  applicationId: string
): Promise<void> {
  await client.query(
    `update account
        set status = $2, closed_at = null, reopened_at = now(),
            opened_by_application_id = $3, updated_at = now()
      where id = $1 and status = 'closed'`,
    [accountId, status, applicationId]
  );
}

/**
 * M26 · Re-admit a resigned member on the approval of the membership
 * application that names them (rejoins_member_id).
 *
 * The member row is the one they always had: status back to active,
 * rejoined_at set, and the application that brought them back recorded as
 * theirs. Their Shares and MSA — closed by the resignation — are
 * reactivated under their own ids; a membership-default type they never
 * held (one configured since they left) opens fresh, as it would on any
 * approval. The application keeps its APP reference: the AB number already
 * belongs to the founding application, and one reference cannot name two.
 */
async function rejoinMember(
  client: PoolClient,
  application: MembershipApplication,
  actor: Actor
): Promise<CreatedMember> {
  const member = await client.query<{ member_no: string; status: string }>(
    `select member_no, status from member where id = $1 for no key update`,
    [application.rejoinsMemberId]
  );
  if (member.rowCount === 0) {
    throw new MemberCreationError('That member no longer exists.');
  }
  if (member.rows[0].status !== 'resigned') {
    throw new MemberCreationError(
      'This member is not resigned, so there is no membership to rejoin.'
    );
  }
  const memberId = application.rejoinsMemberId!;
  const memberNo = member.rows[0].member_no;

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
    throw new MemberCreationError(
      'No active account type is set to open when a membership is approved, ' +
        'so there is no account to open. Set one in Configuration → Account ' +
        'types before approving.'
    );
  }

  await client.query(
    `update member
        set status = 'active', status_changed_at = now(), rejoined_at = now(),
            application_id = $2, membership_type_id = $3, updated_at = now()
      where id = $1`,
    [memberId, application.id, application.membershipTypeId]
  );

  const closed = await closedAccountsOf(
    client,
    { memberId },
    openOnApproval.rows.map(t => t.id)
  );
  const accounts: CreatedMember['accounts'] = [];
  const reopened = new Set<string>();
  for (const type of openOnApproval.rows) {
    const existing = closed.get(type.id);
    if (existing) {
      await reopenClosedAccount(
        client,
        existing,
        type.default_status,
        application.id
      );
      reopened.add(existing);
      accounts.push({
        id: existing,
        typeCode: type.code,
        typeName: type.name,
        reopened: true,
      });
      continue;
    }
    const account = await client.query<{ id: string }>(
      `insert into account
         (member_id, account_type_id, is_membership_default, status,
          opened_by_application_id)
       values ($1, $2, true, $3, $4)
       returning id`,
      [memberId, type.id, type.default_status, application.id]
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
      action: 'member.rejoined',
      entityType: 'member',
      entityId: memberId,
      previousValue: { status: 'resigned' },
      newValue: {
        status: 'active',
        memberNo,
        fromApplication: application.reference,
        membershipType: application.membershipTypeCode,
      },
    },
    client
  );
  for (const account of accounts) {
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: reopened.has(account.id)
          ? 'account.reopened'
          : 'account.opened',
        entityType: 'account',
        entityId: account.id,
        newValue: {
          memberNo,
          accountType: account.typeCode,
          openedBecause: 'membership rejoined',
        },
      },
      client
    );
  }

  await postOpeningBalances(
    application.id,
    { userId: actor.userId, description: actor.email },
    client
  );
  return { id: memberId, memberNo, accounts, rejoined: true };
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

  // An additional account names either a member or a customer as its holder
  // (migration 0051). A customer's account is opened under the customer, with
  // its own number, exactly as their first one was — never turning them into
  // a member.
  if (application.existingCustomerId) {
    return openAccountsUnderCustomer(client, application, actor);
  }

  const member = await client.query<{ member_no: string; status: string }>(
    `select member_no, status from member where id = $1 for no key update`,
    [application.existingMemberId]
  );
  if (member.rowCount === 0) {
    throw new MemberCreationError('That member no longer exists.');
  }
  if (!canOpenAccount(member.rows[0].status)) {
    throw new MemberCreationError(
      `This member is ${member.rows[0].status}, so no account can be opened for them.`
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
    // An additional account carries its own number (HSA0001, INV0001-style),
    // not the member's — the same as a non-member's, and the same numbering
    // (openAccountsUnderCustomer). Only Shares and the MSA, opened on a
    // membership's own approval, share the member's number; those never come
    // through here. So a type with no prefix set cannot be numbered and must
    // not be opened, exactly as for a customer.
    if (!type.number_prefix?.trim()) {
      throw new MemberCreationError(
        `${selected.name} has no account numbering set. Set one in ` +
          'Configuration → Account types before approving.'
      );
    }
  }

  // Refused here, one at a time, rather than left to the database's own
  // unique index (account_one_per_type_per_member_idx, migration 0018) to
  // turn a second HSA into an opaque constraint violation for whoever
  // approves this.
  // A closed one does not count (M26): it is exactly what this application
  // reopens, below, under its own number.
  const already = await client.query<{ name: string }>(
    `select t.name
       from account a
       join account_type t on t.id = a.account_type_id
      where a.member_id = $1 and a.account_type_id = any($2::uuid[])
        and a.status <> 'closed'`,
    [application.existingMemberId, typeIds]
  );
  if ((already.rowCount ?? 0) > 0) {
    throw new MemberCreationError(
      `${memberNo} already has ${already.rows.map(r => r.name).join(', ')} open.`
    );
  }

  // M26 · A closed account of a selected type comes back as itself — the
  // HSA0001 they had, not an HSA0002 beside a dead HSA0001 — dated so the
  // page can say so.
  const closed = await closedAccountsOf(
    client,
    { memberId: application.existingMemberId! },
    typeIds
  );
  const accounts: CreatedMember['accounts'] = [];
  const reopened = new Set<string>();
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id)!;
    const existing = closed.get(type.id);
    if (existing) {
      await reopenClosedAccount(
        client,
        existing,
        type.default_status,
        application.id
      );
      const number = await client.query<{ account_no: string }>(
        `select account_no from account where id = $1`,
        [existing]
      );
      reopened.add(existing);
      accounts.push({
        id: existing,
        typeCode: type.code,
        typeName: type.name,
        accountNo: number.rows[0].account_no,
        reopened: true,
      });
      continue;
    }
    // Its own number, from the same per-type counter a non-member's account
    // draws from (next_customer_account_number) — a member's HSA and a
    // customer's HSA are numbered from one sequence, and account_no_unique_idx
    // keeps them from colliding. account_owner_shape (migration 0038) allows a
    // member-owned account to carry a number of its own.
    const numbered = await client.query<{ account_no: string }>(
      `select next_customer_account_number($1) as account_no`,
      [type.id]
    );
    const accountNo = numbered.rows[0].account_no;

    const account = await client.query<{ id: string }>(
      `insert into account
         (member_id, account_type_id, account_no, is_membership_default,
          status, opened_by_application_id)
       values ($1, $2, $3, false, $4, $5)
       returning id`,
      [
        application.existingMemberId,
        type.id,
        accountNo,
        type.default_status,
        application.id,
      ]
    );
    accounts.push({
      id: account.rows[0].id,
      typeCode: type.code,
      typeName: type.name,
      accountNo,
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
        action: reopened.has(account.id)
          ? 'account.reopened'
          : 'account.opened',
        entityType: 'account',
        entityId: account.id,
        newValue: {
          memberNo,
          accountNo: account.accountNo,
          accountType: account.typeCode,
          openedBecause: 'additional-account application approved',
        },
      },
      client
    );
  }

  // Narrowed above: the customer branch returned early, so a member owns this.
  // S-1303: what the application's receipts paid into these accounts is
  // their opening balance, posted through the engine now that the accounts
  // exist. Nothing to carry — an import that records its balance after this
  // returns, an application paid nothing — posts nothing, and the next
  // caller with something to carry does it.
  await postOpeningBalances(
    application.id,
    { userId: actor.userId, description: actor.email },
    client
  );
  return { id: application.existingMemberId!, memberNo, accounts };
}

/**
 * Open an additional account under an EXISTING customer (migration 0051).
 *
 * The customer counterpart of the member path above, and it mirrors
 * openAccountsForCustomerApplication's numbering (HSA0002, INV0001-style, from
 * account_type.number_prefix) — the one difference being that the customer
 * already exists, so no `customer` row is created here; the account is opened
 * under the one this application names.
 */
async function openAccountsUnderCustomer(
  client: PoolClient,
  application: Application,
  actor: Actor
): Promise<CreatedMember> {
  if (
    application.applicationKind !== 'additional_account' ||
    !application.existingCustomerId
  ) {
    throw new MemberCreationError(
      'This application does not open an account for an existing customer.'
    );
  }
  const customerId = application.existingCustomerId;

  const customer = await client.query<{
    status: string;
    name: string;
  }>(
    `select c.status,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as name
       from customer c
       left join application_party p
         on p.application_id = c.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where c.id = $1 for no key update of c`,
    [customerId]
  );
  if (customer.rowCount === 0) {
    throw new MemberCreationError('That customer no longer exists.');
  }
  // A customer whose every account was closed ('closed') may open a new one,
  // and is active again once it opens (below).
  if (!['active', 'closed'].includes(customer.rows[0].status)) {
    throw new MemberCreationError(
      'This customer is no longer active, so no account can be opened for them.'
    );
  }
  if (customer.rows[0].status === 'closed') {
    await client.query(
      `update customer set status = 'active', updated_at = now()
        where id = $1 and status = 'closed'`,
      [customerId]
    );
  }
  const label = customer.rows[0].name?.trim() || 'the customer';

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
    if (!type.number_prefix?.trim()) {
      throw new MemberCreationError(
        `${selected.name} has no account numbering set. Set one in ` +
          'Configuration → Account types before approving.'
      );
    }
  }

  // Named here, one at a time, rather than left to
  // account_one_per_type_per_customer_idx (migration 0027) to turn a second
  // account of the same type into an opaque constraint violation.
  const already = await client.query<{ name: string }>(
    `select t.name
       from account a
       join account_type t on t.id = a.account_type_id
      where a.customer_id = $1 and a.account_type_id = any($2::uuid[])
        and a.status <> 'closed'`,
    [customerId, typeIds]
  );
  if ((already.rowCount ?? 0) > 0) {
    throw new MemberCreationError(
      `${label} already holds ${already.rows.map(r => r.name).join(', ')}.`
    );
  }

  // M26: a closed one of the type comes back as itself, as for a member.
  const closed = await closedAccountsOf(client, { customerId }, typeIds);
  const accounts: CreatedMember['accounts'] = [];
  const reopened = new Set<string>();
  for (const selected of application.selectedAccountTypes) {
    const type = byId.get(selected.id)!;
    const existing = closed.get(type.id);
    if (existing) {
      await reopenClosedAccount(
        client,
        existing,
        type.default_status,
        application.id
      );
      const number = await client.query<{ account_no: string }>(
        `select account_no from account where id = $1`,
        [existing]
      );
      reopened.add(existing);
      accounts.push({
        id: existing,
        typeCode: type.code,
        typeName: type.name,
        accountNo: number.rows[0].account_no,
        reopened: true,
      });
      continue;
    }
    const numbered = await client.query<{ account_no: string }>(
      `select next_customer_account_number($1) as account_no`,
      [type.id]
    );
    const accountNo = numbered.rows[0].account_no;

    const account = await client.query<{ id: string }>(
      `insert into account
         (customer_id, account_type_id, account_no, is_membership_default,
          status, opened_by_application_id)
       values ($1, $2, $3, false, $4, $5)
       returning id`,
      [customerId, type.id, accountNo, type.default_status, application.id]
    );
    accounts.push({
      id: account.rows[0].id,
      typeCode: type.code,
      typeName: type.name,
      accountNo,
    });
  }

  for (const account of accounts) {
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: reopened.has(account.id)
          ? 'account.reopened'
          : 'account.opened',
        entityType: 'account',
        entityId: account.id,
        newValue: {
          customerAccountNo: account.accountNo,
          accountType: account.typeCode,
          openedBecause: 'additional-account application approved (customer)',
        },
      },
      client
    );
  }

  // S-1303: what the application's receipts paid into these accounts is
  // their opening balance, posted through the engine now that the accounts
  // exist. Nothing to carry — an import that records its balance after this
  // returns, an application paid nothing — posts nothing, and the next
  // caller with something to carry does it.
  await postOpeningBalances(
    application.id,
    { userId: actor.userId, description: actor.email },
    client
  );
  return { id: customerId, memberNo: label, accounts };
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
          status, opened_by_application_id)
       values ($1, $2, $3, false, $4, $5)
       returning id`,
      [customerId, type.id, accountNo, type.default_status, application.id]
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

  // S-1303: what the application's receipts paid into these accounts is
  // their opening balance, posted through the engine now that the accounts
  // exist. Nothing to carry — an import that records its balance after this
  // returns, an application paid nothing — posts nothing, and the next
  // caller with something to carry does it.
  await postOpeningBalances(
    application.id,
    { userId: actor.userId, description: actor.email },
    client
  );
  return { id: customerId, memberNo: '', accounts };
}

// One button in the Members list's own last column — officer feedback:
// the account's number, styled by what kind of account it is (accountButtonClasses
// in members/index.astro), rather than a plain id column up front.
export interface MemberListAccount {
  id: string;
  code: string;
  name: string;
  // A member's accounts all carry the member's own number (S-309); a
  // customer's each carry their own (S-614) — identifier already differs
  // per row above for the same reason, this is that same value per account.
  no: string;
  // Officer feedback: the closing balance shown in the account's dialog on
  // this list, from the same ledger cache total_funds sums above.
  balance: string;
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
  // When the status last moved (S-1701); null while it never has.
  statusChangedAt: Date | null;
  name: string;
  joinedAt: Date;
  applicationReference: string | null;
}

export interface MemberAccount {
  id: string;
  // The member's number. Both of a member's accounts carry it, which is why it
  // is read from the member rather than stored on the account.
  accountNo: string;
  accountTypeId: string;
  accountTypeName: string;
  category: string;
  status: string;
  isMembershipDefault: boolean;
  openedAt: Date;
  // Officer feedback: "migrated on", not "opened", for one the legacy
  // import created (opened_via_migration, migration 0050) — a further
  // account this member goes on to open live afterwards still reads
  // "opened".
  openedViaMigration: boolean;
  // M26: when it closed, while it stands closed; when it last came back.
  closedAt: Date | null;
  reopenedAt: Date | null;
}

export interface MemberDetail extends MemberSummary {
  accounts: MemberAccount[];
  // M26: when a resigned membership was last re-admitted; null for one
  // that never left.
  rejoinedAt: Date | null;
  // The membership type's own code (individual, corporate, minor) — the
  // detail page tags a minor from this, where the name alone would not
  // survive an administrator renaming the type.
  membershipTypeCode: string;
  // The membership type's id — the detail page uses it to work out which
  // further account types this member may still open (account-type
  // eligibility, migration 0040).
  membershipTypeId: string;
  applicantValues: Record<string, string>;
  // Null for a legacy record imported in M7, which has no application here.
  applicationId: string | null;
  // The officer — a Regional Officer, per the FRD's capture step — who
  // captured the founding application. Null alongside applicationId for a
  // legacy M7 record, which has no capturing officer to name.
  capturedByName: string | null;
}

// The name is assembled from the application's applicant party, because what
// counts as a name differs by membership type: an Individual has a surname and
// a name, a Corporate entity has one registered name.
const NAME_SQL = `
  trim(coalesce(p.values->>'name', '') || ' ' || coalesce(p.values->>'surname', ''))
`;

// Officer pagination (src/lib/paging.ts): the largest of the 10/25/50 an
// officer may choose, and the cap this list refuses to hand back more of
// regardless of what is asked — the page reads its own limit/offset from
// pagingFrom rather than this.
export const MEMBER_LIST_PAGE_SIZE = Math.max(...PAGE_SIZES);

// Status filter (officer request): the values the Members page's own
// status <select> may send, matching exactly what the Status column shows
// (shownStatus/isNonMember, status.ts) rather than the raw stored status —
// 'active' and 'non_member' both span more than one stored status, and
// 'resigned' here means only a resigned member with nothing left open (one
// still holding an account is counted under 'active'/'non_member' instead,
// same as the column reads them).
export type MemberListStatusFilter =
  | ''
  | 'active'
  | 'dormant'
  | 'inactive'
  | 'resigned'
  | 'demised'
  | 'non_member'
  | 'closed';

const MEMBER_LIST_STATUS_FILTERS = new Set<string>([
  'active',
  'dormant',
  'inactive',
  'resigned',
  'demised',
  'non_member',
  'closed',
]);

export async function listMembers(
  options: {
    search?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const search = options.search?.trim() ? options.search.trim() : null;
  // Anything not one of the select's own values is treated as no filter,
  // the same forgiving handling pagingFrom gives an out-of-range page.
  const status = MEMBER_LIST_STATUS_FILTERS.has(options.status ?? '')
    ? (options.status as MemberListStatusFilter)
    : null;
  const limit = Math.min(
    Math.max(options.limit ?? MEMBER_LIST_PAGE_SIZE, 1),
    MEMBER_LIST_PAGE_SIZE
  );
  const offset = Math.max(options.offset ?? 0, 0);

  // S-614: a customer (never a member — customer table, migration 0027)
  // appears in the same list, tagged, since an officer searching by name or
  // number does not know in advance which one they are looking for. Unioned
  // rather than two separate lists, so one search and one page of results
  // covers both.
  //
  // Performance QA: the accounts and balances of every member used to be
  // gathered before the list was cut to its first 100 — at 5,000 members,
  // a third of a second per visit and six seconds under load. The rows are
  // now filtered, counted, ordered and paged on what is cheap (who they are,
  // whether anything of theirs is open), and the accounts and balances are
  // gathered for the one page actually shown.
  const result = await query<{
    id: string;
    kind: 'member' | 'customer';
    identifier: string;
    type_label: string;
    status: string;
    status_changed_at: Date | null;
    name: string;
    joined_at: Date;
    application_reference: string | null;
    accounts: MemberListAccount[];
    total_funds: string;
    non_member: boolean;
    total_count: string;
    member_count: string;
    non_member_count: string;
  }>(
    `with rows as (
       select m.id, 'member'::text as kind, m.member_no as identifier,
              t.name as type_label, m.status, m.status_changed_at,
              ${NAME_SQL} as name, m.joined_at,
              a.reference as application_reference,
              -- Officer feedback: a closed account (a closure, or the
              -- Shares and MSA a resignation closed) is no longer something
              -- they hold.
              exists (
                select 1 from account acc
                 where acc.member_id = m.id and acc.status <> 'closed'
              ) as has_open
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
              c.status, null::timestamptz as status_changed_at,
              ${NAME_SQL} as name, c.joined_at,
              capp.reference as application_reference,
              exists (
                select 1 from account acc
                 where acc.customer_id = c.id and acc.status <> 'closed'
              ) as has_open
         from customer c
         join membership_application capp on capp.id = c.application_id
         left join application_party p
           on p.application_id = c.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        -- A converted customer (S-614: approved to become a member) is not a
        -- second record alongside the member they became — their account(s)
        -- already moved (createMemberFromApplication), leaving nothing here
        -- but an empty row with the same name that would otherwise sit
        -- beside the real one. A customer whose every account is closed
        -- stays listed (counted as former).
        where c.status in ('active', 'closed')
     ),
     page as (
       select rows.*,
              -- LC-10/officer direction: a non-member is a customer, or a
              -- resigned member, still holding an account that is not
              -- closed — one with nothing open has nothing left to deal on
              -- and is "former" instead (counted below, never tagged).
              ((kind = 'customer' or status = 'resigned') and has_open)
                as non_member,
              count(*) over () as total_count,
              -- LC-10: the header splits the total three ways — members
              -- (holding their membership open), non-members (see above),
              -- and former (nothing open, membership or account). A resigned
              -- or demised member is never counted as a member here. Counted
              -- after the search filter, so the three always add up to the
              -- total the list is showing.
              count(*) filter (
                where kind = 'member' and status not in ('resigned', 'demised')
              ) over () as member_count,
              count(*) filter (
                where (kind = 'customer' or status = 'resigned') and has_open
              ) over () as non_member_count
         from rows
        where ($1::text is null
               or strpos(lower(identifier), lower($1::text)) > 0
               or strpos(lower(name), lower($1::text)) > 0)
          -- The status filter, in has_open/status/kind rather than the
          -- non_member alias above (a WHERE here cannot see it): each arm
          -- matches one option of the Members page's own <select>, in the
          -- same terms shownStatus/isNonMember (status.ts) use for the
          -- Status column, so a filter and what the column shows never
          -- disagree.
          and ($4::text is null
               or ($4::text = 'active'
                   -- A customer's own status is 'active' too (a different
                   -- column, the same word) — kind = 'member' keeps this
                   -- arm to an actually-active membership, not a customer.
                   and ((kind = 'member' and status = 'active')
                        or (status = 'resigned' and has_open)))
               or ($4::text = 'dormant' and status = 'dormant')
               or ($4::text = 'inactive' and status = 'inactive')
               or ($4::text = 'resigned' and status = 'resigned' and not has_open)
               or ($4::text = 'demised' and status = 'demised')
               or ($4::text = 'non_member'
                   and (kind = 'customer' or status = 'resigned') and has_open)
               or ($4::text = 'closed' and kind = 'customer' and status = 'closed'))
        order by identifier
        limit $2::int offset $3::int
     )
     select page.id, page.kind, page.identifier, page.type_label,
            page.status, page.status_changed_at, page.name, page.joined_at,
            page.application_reference, page.non_member, page.total_count,
            page.member_count, page.non_member_count,
            coalesce(
              (select json_agg(json_build_object(
                         'id', acc.id, 'code', act.code, 'name', act.name,
                         -- A Shares or MSA account carries no number of its
                         -- own (migration 0018) and shows the member's — but
                         -- one carried over from the non-member customer this
                         -- member used to be (S-614) keeps its own
                         -- HSA0001-style number (account_owner_shape,
                         -- migration 0038). A customer's always has one.
                         'no', coalesce(acc.account_no, page.identifier),
                         'balance', coalesce(b.balance, 0)::numeric(14,2)::text
                       ) order by act.sort_order, act.name)
                 from account acc
                 join account_type act on act.id = acc.account_type_id
                 left join account_balance b on b.account_id = acc.id
                where (acc.member_id = page.id or acc.customer_id = page.id)
                  and acc.status <> 'closed'),
              '[]'
            ) as accounts,
            -- Officer feedback: what they actually have in the Society —
            -- every account of theirs, whichever application opened it and
            -- whether it came with them from the customer they used to be
            -- (S-614), summed from the ledger's own balance cache
            -- (docs/ledger.md). Never Entrance, the processing fee or
            -- Takaful: one-time charges with no account behind them.
            coalesce(
              (select sum(b.balance)
                 from account acc
                 join account_balance b on b.account_id = acc.id
                where acc.member_id = page.id or acc.customer_id = page.id),
              0
            )::numeric(14,2)::text as total_funds
       from page
      order by page.identifier`,
    [search, limit, offset, status]
  );

  const first = result.rows[0];
  const total = first ? Number(first.total_count) : 0;
  const memberCount = first ? Number(first.member_count) : 0;
  const nonMemberCount = first ? Number(first.non_member_count) : 0;
  // LC-10: everyone neither a member nor a non-member — a resigned or
  // demised member with nothing open, or a customer with nothing open.
  const formerCount = total - memberCount - nonMemberCount;

  return {
    members: result.rows.map(r => ({
      id: r.id,
      kind: r.kind,
      memberNo: r.identifier,
      membershipTypeName: r.type_label,
      status: r.status,
      statusChangedAt: r.status_changed_at,
      name: r.name || '(unnamed)',
      joinedAt: r.joined_at,
      applicationReference: r.application_reference,
      accountBadges: r.accounts ?? [],
      nonMember: r.non_member,
      totalFunds: r.total_funds,
    })),
    total,
    memberCount,
    nonMemberCount,
    formerCount,
    offset,
    pageSize: limit,
    truncated: offset + result.rows.length < total,
  };
}

// S-310 · A member and their accounts, so the created record can be confirmed.
export async function loadMember(id: string): Promise<MemberDetail | null> {
  const result = await query<{
    id: string;
    member_no: string;
    membership_type_name: string;
    membership_type_code: string;
    membership_type_id: string;
    status: string;
    status_changed_at: Date | null;
    name: string;
    joined_at: Date;
    rejoined_at: Date | null;
    application_reference: string | null;
    application_id: string | null;
    applicant_values: Record<string, string> | null;
    captured_by_name: string | null;
  }>(
    `select m.id, m.member_no, t.name as membership_type_name,
            t.code as membership_type_code, m.membership_type_id, m.status,
            m.status_changed_at,
            ${NAME_SQL} as name, m.joined_at, m.rejoined_at,
            a.reference as application_reference,
            m.application_id,
            p.values as applicant_values,
            cu.display_name as captured_by_name
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join membership_application a on a.id = m.application_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
       left join app_user cu on cu.id = a.captured_by
      where m.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];

  const accounts = await query<{
    id: string;
    account_no: string | null;
    account_type_id: string;
    account_type_name: string;
    category: string;
    status: string;
    is_membership_default: boolean;
    opened_at: Date;
    opened_via_migration: boolean;
    closed_at: Date | null;
    reopened_at: Date | null;
  }>(
    `select a.id, a.account_no, a.account_type_id,
            t.name as account_type_name, t.category,
            a.status, a.is_membership_default, a.opened_at,
            a.opened_via_migration, a.closed_at, a.reopened_at
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
    membershipTypeCode: row.membership_type_code,
    membershipTypeId: row.membership_type_id,
    status: row.status,
    statusChangedAt: row.status_changed_at,
    name: row.name || '(unnamed)',
    joinedAt: row.joined_at,
    rejoinedAt: row.rejoined_at,
    applicationReference: row.application_reference,
    applicationId: row.application_id,
    applicantValues: row.applicant_values ?? {},
    capturedByName: row.captured_by_name,
    accounts: accounts.rows.map(a => ({
      id: a.id,
      // A Shares or MSA account has none of its own and shows the member's
      // (migration 0018) — but one carried over from the non-member
      // customer this member used to be (S-614) keeps its own HSA0001-style
      // number (account_owner_shape, migration 0038).
      accountNo: a.account_no ?? row.member_no,
      accountTypeId: a.account_type_id,
      accountTypeName: a.account_type_name,
      category: a.category,
      status: a.status,
      isMembershipDefault: a.is_membership_default,
      openedAt: a.opened_at,
      openedViaMigration: a.opened_via_migration,
      closedAt: a.closed_at,
      reopenedAt: a.reopened_at,
    })),
  };
}

export interface CustomerAccount {
  id: string;
  // Unlike a member's, a customer's own — each carries its own number
  // (migration 0027), since there is no shared number to lean on.
  accountNo: string;
  accountTypeId: string;
  accountTypeName: string;
  category: string;
  status: string;
  openedAt: Date;
  // See MemberAccount's own field — "migrated on", not "opened", for one
  // the legacy import created.
  openedViaMigration: boolean;
  closedAt: Date | null;
  reopenedAt: Date | null;
}

export interface CustomerDetail {
  id: string;
  kind: 'customer';
  status: string;
  name: string;
  joinedAt: Date;
  applicationReference: string | null;
  applicationId: string;
  // The type the originating customer_account application was captured
  // against (individual, corporate, minor) — a non-member can be a minor
  // too (S-614), and the detail page tags one from this.
  membershipTypeCode: string;
  // That type's id — used the same way a member's is, to work out which
  // further account types this non-member may still open.
  membershipTypeId: string;
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
    membership_type_code: string;
    membership_type_id: string;
    applicant_values: Record<string, string> | null;
  }>(
    `select c.id, c.status, ${NAME_SQL} as name, c.joined_at,
            capp.reference as application_reference, c.application_id,
            mt.code as membership_type_code, mt.id as membership_type_id,
            p.values as applicant_values
       from customer c
       join membership_application capp on capp.id = c.application_id
       join membership_type mt on mt.id = capp.membership_type_id
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
    account_type_id: string;
    account_type_name: string;
    category: string;
    status: string;
    opened_at: Date;
    opened_via_migration: boolean;
    closed_at: Date | null;
    reopened_at: Date | null;
  }>(
    `select a.id, a.account_no, a.account_type_id,
            t.name as account_type_name, t.category,
            a.status, a.opened_at, a.opened_via_migration,
            a.closed_at, a.reopened_at
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
    membershipTypeCode: row.membership_type_code,
    membershipTypeId: row.membership_type_id,
    applicantValues: row.applicant_values ?? {},
    accounts: accounts.rows.map(a => ({
      id: a.id,
      accountNo: a.account_no,
      accountTypeId: a.account_type_id,
      accountTypeName: a.account_type_name,
      category: a.category,
      status: a.status,
      openedAt: a.opened_at,
      openedViaMigration: a.opened_via_migration,
      closedAt: a.closed_at,
      reopenedAt: a.reopened_at,
    })),
  };
}

/**
 * The non-member record an approved customer_account application created,
 * for its page to link to (lifecycle test: the approved application named
 * the accounts but offered no way to the person). Follows a conversion: a
 * customer who has since become a member is found under the member.
 */
export async function recordForCustomerApplication(
  applicationId: string
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `select coalesce(
              (select m.id from membership_application ma
                 join member m on m.application_id = ma.id
                where ma.source_customer_id = c.id
                order by ma.created_at desc limit 1),
              c.id) as id
       from customer c
      where c.application_id = $1`,
    [applicationId]
  );
  return result.rows[0]?.id ?? null;
}
