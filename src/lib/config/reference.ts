// Reference configuration: the values the business changes without a release
// (M2 Feature 2.2, S-205 to S-210).
//
// Every write goes through withConfigurationActor. That is not a convention
// this module chooses to follow — migration 0010 puts a trigger on each of
// these tables that refuses a change it cannot attribute, so a write outside
// the wrapper fails at the database. The audit entry is therefore written by
// the database in the same transaction as the change, and this module does not
// write one itself: two trails would only disagree.
import type { PoolClient } from 'pg';
import { query, withConfigurationActor } from '../db/pool';
import { cached } from './cache';
import type { ConfigurationActor } from '../db/pool';

// A refusal the caller should show the person who asked, as opposed to a
// defect. Mirrors AdminError in ../admin/roles.ts.
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_found' | 'invalid' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Actor {
  userId: string;
  email: string;
}

function actorFor(actor: Actor): ConfigurationActor {
  return { userId: actor.userId, description: actor.email };
}

// ---------------------------------------------------------------------------
// S-205 · Membership types and their field rules
// ---------------------------------------------------------------------------
export type FieldSubject =
  'applicant' | 'nominee' | 'guardian' | 'beneficiary' | 'employment';

export interface MembershipTypeField {
  id: string;
  fieldKey: string;
  label: string;
  dataType: string;
  choices: string[];
  subject: FieldSubject;
  isVisible: boolean;
  isMandatory: boolean;
  sortOrder: number;
}

export interface MembershipType {
  id: string;
  code: string;
  name: string;
  description: string;
  checklistId: string | null;
  checklistName: string | null;
  // S-614: what a NON-MEMBER applicant must provide when this type backs a
  // customer_account application — independent of checklistId, which is
  // what a MEMBER of this type must provide.
  nonMemberChecklistId: string | null;
  nonMemberChecklistName: string | null;
  feeScheduleId: string | null;
  feeScheduleName: string | null;
  isActive: boolean;
  sortOrder: number;
  fields: MembershipTypeField[];
  // S-602: how many nominee instances (application_party.subject =
  // 'nominee', ordinal 1..N) this type's capture form renders and accepts.
  // Confirmed default is 1 nominee, no percentages (docs/backlog.md M6).
  nomineeCount: number;
  // S-610: the age at which a member of this type automatically becomes a
  // member of majorityTransitionTypeId, and which type that is. Both null
  // means no automatic transition — the shipped default until an
  // administrator sets both.
  majorityAge: number | null;
  majorityTransitionTypeId: string | null;
  majorityTransitionTypeName: string | null;
}

async function readMembershipTypes(): Promise<MembershipType[]> {
  const types = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    checklist_id: string | null;
    checklist_name: string | null;
    non_member_checklist_id: string | null;
    non_member_checklist_name: string | null;
    fee_schedule_id: string | null;
    fee_schedule_name: string | null;
    is_active: boolean;
    sort_order: number;
    nominee_count: number;
    majority_age: number | null;
    majority_transition_type_id: string | null;
    majority_transition_type_name: string | null;
  }>(
    `select m.id, m.code, m.name, m.description,
            m.checklist_id, c.name as checklist_name,
            m.non_member_checklist_id, nc.name as non_member_checklist_name,
            m.fee_schedule_id, f.name as fee_schedule_name,
            m.is_active, m.sort_order, m.nominee_count,
            m.majority_age, m.majority_transition_type_id,
            mt.name as majority_transition_type_name
       from membership_type m
       left join document_checklist c  on c.id = m.checklist_id
       left join document_checklist nc on nc.id = m.non_member_checklist_id
       left join fee_schedule f        on f.id = m.fee_schedule_id
       left join membership_type mt    on mt.id = m.majority_transition_type_id
      order by m.sort_order, m.name`
  );

  // One query for all fields rather than one per type: the number of types is
  // small but unbounded, and a query per row in a loop is how a page that was
  // fast in testing becomes slow in use.
  const fields = await query<{
    id: string;
    membership_type_id: string;
    field_key: string;
    label: string;
    data_type: string;
    choices: string[];
    subject: FieldSubject;
    is_visible: boolean;
    is_mandatory: boolean;
    sort_order: number;
  }>(
    `select id, membership_type_id, field_key, label, data_type, choices,
            subject, is_visible, is_mandatory, sort_order
       from membership_type_field
      order by subject, sort_order, label`
  );

  const byType = new Map<string, MembershipTypeField[]>();
  for (const f of fields.rows) {
    const list = byType.get(f.membership_type_id) ?? [];
    list.push({
      id: f.id,
      fieldKey: f.field_key,
      label: f.label,
      dataType: f.data_type,
      choices: f.choices,
      subject: f.subject,
      isVisible: f.is_visible,
      isMandatory: f.is_mandatory,
      sortOrder: f.sort_order,
    });
    byType.set(f.membership_type_id, list);
  }

  return types.rows.map(t => ({
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    checklistId: t.checklist_id,
    checklistName: t.checklist_name,
    nonMemberChecklistId: t.non_member_checklist_id,
    nonMemberChecklistName: t.non_member_checklist_name,
    feeScheduleId: t.fee_schedule_id,
    feeScheduleName: t.fee_schedule_name,
    isActive: t.is_active,
    sortOrder: t.sort_order,
    fields: byType.get(t.id) ?? [],
    nomineeCount: t.nominee_count,
    majorityAge: t.majority_age,
    majorityTransitionTypeId: t.majority_transition_type_id,
    majorityTransitionTypeName: t.majority_transition_type_name,
  }));
}

// S-602: how many nominees this type's capture form renders and accepts.
export async function setNomineeCount(
  typeId: string,
  count: number,
  actor: Actor
): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new ConfigError(
      'The nominee count must be a whole number from 1 to 10.'
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update membership_type set nominee_count = $2 where id = $1`,
      [typeId, count]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That membership type no longer exists.',
        'not_found'
      );
    }
  });
}

// S-610: the age at which this type automatically becomes another, and
// which type that is. Set together or cleared together — a member's type
// with no target, or a target with no age, would each on their own leave
// the scheduled job unable to tell what to do, so neither is allowed.
export async function setMajorityTransition(
  typeId: string,
  transition: { age: number | null; transitionTypeId: string | null },
  actor: Actor
): Promise<void> {
  const { age, transitionTypeId } = transition;

  if ((age === null) !== (transitionTypeId === null)) {
    throw new ConfigError(
      'Set both the age and the type a member becomes at that age, or ' +
        'clear both — one without the other cannot be acted on.'
    );
  }
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 100)) {
    throw new ConfigError('The age must be a whole number from 1 to 100.');
  }
  if (transitionTypeId !== null && transitionTypeId === typeId) {
    throw new ConfigError('A type cannot transition into itself.');
  }

  await withConfigurationActor(actorFor(actor), async client => {
    if (transitionTypeId !== null) {
      const target = await client.query(
        'select 1 from membership_type where id = $1',
        [transitionTypeId]
      );
      if (target.rowCount === 0) {
        throw new ConfigError(
          'The membership type to transition into no longer exists.',
          'not_found'
        );
      }
    }

    const result = await client.query(
      `update membership_type
          set majority_age = $2, majority_transition_type_id = $3
        where id = $1`,
      [typeId, age, transitionTypeId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That membership type no longer exists.',
        'not_found'
      );
    }
  });
}

// Which checklist, non-member checklist, and fee schedule this type uses
// (S-205, S-614).
export async function setMembershipTypeReferences(
  typeId: string,
  refs: {
    checklistId: string | null;
    nonMemberChecklistId: string | null;
    feeScheduleId: string | null;
  },
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update membership_type
          set checklist_id = $2, non_member_checklist_id = $3,
              fee_schedule_id = $4
        where id = $1`,
      [typeId, refs.checklistId, refs.nonMemberChecklistId, refs.feeScheduleId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That membership type no longer exists.',
        'not_found'
      );
    }
  });
}

// Whether a field appears on the form and whether it must be filled in.
export async function setFieldRule(
  fieldId: string,
  rule: { isVisible: boolean; isMandatory: boolean },
  actor: Actor
): Promise<void> {
  // The database refuses a hidden-but-mandatory field, which would deadlock
  // capture. Catching it here turns a constraint name into a sentence.
  if (!rule.isVisible && rule.isMandatory) {
    throw new ConfigError(
      'A field that is hidden cannot be mandatory — nobody could fill it in.'
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update membership_type_field
          set is_visible = $2, is_mandatory = $3
        where id = $1`,
      [fieldId, rule.isVisible, rule.isMandatory]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That field no longer exists.', 'not_found');
    }
  });
}

// ---------------------------------------------------------------------------
// S-206 · Account types and the default product
// ---------------------------------------------------------------------------
export interface AccountType {
  id: string;
  code: string;
  name: string;
  category: string;
  minimumOpeningAmount: string;
  checklistId: string | null;
  checklistName: string | null;
  requiresApproval: boolean;
  defaultStatus: string;
  isMembershipDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  // S-614: what a non-member's account of this type is numbered with —
  // HSA0001, INV0001, whatever an administrator sets. Null until a
  // customer_account application needs one (next_customer_account_number,
  // migration 0027, refuses to open an account of a type with none set).
  numberPrefix: string | null;
  // Which membership types may open this account type (migration 0040) —
  // empty means every membership type may, the default every account type
  // had before this existed. Corporate never being offered HSA is exactly
  // this: HSA's own rows naming only Individual and Minor, not a special
  // case anywhere in code.
  eligibleMembershipTypeIds: string[];
  // S-1304: what the engine reads before it moves money on an account of
  // this type (migration 0065). One floor, read identically by a withdrawal
  // and a transfer out; three switches for what the type accepts at all;
  // and a per-transaction cap, null for none.
  minimumBalance: string;
  allowsDeposit: boolean;
  allowsWithdrawal: boolean;
  allowsTransfer: boolean;
  maximumTransactionAmount: string | null;
}

// numeric comes back from node-postgres as a string, and it stays one all the
// way to the page. Money through a float is a rounding error waiting for a
// reconciliation to find it.
async function readAccountTypes(): Promise<AccountType[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    category: string;
    minimum_opening_amount: string;
    checklist_id: string | null;
    checklist_name: string | null;
    requires_approval: boolean;
    default_status: string;
    is_membership_default: boolean;
    is_active: boolean;
    sort_order: number;
    number_prefix: string | null;
    minimum_balance: string;
    allows_deposit: boolean;
    allows_withdrawal: boolean;
    allows_transfer: boolean;
    maximum_transaction_amount: string | null;
  }>(
    `select a.id, a.code, a.name, a.category, a.minimum_opening_amount,
            a.checklist_id, c.name as checklist_name,
            a.requires_approval, a.default_status, a.is_membership_default,
            a.is_active, a.sort_order, a.number_prefix,
            a.minimum_balance, a.allows_deposit, a.allows_withdrawal,
            a.allows_transfer, a.maximum_transaction_amount
       from account_type a
       left join document_checklist c on c.id = a.checklist_id
      order by a.sort_order, a.name`
  );

  // One query for every type's eligibility rows rather than one per type —
  // the same reason readMembershipTypes reads every type's fields in a
  // single query below.
  const eligibility = await query<{
    account_type_id: string;
    membership_type_id: string;
  }>(
    `select account_type_id, membership_type_id from account_type_membership_type`
  );
  const eligibleByType = new Map<string, string[]>();
  for (const row of eligibility.rows) {
    const list = eligibleByType.get(row.account_type_id) ?? [];
    list.push(row.membership_type_id);
    eligibleByType.set(row.account_type_id, list);
  }

  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    minimumOpeningAmount: r.minimum_opening_amount,
    checklistId: r.checklist_id,
    checklistName: r.checklist_name,
    requiresApproval: r.requires_approval,
    defaultStatus: r.default_status,
    isMembershipDefault: r.is_membership_default,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    eligibleMembershipTypeIds: eligibleByType.get(r.id) ?? [],
    numberPrefix: r.number_prefix,
    minimumBalance: r.minimum_balance,
    allowsDeposit: r.allows_deposit,
    allowsWithdrawal: r.allows_withdrawal,
    allowsTransfer: r.allows_transfer,
    maximumTransactionAmount: r.maximum_transaction_amount,
  }));
}

export interface AccountTypeInput {
  code: string;
  name: string;
  category: string;
  minimumOpeningAmount: string;
  checklistId: string | null;
  requiresApproval: boolean;
  defaultStatus: string;
  // S-614: optional — most account types (Shares, the MSA) never open
  // through the customer_account flow and need no number of their own.
  numberPrefix?: string | null;
  // S-1304: the type's limits. Optional so that a caller with no opinion
  // on them — a test, an import — can leave them alone: on create an omitted
  // one takes the column's default (a floor of 0, everything allowed, no
  // cap), and on update an omitted one is left as it stands. The
  // configuration screen sends all five, every time.
  minimumBalance?: string;
  allowsDeposit?: boolean;
  allowsWithdrawal?: boolean;
  allowsTransfer?: boolean;
  maximumTransactionAmount?: string | null;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function validateAmount(amount: string): void {
  if (!AMOUNT_PATTERN.test(amount.trim())) {
    throw new ConfigError(
      'An amount must be a number with at most two decimal places.'
    );
  }
}

// The five limit columns as they go to the database: a trimmed amount or
// null where the caller said nothing, so the same list serves an insert that
// falls back to the column default and an update that coalesces to the
// current value. A blank cap is no cap; a cap of zero is refused here, with
// a reason, rather than by the check constraint with a constraint name.
function limitsFor(input: {
  minimumBalance?: string;
  allowsDeposit?: boolean;
  allowsWithdrawal?: boolean;
  allowsTransfer?: boolean;
  maximumTransactionAmount?: string | null;
}): [
  string | null,
  boolean | null,
  boolean | null,
  boolean | null,
  string | null,
] {
  const floor = input.minimumBalance?.trim();
  if (floor !== undefined) validateAmount(floor);
  const cap = input.maximumTransactionAmount?.trim() || null;
  if (cap !== null) {
    validateAmount(cap);
    if (Number(cap) === 0) {
      throw new ConfigError(
        'A maximum transaction amount must be above zero. Leave it blank ' +
          'for no limit.'
      );
    }
  }
  return [
    floor === undefined ? null : floor,
    input.allowsDeposit ?? null,
    input.allowsWithdrawal ?? null,
    input.allowsTransfer ?? null,
    input.maximumTransactionAmount === undefined ? null : cap,
  ];
}

export async function createAccountType(
  input: AccountTypeInput,
  actor: Actor
): Promise<string> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ConfigError(
      'A code must start with a letter and contain only lowercase letters, ' +
        'digits and underscores.'
    );
  }
  if (!input.name.trim()) throw new ConfigError('A name is required.');
  validateAmount(input.minimumOpeningAmount);
  const limits = limitsFor(input);

  return withConfigurationActor(actorFor(actor), async client => {
    const existing = await client.query(
      'select 1 from account_type where code = $1',
      [code]
    );
    if (existing.rowCount) {
      throw new ConfigError(
        `An account type with code ${code} already exists.`,
        'conflict'
      );
    }

    const result = await client.query<{ id: string }>(
      // The limits fall back to the column defaults (0065) where the caller
      // gave none — `default` in a values list cannot be parameterised, so
      // the fallback is spelled out here and must agree with the migration.
      `insert into account_type
         (code, name, category, minimum_opening_amount, checklist_id,
          requires_approval, default_status, number_prefix,
          sort_order, minimum_balance, allows_deposit, allows_withdrawal,
          allows_transfer, maximum_transaction_amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8,
               coalesce((select max(sort_order) + 1 from account_type), 1),
               coalesce($9::numeric, 0), coalesce($10::boolean, true),
               coalesce($11::boolean, true), coalesce($12::boolean, true),
               $13::numeric)
       returning id`,
      [
        code,
        input.name.trim(),
        input.category.trim() || 'savings',
        input.minimumOpeningAmount.trim(),
        input.checklistId,
        input.requiresApproval,
        input.defaultStatus,
        input.numberPrefix?.trim() || null,
        ...limits,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updateAccountType(
  id: string,
  input: Omit<AccountTypeInput, 'code'> & { isActive: boolean },
  actor: Actor
): Promise<void> {
  if (!input.name.trim()) throw new ConfigError('A name is required.');
  validateAmount(input.minimumOpeningAmount);
  const limits = limitsFor(input);

  await withConfigurationActor(actorFor(actor), async client => {
    // Deactivating the last product a membership opens would leave an
    // approval with no account to open. Refuse rather than discover it at
    // approval time. Deactivating one of several is fine — the others still
    // open.
    if (!input.isActive) {
      const lastOne = await client.query<{ n: number }>(
        `select count(*)::int as n from account_type
          where is_membership_default and is_active and id <> $1`,
        [id]
      );
      const opensOnApproval = await client.query(
        'select 1 from account_type where id = $1 and is_membership_default',
        [id]
      );
      if (opensOnApproval.rowCount && lastOne.rows[0].n === 0) {
        throw new ConfigError(
          'This is the only product a membership approval opens. Set ' +
            'another type to open on approval before deactivating it.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      // A limit the caller did not mention keeps its value. The cap is the
      // one that cannot coalesce — null is a value there (no limit) — so a
      // caller who wants it left alone omits the key rather than passing
      // null, which limitsFor() tells apart.
      `update account_type
          set name = $2, category = $3, minimum_opening_amount = $4,
              checklist_id = $5, requires_approval = $6, default_status = $7,
              is_active = $8, number_prefix = $9,
              minimum_balance = coalesce($10::numeric, minimum_balance),
              allows_deposit = coalesce($11::boolean, allows_deposit),
              allows_withdrawal = coalesce($12::boolean, allows_withdrawal),
              allows_transfer = coalesce($13::boolean, allows_transfer),
              maximum_transaction_amount = case
                when $15::boolean then $14::numeric
                else maximum_transaction_amount end
        where id = $1`,
      [
        id,
        input.name.trim(),
        input.category.trim() || 'savings',
        input.minimumOpeningAmount.trim(),
        input.checklistId,
        input.requiresApproval,
        input.defaultStatus,
        input.isActive,
        input.numberPrefix?.trim() || null,
        ...limits,
        input.maximumTransactionAmount !== undefined,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }
  });
}

// Officer feedback: an account type created by mistake, or one no longer
// wanted, had no way back out — only Active/inactive, which keeps it around
// forever as a choice nobody can actually offer. A hard delete is refused,
// by name, wherever the type is actually in use: any account already opened
// under it, any in-flight or decided application that selected it, any
// payment line that charged it, and the per-type customer account number
// counter (all four hold a foreign key to account_type that would otherwise
// fail this with a raw constraint error rather than a reason). Being the
// membership's own default product is checked separately — "opens on
// approval" (setOpensOnApproval) has to be turned off first, the same
// as before deactivating it.
export async function deleteAccountType(
  accountTypeId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const isDefault = await client.query(
      'select 1 from account_type where id = $1 and is_membership_default',
      [accountTypeId]
    );
    if (isDefault.rowCount) {
      throw new ConfigError(
        'A membership approval opens this account type. Turn that off ' +
          'first, above.',
        'conflict'
      );
    }

    const inUse = await client.query(
      `select 1 from account where account_type_id = $1
       union all
       select 1 from application_account_selection where account_type_id = $1
       union all
       select 1 from payment_account_line where account_type_id = $1
       union all
       select 1 from account_number_counter where account_type_id = $1
       limit 1`,
      [accountTypeId]
    );
    if (inUse.rowCount) {
      throw new ConfigError(
        'This account type has already been used — opened, applied for, ' +
          'or paid for — and cannot be deleted. Set it to inactive instead.',
        'conflict'
      );
    }

    const result = await client.query(
      'delete from account_type where id = $1',
      [accountTypeId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }
  });
}

/**
 * Whether a membership approval opens this account type (S-206).
 *
 * Several types may be marked at once, and normally two are: a membership
 * opens a Shares account and an MSA together, both carrying the member's
 * number. This used to set one exclusively, which is why it is a toggle now —
 * marking Shares must not silently unmark the MSA.
 *
 * "Given the default is changed Then subsequent approvals open the new type"
 * still holds: nothing is cached, so the next approval reads whatever is
 * marked now.
 */
export async function setOpensOnApproval(
  accountTypeId: string,
  opens: boolean,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const target = await client.query<{ is_active: boolean }>(
      'select is_active from account_type where id = $1',
      [accountTypeId]
    );
    if (target.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }
    if (opens && !target.rows[0].is_active) {
      throw new ConfigError(
        'An inactive account type cannot be opened on approval.'
      );
    }

    if (!opens) {
      // Clearing the last one would leave an approval with nothing to open,
      // which is the half-created member S-308 exists to prevent — and it
      // would not be discovered until someone approved an application.
      const others = await client.query<{ n: number }>(
        `select count(*)::int as n from account_type
          where is_membership_default and is_active and id <> $1`,
        [accountTypeId]
      );
      if (others.rows[0].n === 0) {
        throw new ConfigError(
          'A membership approval has to open at least one account. Set ' +
            'another type to open on approval before clearing this one.',
          'conflict'
        );
      }
    }

    await client.query(
      'update account_type set is_membership_default = $2 where id = $1',
      [accountTypeId, opens]
    );
  });
}

/**
 * Which membership types may open this account type (migration 0040) —
 * replaces the whole set at once, the same shape the checkbox list an
 * administrator ticks on the account-types screen naturally produces.
 *
 * An empty list means unrestricted, not "restricted to nobody": that is what
 * lets an administrator clear every box to undo a restriction entirely,
 * rather than leaving an account type nobody can open.
 */
export async function setAccountTypeEligibility(
  accountTypeId: string,
  membershipTypeIds: string[],
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const target = await client.query(
      'select 1 from account_type where id = $1',
      [accountTypeId]
    );
    if (target.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }

    await client.query(
      'delete from account_type_membership_type where account_type_id = $1',
      [accountTypeId]
    );
    if (membershipTypeIds.length > 0) {
      await client.query(
        `insert into account_type_membership_type
           (account_type_id, membership_type_id)
         select $1, t from unnest($2::uuid[]) as t
         on conflict do nothing`,
        [accountTypeId, membershipTypeIds]
      );
    }
  });
}

// The products a membership approval opens, in the order they are listed.
// Read at approval time rather than cached, so a change takes effect on the
// next approval (S-206).
export async function getAccountTypesOpenedOnApproval(): Promise<
  AccountType[]
> {
  const all = await listAccountTypes();
  return all.filter(a => a.isMembershipDefault && a.isActive);
}

// ---------------------------------------------------------------------------
// S-207 · Fee schedules
// ---------------------------------------------------------------------------
export type FeeRequirement = 'required' | 'optional' | 'not_applicable';

export const FEE_COMPONENTS = [
  'entrance',
  'takaful',
  'shares',
  'msa_deposit',
  'processing',
] as const;

export type FeeComponentCode = (typeof FEE_COMPONENTS)[number];

export interface FeeComponent {
  code: FeeComponentCode;
  amount: string;
  requirement: FeeRequirement;
  sortOrder: number;
}

export interface FeeScheduleVersion {
  id: string;
  versionNo: number;
  effectiveFrom: Date;
  supersededAt: Date | null;
  components: FeeComponent[];
}

export interface FeeSchedule {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  current: FeeScheduleVersion | null;
  // Superseded versions, newest first. An amount that was charged is readable
  // for as long as the receipt that charged it exists.
  history: FeeScheduleVersion[];
}

interface VersionRow {
  version_id: string;
  schedule_id: string;
  version_no: number;
  effective_from: Date;
  superseded_at: Date | null;
}

interface ComponentRow {
  version_id: string;
  code: FeeComponentCode;
  amount: string;
  requirement: FeeRequirement;
  sort_order: number;
}

function assembleVersions(
  versions: VersionRow[],
  components: ComponentRow[]
): Map<string, FeeScheduleVersion[]> {
  const byVersion = new Map<string, FeeComponent[]>();
  for (const c of components) {
    const list = byVersion.get(c.version_id) ?? [];
    list.push({
      code: c.code,
      amount: c.amount,
      requirement: c.requirement,
      sortOrder: c.sort_order,
    });
    byVersion.set(c.version_id, list);
  }

  const bySchedule = new Map<string, FeeScheduleVersion[]>();
  for (const v of versions) {
    const list = bySchedule.get(v.schedule_id) ?? [];
    list.push({
      id: v.version_id,
      versionNo: v.version_no,
      effectiveFrom: v.effective_from,
      supersededAt: v.superseded_at,
      components: byVersion.get(v.version_id) ?? [],
    });
    bySchedule.set(v.schedule_id, list);
  }
  return bySchedule;
}

export async function listFeeSchedules(): Promise<FeeSchedule[]> {
  const schedules = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    is_active: boolean;
  }>(
    'select id, code, name, description, is_active from fee_schedule order by name'
  );

  const versions = await query<VersionRow>(
    `select id as version_id, schedule_id, version_no, effective_from, superseded_at
       from fee_schedule_version
      order by schedule_id, version_no desc`
  );

  const components = await query<ComponentRow>(
    `select version_id, code, amount, requirement, sort_order
       from fee_component
      order by sort_order, code`
  );

  const bySchedule = assembleVersions(versions.rows, components.rows);

  return schedules.rows.map(s => {
    const all = bySchedule.get(s.id) ?? [];
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      isActive: s.is_active,
      current: all.find(v => v.supersededAt === null) ?? null,
      history: all.filter(v => v.supersededAt !== null),
    };
  });
}

// Amounts in force for one schedule right now. What a capture screen asks for.
export async function getCurrentFees(
  scheduleCode: string
): Promise<FeeComponent[]> {
  const result = await query<ComponentRow>(
    `select c.version_id, c.code, c.amount, c.requirement, c.sort_order
       from fee_component c
       join fee_schedule_version v on v.id = c.version_id
       join fee_schedule s         on s.id = v.schedule_id
      where s.code = $1 and v.superseded_at is null
      order by c.sort_order, c.code`,
    [scheduleCode]
  );
  return result.rows.map(r => ({
    code: r.code,
    amount: r.amount,
    requirement: r.requirement,
    sortOrder: r.sort_order,
  }));
}

// The live version of one schedule, by schedule id, with the id of the version
// itself (S-501).
//
// getCurrentFees answers "what does this cost"; a payment additionally has to
// record WHICH VERSION it charged, because that is what makes an amount
// unchangeable after the fact. Returning the two together means the caller
// cannot read the amounts from one version and file them against another.
export interface CurrentFeeVersion {
  versionId: string;
  scheduleId: string;
  scheduleCode: string;
  scheduleName: string;
  versionNo: number;
  components: FeeComponent[];
}

async function readCurrentFeeVersion(
  scheduleId: string
): Promise<CurrentFeeVersion | null> {
  const version = await query<{
    id: string;
    schedule_id: string;
    code: string;
    name: string;
    version_no: number;
  }>(
    `select v.id, v.schedule_id, s.code, s.name, v.version_no
       from fee_schedule_version v
       join fee_schedule s on s.id = v.schedule_id
      where v.schedule_id = $1 and v.superseded_at is null`,
    [scheduleId]
  );

  const row = version.rows[0];
  if (!row) return null;

  const components = await query<ComponentRow>(
    `select version_id, code, amount, requirement, sort_order
       from fee_component
      where version_id = $1
      order by sort_order, code`,
    [row.id]
  );

  return {
    versionId: row.id,
    scheduleId: row.schedule_id,
    scheduleCode: row.code,
    scheduleName: row.name,
    versionNo: row.version_no,
    components: components.rows.map(c => ({
      code: c.code,
      amount: c.amount,
      requirement: c.requirement,
      sortOrder: c.sort_order,
    })),
  };
}

// The components of a version that has been superseded, for reading a receipt
// that charged it.
export async function feeVersionById(
  versionId: string
): Promise<{ versionNo: number; components: FeeComponent[] } | null> {
  const version = await query<{ version_no: number }>(
    'select version_no from fee_schedule_version where id = $1',
    [versionId]
  );
  if (version.rows.length === 0) return null;

  const components = await query<ComponentRow>(
    `select version_id, code, amount, requirement, sort_order
       from fee_component
      where version_id = $1
      order by sort_order, code`,
    [versionId]
  );

  return {
    versionNo: version.rows[0].version_no,
    components: components.rows.map(c => ({
      code: c.code,
      amount: c.amount,
      requirement: c.requirement,
      sortOrder: c.sort_order,
    })),
  };
}

// Publish a new set of amounts (S-207).
//
// The change is a NEW VERSION, never an edit of the live one. That is what
// makes "existing receipts are untouched" a property of the schema rather than
// a promise: a receipt records the version it charged, and that row's amounts
// can no longer change.
export async function publishFeeVersion(
  scheduleId: string,
  components: ReadonlyArray<{
    code: FeeComponentCode;
    amount: string;
    requirement: FeeRequirement;
  }>,
  actor: Actor
): Promise<string> {
  if (components.length === 0) {
    throw new ConfigError('A fee version must state at least one component.');
  }

  const seen = new Set<string>();
  for (const c of components) {
    if (!FEE_COMPONENTS.includes(c.code)) {
      throw new ConfigError(`Unknown fee component ${c.code}.`);
    }
    if (seen.has(c.code)) {
      throw new ConfigError(`Fee component ${c.code} is listed twice.`);
    }
    seen.add(c.code);
    validateAmount(c.amount);
    if (c.requirement === 'required' && Number(c.amount) === 0) {
      throw new ConfigError(
        `${c.code} is marked required but its amount is zero. Mark it ` +
          'optional or not applicable instead.'
      );
    }
  }

  return withConfigurationActor(actorFor(actor), async client => {
    const schedule = await client.query(
      'select 1 from fee_schedule where id = $1',
      [scheduleId]
    );
    if (schedule.rowCount === 0) {
      throw new ConfigError('That fee schedule no longer exists.', 'not_found');
    }

    // Close the live version before opening the next one: the partial unique
    // index permits only one un-superseded version per schedule.
    await client.query(
      `update fee_schedule_version
          set superseded_at = now()
        where schedule_id = $1 and superseded_at is null`,
      [scheduleId]
    );

    const version = await client.query<{ id: string }>(
      `insert into fee_schedule_version (schedule_id, version_no, created_by)
       values ($1,
               coalesce((select max(version_no) + 1 from fee_schedule_version
                          where schedule_id = $1), 1),
               $2)
       returning id`,
      [scheduleId, actor.userId]
    );
    const versionId = version.rows[0].id;

    for (const [index, c] of components.entries()) {
      await client.query(
        `insert into fee_component (version_id, code, amount, requirement, sort_order)
         values ($1, $2, $3, $4, $5)`,
        [versionId, c.code, c.amount, c.requirement, index + 1]
      );
    }

    return versionId;
  });
}

// ---------------------------------------------------------------------------
// S-208 · Document types and dynamic checklists
// ---------------------------------------------------------------------------
export interface DocumentType {
  id: string;
  code: string;
  name: string;
  description: string;
  tracksExpiry: boolean;
  isActive: boolean;
}

export interface ChecklistItem {
  id: string;
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  tracksExpiry: boolean;
  subject: FieldSubject;
  requirement: 'required' | 'optional';
  sortOrder: number;
}

export interface DocumentChecklist {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  items: ChecklistItem[];
}

async function readDocumentTypes(): Promise<DocumentType[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    tracks_expiry: boolean;
    is_active: boolean;
  }>(
    `select id, code, name, description, tracks_expiry, is_active
       from document_type order by name`
  );
  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    tracksExpiry: r.tracks_expiry,
    isActive: r.is_active,
  }));
}

async function readChecklists(): Promise<DocumentChecklist[]> {
  const lists = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    is_active: boolean;
  }>(
    'select id, code, name, description, is_active from document_checklist order by name'
  );

  const items = await query<{
    id: string;
    checklist_id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `select i.id, i.checklist_id, i.document_type_id,
            d.code as document_code, d.name as document_name, d.tracks_expiry,
            i.subject, i.requirement, i.sort_order
       from document_checklist_item i
       join document_type d on d.id = i.document_type_id
      order by i.subject, i.sort_order, d.name`
  );

  const byList = new Map<string, ChecklistItem[]>();
  for (const i of items.rows) {
    const list = byList.get(i.checklist_id) ?? [];
    list.push({
      id: i.id,
      documentTypeId: i.document_type_id,
      documentCode: i.document_code,
      documentName: i.document_name,
      tracksExpiry: i.tracks_expiry,
      subject: i.subject,
      requirement: i.requirement,
      sortOrder: i.sort_order,
    });
    byList.set(i.checklist_id, list);
  }

  return lists.rows.map(l => ({
    id: l.id,
    code: l.code,
    name: l.name,
    description: l.description,
    isActive: l.is_active,
    items: byList.get(l.id) ?? [],
  }));
}

// Officer feedback: there was no way to start a new checklist at all — only
// to add documents to one already seeded by a migration. A checklist is
// itself configuration (S-208), the same as an account type or a role, so
// creating one belongs here beside them rather than needing a migration
// every time the Society wants a new KYC section. Once created it is
// immediately selectable wherever a checklist is chosen — Account types'
// own "Documents required to open" (admin/configuration/account-types.astro)
// reads listChecklists() fresh, the same list this page shows.
export async function createChecklist(
  input: { code: string; name: string; description?: string },
  actor: Actor
): Promise<string> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ConfigError(
      'A code must start with a letter and contain only lowercase letters, ' +
        'digits and underscores.'
    );
  }
  if (!input.name.trim()) throw new ConfigError('A name is required.');

  return withConfigurationActor(actorFor(actor), async client => {
    const existing = await client.query(
      'select 1 from document_checklist where code = $1',
      [code]
    );
    if (existing.rowCount) {
      throw new ConfigError(
        `A checklist with code ${code} already exists.`,
        'conflict'
      );
    }

    const result = await client.query<{ id: string }>(
      `insert into document_checklist (code, name, description)
       values ($1, $2, $3)
       returning id`,
      [code, input.name.trim(), input.description?.trim() ?? '']
    );
    return result.rows[0].id;
  });
}

export async function addChecklistItem(
  checklistId: string,
  item: {
    documentTypeId: string;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
  },
  actor: Actor
): Promise<string> {
  return withConfigurationActor(actorFor(actor), async client => {
    const duplicate = await client.query(
      `select 1 from document_checklist_item
        where checklist_id = $1 and document_type_id = $2 and subject = $3`,
      [checklistId, item.documentTypeId, item.subject]
    );
    if (duplicate.rowCount) {
      throw new ConfigError(
        'That document is already on this checklist for that subject.',
        'conflict'
      );
    }

    const result = await client.query<{ id: string }>(
      `insert into document_checklist_item
         (checklist_id, document_type_id, subject, requirement, sort_order)
       values ($1, $2, $3, $4,
               coalesce((select max(sort_order) + 1
                           from document_checklist_item
                          where checklist_id = $1), 1))
       returning id`,
      [checklistId, item.documentTypeId, item.subject, item.requirement]
    );
    return result.rows[0].id;
  });
}

export async function setChecklistItemRequirement(
  itemId: string,
  requirement: 'required' | 'optional',
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'update document_checklist_item set requirement = $2 where id = $1',
      [itemId, requirement]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That checklist item no longer exists.',
        'not_found'
      );
    }
  });
}

export async function removeChecklistItem(
  itemId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'delete from document_checklist_item where id = $1',
      [itemId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That checklist item no longer exists.',
        'not_found'
      );
    }
  });
}

// Officer feedback: a checklist created by mistake, or one no longer needed,
// had no way back out. Its own items (document_checklist_item) cascade away
// with it (migration 0010) — nothing to check there — but membership_type
// and account_type both merely REFERENCE a checklist rather than owning it,
// so those foreign keys would otherwise fail this with a raw constraint
// error. Checked explicitly instead, so the refusal names what to do about
// it — reassign it away first — rather than reading as this application
// being broken.
export async function deleteChecklist(
  checklistId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const inUse = await client.query<{ name: string }>(
      `select name from membership_type
        where checklist_id = $1 or non_member_checklist_id = $1
       union
       select name from account_type where checklist_id = $1
       limit 1`,
      [checklistId]
    );
    if (inUse.rowCount) {
      throw new ConfigError(
        `${inUse.rows[0].name} still uses this checklist. Reassign it to a ` +
          'different checklist there first.',
        'conflict'
      );
    }

    const result = await client.query(
      'delete from document_checklist where id = $1',
      [checklistId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That checklist no longer exists.', 'not_found');
    }
  });
}

// The checklist that applies to an applicant of this membership type (S-208).
// Grouped by subject because that is how the capture screen presents it: the
// applicant's documents, then the nominee's, then the guardian's.
async function readChecklistForMembershipType(
  membershipTypeCode: string
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  const result = await query<{
    id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `select i.id, i.document_type_id, d.code as document_code,
            d.name as document_name, d.tracks_expiry,
            i.subject, i.requirement, i.sort_order
       from membership_type m
       join document_checklist_item i on i.checklist_id = m.checklist_id
       join document_type d on d.id = i.document_type_id
      where m.code = $1 and d.is_active
      order by i.subject, i.sort_order`,
    [membershipTypeCode]
  );

  const bySubject = new Map<FieldSubject, ChecklistItem[]>();
  for (const r of result.rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push({
      id: r.id,
      documentTypeId: r.document_type_id,
      documentCode: r.document_code,
      documentName: r.document_name,
      tracksExpiry: r.tracks_expiry,
      subject: r.subject,
      requirement: r.requirement,
      sortOrder: r.sort_order,
    });
    bySubject.set(r.subject, list);
  }
  return bySubject;
}

// S-612 · The checklist for an additional-account application — the union of
// each selected account type's own checklist (account_type.checklist_id),
// not a membership type's. A document required by any selected account type
// is required on this application; one required by two selected types is
// not asked for twice, and if either leaves it optional while the other
// requires it, the application asks for it (bool_or below).
async function readChecklistForAccountTypes(
  accountTypeCodes: string[]
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  const bySubject = new Map<FieldSubject, ChecklistItem[]>();
  if (accountTypeCodes.length === 0) return bySubject;

  const result = await query<{
    id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `with selected as (
       select i.document_type_id, i.subject,
              bool_or(i.requirement = 'required') as required,
              min(i.sort_order) as sort_order,
              (array_agg(i.id))[1] as id
         from account_type a
         join document_checklist_item i on i.checklist_id = a.checklist_id
        where a.code = any($1::text[])
        group by i.document_type_id, i.subject
     )
     select s.id, s.document_type_id, d.code as document_code,
            d.name as document_name, d.tracks_expiry, s.subject,
            case when s.required then 'required' else 'optional' end
              as requirement,
            s.sort_order
       from selected s
       join document_type d on d.id = s.document_type_id
      where d.is_active
      order by s.subject, s.sort_order`,
    [accountTypeCodes]
  );

  for (const r of result.rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push({
      id: r.id,
      documentTypeId: r.document_type_id,
      documentCode: r.document_code,
      documentName: r.document_name,
      tracksExpiry: r.tracks_expiry,
      subject: r.subject,
      requirement: r.requirement,
      sortOrder: r.sort_order,
    });
    bySubject.set(r.subject, list);
  }
  return bySubject;
}

// S-614 · What a non-member applicant must provide, read from
// membership_type.non_member_checklist_id — deliberately NOT checklistId,
// which is what a MEMBER of this type must provide. Not everything a
// membership asks for applies to someone who never becomes one: a nominee's
// own ID card and the signed application form both come from a shape
// (a printed four-signature form, a Takaful nominee) this flow does not
// have. Configured independently (Configuration → Membership types) rather
// than filtered out of checklistId's own items in code, so an administrator
// can add or remove items without this function needing to know why.
async function readChecklistForNonMemberApplicant(
  membershipTypeCode: string
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  const result = await query<{
    id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `select i.id, i.document_type_id, d.code as document_code,
            d.name as document_name, d.tracks_expiry,
            i.subject, i.requirement, i.sort_order
       from membership_type m
       join document_checklist_item i
         on i.checklist_id = m.non_member_checklist_id
       join document_type d on d.id = i.document_type_id
      where m.code = $1 and d.is_active
      order by i.subject, i.sort_order`,
    [membershipTypeCode]
  );

  const bySubject = new Map<FieldSubject, ChecklistItem[]>();
  for (const r of result.rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push({
      id: r.id,
      documentTypeId: r.document_type_id,
      documentCode: r.document_code,
      documentName: r.document_name,
      tracksExpiry: r.tracks_expiry,
      subject: r.subject,
      requirement: r.requirement,
      sortOrder: r.sort_order,
    });
    bySubject.set(r.subject, list);
  }
  return bySubject;
}

// S-614 · The checklist for a customer_account application — the union of
// what the non-member applicant must provide (checklistForNonMemberApplicant,
// above) and the selected account types' own checklist
// (checklistForAccountTypes' own union, unchanged). A document required by
// either side is required here; where the same document type appears on
// both sides, "required" wins over "optional", the same rule
// checklistForAccountTypes already applies between its own several account
// types.
async function readChecklistForNonMemberAccount(
  membershipTypeCode: string,
  accountTypeCodes: string[]
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  const [applicant, accounts] = await Promise.all([
    checklistForNonMemberApplicant(membershipTypeCode),
    checklistForAccountTypes(accountTypeCodes),
  ]);

  const bySubject = new Map<FieldSubject, ChecklistItem[]>();
  for (const [subject, items] of applicant) {
    bySubject.set(subject, [...items]);
  }
  for (const [subject, items] of accounts) {
    const existing = bySubject.get(subject) ?? [];
    for (const item of items) {
      const already = existing.find(
        e => e.documentTypeId === item.documentTypeId
      );
      if (already) {
        if (item.requirement === 'required') already.requirement = 'required';
      } else {
        existing.push(item);
      }
    }
    bySubject.set(subject, existing);
  }
  return bySubject;
}

// ---------------------------------------------------------------------------
// S-209 · Workflow definitions
// ---------------------------------------------------------------------------
export interface WorkflowStep {
  id: string;
  stepNo: number;
  code: string;
  name: string;
  roleId: string;
  roleName: string;
  // S-611: which role's job this step actually is, not just a label for the
  // transition history — `assertMayAct` (workflow.ts) checks a principal's
  // own role codes against this, the same way it already checks their
  // permissions. Needed once `regional_review` and `secretary_review` began
  // sharing a single permission (`application.review`, migration 0011): the
  // permission alone could no longer tell the two apart.
  roleCode: string;
  fromStatus: string;
  toStatus: string;
  isEnabled: boolean;
  quorumCount: number;
}

export interface WorkflowDefinition {
  id: string;
  code: string;
  name: string;
  description: string;
  entityType: string;
  isActive: boolean;
  steps: WorkflowStep[];
}

export interface WorkflowStatus {
  id: string;
  entityType: string;
  code: string;
  name: string;
  description: string;
  isTerminal: boolean;
  isActive: boolean;
  sortOrder: number;
}

async function readWorkflowStatuses(
  entityType?: string
): Promise<WorkflowStatus[]> {
  const result = await query<{
    id: string;
    entity_type: string;
    code: string;
    name: string;
    description: string;
    is_terminal: boolean;
    is_active: boolean;
    sort_order: number;
  }>(
    `select id, entity_type, code, name, description, is_terminal, is_active,
            sort_order
       from workflow_status
      where $1::text is null or entity_type = $1::text
      order by entity_type, sort_order`,
    [entityType ?? null]
  );
  return result.rows.map(r => ({
    id: r.id,
    entityType: r.entity_type,
    code: r.code,
    name: r.name,
    description: r.description,
    isTerminal: r.is_terminal,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

// Read on nearly every page load — availableActions, reviewStageLabel and
// pendingActionCount (workflow.ts) each read the active chain, and
// pendingActionCount alone runs once per request from DashboardLayout, on
// top of whatever the page itself asks for. Served from the shared
// reference cache (cache.ts) like every other read on this page; the
// setters below clear it through withConfigurationActor.
async function readWorkflows(): Promise<WorkflowDefinition[]> {
  const definitions = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    entity_type: string;
    is_active: boolean;
  }>(
    `select id, code, name, description, entity_type, is_active
       from workflow_definition order by name`
  );

  const steps = await query<{
    id: string;
    definition_id: string;
    step_no: number;
    code: string;
    name: string;
    role_id: string;
    role_name: string;
    role_code: string;
    from_status: string;
    to_status: string;
    is_enabled: boolean;
    quorum_count: number;
  }>(
    `select s.id, s.definition_id, s.step_no, s.code, s.name,
            s.role_id, r.name as role_name, r.code as role_code,
            s.from_status, s.to_status, s.is_enabled, s.quorum_count
       from workflow_step s
       join role r on r.id = s.role_id
      order by s.definition_id, s.step_no`
  );

  const byDefinition = new Map<string, WorkflowStep[]>();
  for (const s of steps.rows) {
    const list = byDefinition.get(s.definition_id) ?? [];
    list.push({
      id: s.id,
      stepNo: s.step_no,
      code: s.code,
      name: s.name,
      roleId: s.role_id,
      roleName: s.role_name,
      roleCode: s.role_code,
      fromStatus: s.from_status,
      toStatus: s.to_status,
      isEnabled: s.is_enabled,
      quorumCount: s.quorum_count,
    });
    byDefinition.set(s.definition_id, list);
  }

  const value = definitions.rows.map(d => ({
    id: d.id,
    code: d.code,
    name: d.name,
    description: d.description,
    entityType: d.entity_type,
    isActive: d.is_active,
    steps: byDefinition.get(d.id) ?? [],
  }));
  return value;
}

// A disabled GATE (from_status = to_status, S-209) contributes nothing to
// bridge: it never moved the record, so removing it changes nothing about
// what status anything else waits on. A disabled ORDINARY step is different —
// it was the thing that moved the record from from_status to to_status, so
// with it gone the record now never makes that move at all. Left alone, the
// next enabled step still waits on the disabled step's to_status, which the
// record can now never reach: not "skip straight to me", but stuck forever.
//
// This walks every disabled ordinary step's to_status back to its from_status
// — and, transitively, further back through any other disabled step that fed
// into that — so a step's *effective* from_status is wherever the record
// will actually be sitting once every disabled step in front of it is
// accounted for. Enabling Secretary review back on needs no matching
// undo: it is simply back in the chain, and nothing downstream was ever
// touched.
function bridgeDisabledSteps(
  steps: WorkflowStep[]
): (status: string) => string {
  const skipsTo = new Map<string, string>();
  for (const step of steps) {
    if (step.isEnabled) continue;
    if (step.fromStatus === step.toStatus) continue; // a gate, not a move
    skipsTo.set(step.toStatus, step.fromStatus);
  }

  return (status: string) => {
    let effective = status;
    const seen = new Set<string>();
    while (skipsTo.has(effective) && !seen.has(effective)) {
      seen.add(effective);
      effective = skipsTo.get(effective)!;
    }
    return effective;
  };
}

// The steps that actually run: disabled ones are configuration an administrator
// can see, not stages the chain waits at. This is what a workflow engine should
// consult, so that enabling the Regional Manager review (decision 2) changes
// behaviour with no code change.
//
// Every enabled step's own `fromStatus` is resolved through
// `bridgeDisabledSteps` before it reaches a caller, so a step disabled
// upstream (Secretary review, say) is not just missing from the list — the
// step after it in the chain (President decision) is rewired to wait on
// whatever status the record is actually left at, and moves it on from
// there. No caller needs to know that happened: `assertMayAct`,
// `availableActions` and every other reader of this chain compare
// `application.status` to `step.fromStatus` exactly as before.
export async function activeChain(
  definitionCode: string
): Promise<WorkflowStep[]> {
  const all = await listWorkflows();
  const definition = all.find(d => d.code === definitionCode);
  if (!definition) {
    throw new ConfigError(`Unknown workflow ${definitionCode}.`, 'not_found');
  }
  const bridge = bridgeDisabledSteps(definition.steps);
  return definition.steps
    .filter(s => s.isEnabled)
    .map(s =>
      s.fromStatus === bridge(s.fromStatus)
        ? s
        : { ...s, fromStatus: bridge(s.fromStatus) }
    );
}

export async function setStepEnabled(
  stepId: string,
  isEnabled: boolean,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    // Disabling every step would leave an application with no way forward.
    if (!isEnabled) {
      const remaining = await client.query<{ count: string }>(
        `select count(*) as count
           from workflow_step
          where definition_id = (select definition_id from workflow_step where id = $1)
            and is_enabled and id <> $1`,
        [stepId]
      );
      if (Number(remaining.rows[0]?.count ?? 0) === 0) {
        throw new ConfigError(
          'This is the last enabled step. A workflow with no steps could ' +
            'never complete.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      'update workflow_step set is_enabled = $2 where id = $1',
      [stepId, isEnabled]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStepRole(
  stepId: string,
  roleId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const role = await client.query('select 1 from role where id = $1', [
      roleId,
    ]);
    if (role.rowCount === 0) {
      throw new ConfigError('That role no longer exists.', 'not_found');
    }
    const result = await client.query(
      'update workflow_step set role_id = $2 where id = $1',
      [stepId, roleId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStepQuorum(
  stepId: string,
  quorumCount: number,
  actor: Actor
): Promise<void> {
  if (!Number.isInteger(quorumCount) || quorumCount < 1) {
    throw new ConfigError('A quorum must be a whole number of at least one.');
  }
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'update workflow_step set quorum_count = $2 where id = $1',
      [stepId, quorumCount]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStatusActive(
  statusId: string,
  isActive: boolean,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    // A status a step transitions into cannot be switched off, or the chain
    // would move a record into a state the configuration says does not exist.
    if (!isActive) {
      const inUse = await client.query<{ name: string }>(
        `select s.name
           from workflow_step s
           join workflow_status st
             on st.code in (s.from_status, s.to_status)
            and st.entity_type = (select entity_type from workflow_definition
                                   where id = s.definition_id)
          where st.id = $1 and s.is_enabled
          limit 1`,
        [statusId]
      );
      if (inUse.rowCount) {
        throw new ConfigError(
          `The step "${inUse.rows[0].name}" uses this status. Disable that ` +
            'step first.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      'update workflow_status set is_active = $2 where id = $1',
      [statusId, isActive]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That status no longer exists.', 'not_found');
    }
  });
}

// ---------------------------------------------------------------------------
// The reads above, served from the reference cache (cache.ts): a few seconds
// on the warm instance, cleared by any configuration write. Keys carry the
// arguments, so two membership types never share an entry.

export function listMembershipTypes(): Promise<MembershipType[]> {
  return cached('membership-types', readMembershipTypes);
}

export function listAccountTypes(): Promise<AccountType[]> {
  return cached('account-types', readAccountTypes);
}

// The further account types a member or non-member of a given membership
// type may still open: active, not a membership default (Shares and the MSA
// open only on a membership's own approval), eligible for that type
// (migration 0040 — empty eligibility means every type may), and not one
// they already hold (a holder keeps at most one of each). The same set the
// "Open other account" button is shown for and the account page's checkboxes
// are filtered to — computed in one place so the two never disagree.
export function openableAccountTypes(
  all: AccountType[],
  membershipTypeId: string,
  heldAccountTypeIds: Set<string>
): AccountType[] {
  return all.filter(
    t =>
      t.isActive &&
      !t.isMembershipDefault &&
      (t.eligibleMembershipTypeIds.length === 0 ||
        t.eligibleMembershipTypeIds.includes(membershipTypeId)) &&
      !heldAccountTypeIds.has(t.id)
  );
}

export function currentFeeVersion(
  scheduleId: string
): Promise<CurrentFeeVersion | null> {
  return cached(`fee-version:${scheduleId}`, () =>
    readCurrentFeeVersion(scheduleId)
  );
}

export function listDocumentTypes(): Promise<DocumentType[]> {
  return cached('document-types', readDocumentTypes);
}

export function listChecklists(): Promise<DocumentChecklist[]> {
  return cached('checklists', readChecklists);
}

export function checklistForMembershipType(
  membershipTypeCode: string
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  return cached(`checklist:membership:${membershipTypeCode}`, () =>
    readChecklistForMembershipType(membershipTypeCode)
  );
}

export function checklistForAccountTypes(
  accountTypeCodes: string[]
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  return cached(`checklist:accounts:${accountTypeCodes.join(',')}`, () =>
    readChecklistForAccountTypes(accountTypeCodes)
  );
}

export function checklistForNonMemberApplicant(
  membershipTypeCode: string
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  return cached(`checklist:non-member-applicant:${membershipTypeCode}`, () =>
    readChecklistForNonMemberApplicant(membershipTypeCode)
  );
}

export function checklistForNonMemberAccount(
  membershipTypeCode: string,
  accountTypeCodes: string[]
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  return cached(
    `checklist:non-member-account:${membershipTypeCode}:${accountTypeCodes.join(',')}`,
    () => readChecklistForNonMemberAccount(membershipTypeCode, accountTypeCodes)
  );
}

export function listWorkflowStatuses(
  entityType?: string
): Promise<WorkflowStatus[]> {
  return cached(`workflow-statuses:${entityType ?? ''}`, () =>
    readWorkflowStatuses(entityType)
  );
}

export function listWorkflows(): Promise<WorkflowDefinition[]> {
  return cached('workflows', readWorkflows);
}

// ---------------------------------------------------------------------------
// System settings — plain config_entry rows (0003), rather than a
// purpose-built table for a single number. Each setting here is exactly the
// case that table exists for: a business value the FRD leaves open, changed
// without a release, with its own history for free.
// ---------------------------------------------------------------------------

// Officer feedback: a cash payment above this needs a source of fund note,
// and reminds the officer to also complete the paper Source of Fund form
// (outside this application). Defaults to 45,000 (MUR) if never configured —
// migration 0032 seeds the same value, so this default is only ever read
// before that migration has run.
const CASH_SOURCE_OF_FUND_THRESHOLD_KEY =
  'payment.cash_source_of_fund_threshold';
const DEFAULT_CASH_SOURCE_OF_FUND_THRESHOLD = '45000';

async function readCashSourceOfFundThreshold(): Promise<string> {
  const result = await query<{ value: string }>(
    `select value::text as value from config_entry where key = $1`,
    [CASH_SOURCE_OF_FUND_THRESHOLD_KEY]
  );
  return result.rows[0]?.value ?? DEFAULT_CASH_SOURCE_OF_FUND_THRESHOLD;
}

export function cashSourceOfFundThreshold(): Promise<string> {
  return cached('cash-source-of-fund-threshold', readCashSourceOfFundThreshold);
}

export async function setCashSourceOfFundThreshold(
  amount: string,
  actor: Actor
): Promise<void> {
  // A light check, not money.ts's own toCents: this module sits below
  // payments/, and pulling that dependency in the other direction for one
  // regex is not worth it. Whatever passes here still has to parse as an
  // amount everywhere it is actually used to gate a payment.
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
    throw new ConfigError(
      `${amount || 'That'} is not a whole amount in rupees.`
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::numeric), 'number',
         'A cash payment strictly above this amount (MUR) requires a ' ||
         'source of fund note before a receipt can be issued, and reminds ' ||
         'the officer to also complete the paper Source of Fund form.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [CASH_SOURCE_OF_FUND_THRESHOLD_KEY, amount, actor.userId]
    );
  });
}

// Officer feedback: a cash payment strictly above this is refused outright —
// not a reminder like the threshold above, a hard ceiling nothing on this
// screen can override. Defaults to 500,000 (MUR) if never configured —
// migration 0062 seeds the same value, so this default is only ever read
// before that migration has run.
const CASH_MAXIMUM_KEY = 'payment.cash_maximum';
const DEFAULT_CASH_MAXIMUM = '500000';

async function readCashMaximum(): Promise<string> {
  const result = await query<{ value: string }>(
    `select value::text as value from config_entry where key = $1`,
    [CASH_MAXIMUM_KEY]
  );
  return result.rows[0]?.value ?? DEFAULT_CASH_MAXIMUM;
}

export function cashMaximum(): Promise<string> {
  return cached('cash-maximum', readCashMaximum);
}

export async function setCashMaximum(
  amount: string,
  actor: Actor
): Promise<void> {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
    throw new ConfigError(
      `${amount || 'That'} is not a whole amount in rupees.`
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::numeric), 'number',
         'A cash payment strictly above this amount (MUR) is refused ' ||
         'outright — the officer is not authorised to take it, and no ' ||
         'override exists on this screen.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [CASH_MAXIMUM_KEY, amount, actor.userId]
    );
  });
}

// The Takaful benefit a deceased member's claim pays beside the balances
// of their accounts (S-1704): the Society's figure, Administrator-editable.
// Seeded 15,000 by migration 0079; the default here is read only before it
// has run.
const TAKAFUL_BENEFIT_KEY = 'demised.takaful_benefit';
const DEFAULT_TAKAFUL_BENEFIT = '15000';

async function readTakafulBenefit(): Promise<string> {
  const result = await query<{ value: string }>(
    `select value::text as value from config_entry where key = $1`,
    [TAKAFUL_BENEFIT_KEY]
  );
  return result.rows[0]?.value ?? DEFAULT_TAKAFUL_BENEFIT;
}

export function takafulBenefit(): Promise<string> {
  return cached('takaful-benefit', readTakafulBenefit);
}

export async function setTakafulBenefit(
  amount: string,
  actor: Actor
): Promise<void> {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
    throw new ConfigError(`${amount || 'That'} is not an amount in rupees.`);
  }
  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::numeric), 'number',
         'The Takaful benefit (MUR) paid to the claimant of a deceased ' ||
         'member, beside the balances of their accounts.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [TAKAFUL_BENEFIT_KEY, amount.trim(), actor.userId]
    );
  });
}

// The margin (MUR) within which a posted debit sends the holder the
// balance.near_floor advisory (S-1803): the Society's figure to widen or
// narrow. Seeded 500 by migration 0081; the default here is read only
// before it has run. 0 turns the advisory off.
const NEAR_FLOOR_MARGIN_KEY = 'balance.near_floor_margin';
const DEFAULT_NEAR_FLOOR_MARGIN = '500';

async function readNearFloorMargin(): Promise<string> {
  const result = await query<{ value: string }>(
    `select value::text as value from config_entry where key = $1`,
    [NEAR_FLOOR_MARGIN_KEY]
  );
  return result.rows[0]?.value ?? DEFAULT_NEAR_FLOOR_MARGIN;
}

export function nearFloorMargin(): Promise<string> {
  return cached('near-floor-margin', readNearFloorMargin);
}

export async function setNearFloorMargin(
  amount: string,
  actor: Actor
): Promise<void> {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
    throw new ConfigError(`${amount || 'That'} is not an amount in rupees.`);
  }
  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::numeric), 'number',
         'A posted debit that leaves an account within this amount (MUR) ' ||
         'of its type''s minimum balance sends the holder a ' ||
         'balance.near_floor advisory. 0 turns the advisory off.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [NEAR_FLOOR_MARGIN_KEY, amount.trim(), actor.userId]
    );
  });
}

// ---------------------------------------------------------------------------
// S-2102 · Which transactions a member may start from the app
// ---------------------------------------------------------------------------
// Seeded empty by migration 0085: the endpoints exist from day one and
// refuse until the Society switches each one on. Read on every member write,
// through the short cache like the rest of the reference configuration.
export type MemberOperation = 'deposit' | 'withdrawal' | 'transfer';
export const MEMBER_OPERATIONS: readonly MemberOperation[] = [
  'deposit',
  'withdrawal',
  'transfer',
];
const MEMBER_OPERATIONS_KEY = 'member_api.enabled_operations';

function isMemberOperation(value: unknown): value is MemberOperation {
  return (MEMBER_OPERATIONS as readonly unknown[]).includes(value);
}

async function readMemberOperations(): Promise<MemberOperation[]> {
  const result = await query<{ value: unknown }>(
    `select value from config_entry where key = $1`,
    [MEMBER_OPERATIONS_KEY]
  );
  const value = result.rows[0]?.value;
  return Array.isArray(value) ? value.filter(isMemberOperation) : [];
}

export function enabledMemberOperations(): Promise<MemberOperation[]> {
  return cached('member-operations', readMemberOperations);
}

export async function setEnabledMemberOperations(
  operations: readonly string[],
  actor: Actor
): Promise<void> {
  const unknown = operations.find(o => !isMemberOperation(o));
  if (unknown !== undefined) {
    throw new ConfigError(`${unknown || 'That'} is not a transaction.`);
  }
  const enabled = MEMBER_OPERATIONS.filter(o => operations.includes(o));
  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, $2::jsonb, 'json',
         'Which transactions a member may start from the app: any of ' ||
         '"deposit", "withdrawal" and "transfer". Empty: none.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [MEMBER_OPERATIONS_KEY, JSON.stringify(enabled), actor.userId]
    );
  });
}

// ---------------------------------------------------------------------------
// S-804, S-805 · Dormancy: after how long, and how a member comes back
// ---------------------------------------------------------------------------
// Seeded by migration 0086; the defaults here are read only before it has
// run. dormancy.months is what the nightly job measures against (0 turns it
// off); dormancy.reactivation names the rule a dormant member comes back
// under — "staff" is the only one built, the backlog's default until the
// Society confirms another, and naming it here means another is a value.
const DORMANCY_MONTHS_KEY = 'dormancy.months';
const DEFAULT_DORMANCY_MONTHS = 12;
const DORMANCY_REACTIVATION_KEY = 'dormancy.reactivation';
export const DORMANCY_REACTIVATIONS = ['staff'] as const;
export type DormancyReactivation = (typeof DORMANCY_REACTIVATIONS)[number];

async function readDormancyMonths(): Promise<number> {
  const result = await query<{ value: unknown }>(
    `select value from config_entry where key = $1`,
    [DORMANCY_MONTHS_KEY]
  );
  const value = Number(result.rows[0]?.value);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_DORMANCY_MONTHS;
}

export function dormancyMonths(): Promise<number> {
  return cached('dormancy-months', readDormancyMonths);
}

export async function setDormancyMonths(
  months: string,
  actor: Actor
): Promise<void> {
  const trimmed = months.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    throw new ConfigError(
      `${months || 'That'} is not a whole number of months (0 to 999).`
    );
  }
  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::int), 'number',
         'An active member with no posted transaction and no fee payment ' ||
         'on any of their accounts for this many months is marked dormant ' ||
         'by the nightly dormancy-detection job. 0 turns detection off.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [DORMANCY_MONTHS_KEY, Number(trimmed), actor.userId]
    );
  });
}

async function readDormancyReactivation(): Promise<DormancyReactivation> {
  const result = await query<{ value: unknown }>(
    `select value from config_entry where key = $1`,
    [DORMANCY_REACTIVATION_KEY]
  );
  const value = result.rows[0]?.value;
  return (DORMANCY_REACTIVATIONS as readonly unknown[]).includes(value)
    ? (value as DormancyReactivation)
    : 'staff';
}

export function dormancyReactivation(): Promise<DormancyReactivation> {
  return cached('dormancy-reactivation', readDormancyReactivation);
}

export async function setDormancyReactivation(
  rule: string,
  actor: Actor
): Promise<void> {
  if (!(DORMANCY_REACTIVATIONS as readonly string[]).includes(rule)) {
    throw new ConfigError(`${rule || 'That'} is not a reactivation rule.`);
  }
  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::text), 'string',
         'How a dormant member becomes active again. "staff": an officer ' ||
         'holding member.reactivate does it on the member''s page, with a ' ||
         'reason.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [DORMANCY_REACTIVATION_KEY, rule, actor.userId]
    );
  });
}

// The pre-checks a resignation runs before it can be submitted (S-1703),
// each its own switch: named when it blocks, and the Society's to turn off.
// Seeded by migration 0078; the defaults here are read only before it has
// run. Financing is a hook for Phase 3/4 with nothing behind it, off.
export interface ResignationChecks {
  pendingTransactions: boolean;
  unpaidFees: boolean;
  financing: boolean;
}

const RESIGNATION_CHECK_KEYS: Record<keyof ResignationChecks, string> = {
  pendingTransactions: 'resignation.check_pending_transactions',
  unpaidFees: 'resignation.check_unpaid_fees',
  financing: 'resignation.check_financing',
};
const DEFAULT_RESIGNATION_CHECKS: ResignationChecks = {
  pendingTransactions: true,
  unpaidFees: true,
  financing: false,
};

async function readResignationChecks(): Promise<ResignationChecks> {
  const result = await query<{ key: string; value: boolean }>(
    `select key, value from config_entry where key = any($1::text[])`,
    [Object.values(RESIGNATION_CHECK_KEYS)]
  );
  const byKey = new Map(result.rows.map(r => [r.key, r.value === true]));
  const checks = { ...DEFAULT_RESIGNATION_CHECKS };
  for (const name of Object.keys(checks) as (keyof ResignationChecks)[]) {
    const value = byKey.get(RESIGNATION_CHECK_KEYS[name]);
    if (value !== undefined) checks[name] = value;
  }
  return checks;
}

export function resignationChecks(): Promise<ResignationChecks> {
  return cached('resignation-checks', readResignationChecks);
}

export async function setResignationChecks(
  checks: ResignationChecks,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    for (const name of Object.keys(checks) as (keyof ResignationChecks)[]) {
      await client.query(
        `update config_entry
            set value = to_jsonb($2::boolean), updated_by = $3
          where key = $1`,
        [RESIGNATION_CHECK_KEYS[name], checks[name], actor.userId]
      );
    }
  });
}

// The checklist an officer works through, on screen, before signing the
// Source of Fund form for a cash payment above the threshold above. The
// Society's own wording, not this codebase's — seeded with one placeholder
// item by migration 0062 rather than invented compliance language nobody
// has approved, and replaced from Configuration -> Fee schedules before
// go-live.
const CASH_SOURCE_OF_FUND_CHECKLIST_KEY =
  'payment.cash_source_of_fund_checklist';
const DEFAULT_CASH_SOURCE_OF_FUND_CHECKLIST: string[] = [];

async function readCashSourceOfFundChecklist(): Promise<string[]> {
  const result = await query<{ value: unknown }>(
    `select value from config_entry where key = $1`,
    [CASH_SOURCE_OF_FUND_CHECKLIST_KEY]
  );
  const value = result.rows[0]?.value;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : DEFAULT_CASH_SOURCE_OF_FUND_CHECKLIST;
}

export function cashSourceOfFundChecklist(): Promise<string[]> {
  return cached('cash-source-of-fund-checklist', readCashSourceOfFundChecklist);
}

export async function setCashSourceOfFundChecklist(
  items: string[],
  actor: Actor
): Promise<void> {
  const cleaned = items.map(item => item.trim()).filter(item => item !== '');
  if (cleaned.length === 0) {
    throw new ConfigError(
      'Enter at least one checklist item, or the form has nothing for an ' +
        'officer to confirm.'
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    await client.query(
      `insert into config_entry (key, value, value_type, description, updated_by)
       values (
         $1, to_jsonb($2::text[]), 'json',
         'What the officer confirms, item by item, before signing the ' ||
         'on-screen Source of Fund form for a cash payment above ' ||
         'payment.cash_source_of_fund_threshold.',
         $3
       )
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by`,
      [CASH_SOURCE_OF_FUND_CHECKLIST_KEY, cleaned, actor.userId]
    );
  });
}

// ---------------------------------------------------------------------------
// S-1307 · Payment methods
// ---------------------------------------------------------------------------
// How money moves, as configuration (migration 0067). A method carries what
// the rest of the system asks of one: whether the cash controls apply
// (isCash), whether the form demands a reference (requiresReference),
// whether the money reaches a bank (touchesBank), and whether it is the
// system's own — 'migration', the legacy import's mark — which is never
// offered on a form and not an administrator's to change (isSystem).
export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  isCash: boolean;
  requiresReference: boolean;
  touchesBank: boolean;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

async function readPaymentMethods(): Promise<PaymentMethod[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    is_cash: boolean;
    requires_reference: boolean;
    touches_bank: boolean;
    is_system: boolean;
    is_active: boolean;
    sort_order: number;
  }>(
    `select id, code, name, is_cash, requires_reference, touches_bank,
            is_system, is_active, sort_order
       from payment_method
      order by sort_order, name`
  );
  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isCash: r.is_cash,
    requiresReference: r.requires_reference,
    touchesBank: r.touches_bank,
    isSystem: r.is_system,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

export function listPaymentMethods(): Promise<PaymentMethod[]> {
  return cached('payment-methods', readPaymentMethods);
}

// What an officer's form offers: active, and not the system's own.
export async function offeredPaymentMethods(): Promise<PaymentMethod[]> {
  return (await listPaymentMethods()).filter(m => m.isActive && !m.isSystem);
}

// The method a record names, offered or not — a receipt taken by a method
// since retired still has to say how it was paid.
export async function paymentMethodByCode(
  code: string
): Promise<PaymentMethod | null> {
  return (await listPaymentMethods()).find(m => m.code === code) ?? null;
}

export interface PaymentMethodInput {
  name: string;
  isCash: boolean;
  requiresReference: boolean;
  touchesBank: boolean;
  isActive: boolean;
}

export async function createPaymentMethod(
  input: PaymentMethodInput & { code: string },
  actor: Actor
): Promise<string> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ConfigError(
      'A code must start with a letter and contain only lowercase letters, ' +
        'digits and underscores.'
    );
  }
  if (!input.name.trim()) throw new ConfigError('A name is required.');

  return withConfigurationActor(actorFor(actor), async client => {
    const existing = await client.query(
      'select 1 from payment_method where code = $1',
      [code]
    );
    if (existing.rowCount) {
      throw new ConfigError(
        `A payment method with code ${code} already exists.`,
        'conflict'
      );
    }
    const result = await client.query<{ id: string }>(
      `insert into payment_method
         (code, name, is_cash, requires_reference, touches_bank, is_active,
          sort_order)
       values ($1, $2, $3, $4, $5, $6,
               coalesce((select max(sort_order) + 10 from payment_method
                          where not is_system), 10))
       returning id`,
      [
        code,
        input.name.trim(),
        input.isCash,
        input.requiresReference,
        input.touchesBank,
        input.isActive,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updatePaymentMethod(
  id: string,
  input: PaymentMethodInput,
  actor: Actor
): Promise<void> {
  if (!input.name.trim()) throw new ConfigError('A name is required.');

  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update payment_method
          set name = $2, is_cash = $3, requires_reference = $4,
              touches_bank = $5, is_active = $6
        where id = $1 and not is_system`,
      [
        id,
        input.name.trim(),
        input.isCash,
        input.requiresReference,
        input.touchesBank,
        input.isActive,
      ]
    );
    if (result.rowCount === 0) {
      const system = await client.query(
        'select 1 from payment_method where id = $1 and is_system',
        [id]
      );
      throw system.rowCount
        ? new ConfigError(
            'This method is written by the system and cannot be changed.',
            'conflict'
          )
        : new ConfigError('That payment method no longer exists.', 'not_found');
    }
  });
}

// ---------------------------------------------------------------------------
// S-1401 · The approval matrix
// ---------------------------------------------------------------------------
// Which chain — or none — a transaction falls under (migration 0070).
// Ordered within a kind; the first match wins; a rule with no chain means
// "post immediately". resolveRoute (ledger/routing.ts) is the reader; this
// is the administrator's side of it.
export const TRANSACTION_KINDS = [
  'deposit',
  'withdrawal',
  'transfer',
  'closure',
  'resignation',
  'demise',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
// What a `transaction` row may be: the matrix's kinds, plus the legs of a
// transfer (S-1504) and reversals (S-1505), which the matrix never routes
// by name — a transfer's debit leg goes by 'transfer' or 'withdrawal'.
export type TransactionRowKind = TransactionKind | 'transfer_leg' | 'reversal';

export interface ApprovalRule {
  id: string;
  kind: TransactionKind;
  accountTypeId: string | null;
  accountTypeName: string | null;
  initiatingRoleId: string | null;
  initiatingRoleCode: string | null;
  initiatingRoleName: string | null;
  amountFrom: string;
  // Null: and above.
  amountTo: string | null;
  // Null: post immediately.
  workflowDefinitionId: string | null;
  workflowCode: string | null;
  workflowName: string | null;
  note: string;
  sortOrder: number;
  isActive: boolean;
}

async function readApprovalRules(): Promise<ApprovalRule[]> {
  const result = await query<{
    id: string;
    kind: TransactionKind;
    account_type_id: string | null;
    account_type_name: string | null;
    initiating_role_id: string | null;
    initiating_role_code: string | null;
    initiating_role_name: string | null;
    amount_from: string;
    amount_to: string | null;
    workflow_definition_id: string | null;
    workflow_code: string | null;
    workflow_name: string | null;
    note: string;
    sort_order: number;
    is_active: boolean;
  }>(
    `select r.id, r.kind, r.account_type_id, t.name as account_type_name,
            r.initiating_role_id, ro.code as initiating_role_code,
            ro.name as initiating_role_name,
            r.amount_from, r.amount_to,
            r.workflow_definition_id, d.code as workflow_code,
            d.name as workflow_name,
            r.note, r.sort_order, r.is_active
       from approval_rule r
       left join account_type t on t.id = r.account_type_id
       left join role ro on ro.id = r.initiating_role_id
       left join workflow_definition d on d.id = r.workflow_definition_id
      order by r.kind, r.sort_order, r.created_at`
  );
  return result.rows.map(r => ({
    id: r.id,
    kind: r.kind,
    accountTypeId: r.account_type_id,
    accountTypeName: r.account_type_name,
    initiatingRoleId: r.initiating_role_id,
    initiatingRoleCode: r.initiating_role_code,
    initiatingRoleName: r.initiating_role_name,
    amountFrom: r.amount_from,
    amountTo: r.amount_to,
    workflowDefinitionId: r.workflow_definition_id,
    workflowCode: r.workflow_code,
    workflowName: r.workflow_name,
    note: r.note,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  }));
}

export function listApprovalRules(): Promise<ApprovalRule[]> {
  return cached('approval-rules', readApprovalRules);
}

export interface ApprovalRuleInput {
  kind: string;
  accountTypeId: string | null;
  initiatingRoleId: string | null;
  amountFrom: string;
  amountTo: string | null;
  workflowDefinitionId: string | null;
  note: string;
  isActive: boolean;
}

function validateApprovalRule(input: ApprovalRuleInput): {
  kind: TransactionKind;
  amountFrom: string;
  amountTo: string | null;
} {
  if (!(TRANSACTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new ConfigError('Choose which kind of transaction the rule is for.');
  }
  const amountFrom = input.amountFrom.trim() || '0';
  validateAmount(amountFrom);
  const amountTo = input.amountTo?.trim() || null;
  if (amountTo !== null) {
    validateAmount(amountTo);
    if (Number(amountTo) < Number(amountFrom)) {
      throw new ConfigError('The band’s upper amount is below its lower.');
    }
  }
  return { kind: input.kind as TransactionKind, amountFrom, amountTo };
}

export async function createApprovalRule(
  input: ApprovalRuleInput,
  actor: Actor
): Promise<string> {
  const { kind, amountFrom, amountTo } = validateApprovalRule(input);
  return withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query<{ id: string }>(
      `insert into approval_rule
         (kind, account_type_id, initiating_role_id, amount_from, amount_to,
          workflow_definition_id, note, is_active, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8,
               coalesce((select max(sort_order) + 10 from approval_rule
                          where kind = $1), 10))
       returning id`,
      [
        kind,
        input.accountTypeId,
        input.initiatingRoleId,
        amountFrom,
        amountTo,
        input.workflowDefinitionId,
        input.note.trim(),
        input.isActive,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updateApprovalRule(
  id: string,
  input: ApprovalRuleInput,
  actor: Actor
): Promise<void> {
  const { kind, amountFrom, amountTo } = validateApprovalRule(input);
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update approval_rule
          set kind = $2, account_type_id = $3, initiating_role_id = $4,
              amount_from = $5, amount_to = $6, workflow_definition_id = $7,
              note = $8, is_active = $9
        where id = $1`,
      [
        id,
        kind,
        input.accountTypeId,
        input.initiatingRoleId,
        amountFrom,
        amountTo,
        input.workflowDefinitionId,
        input.note.trim(),
        input.isActive,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That rule no longer exists.', 'not_found');
    }
  });
}

// Up or down within its kind: the order is the matrix, since the first
// match wins.
export async function moveApprovalRule(
  id: string,
  direction: 'up' | 'down',
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const rows = await client.query<{ id: string; sort_order: number }>(
      `select id, sort_order from approval_rule
        where kind = (select kind from approval_rule where id = $1)
        order by sort_order, created_at`,
      [id]
    );
    const index = rows.rows.findIndex(r => r.id === id);
    if (index === -1) {
      throw new ConfigError('That rule no longer exists.', 'not_found');
    }
    const other = rows.rows[direction === 'up' ? index - 1 : index + 1];
    if (!other) return;
    // Renumber the whole kind, swapped: two rules that happened to share a
    // sort order would otherwise never change places.
    const order = rows.rows.map(r => r.id);
    [order[index], order[index + (direction === 'up' ? -1 : 1)]] = [
      order[index + (direction === 'up' ? -1 : 1)],
      order[index],
    ];
    for (const [position, ruleId] of order.entries()) {
      await client.query(
        'update approval_rule set sort_order = $2 where id = $1',
        [ruleId, (position + 1) * 10]
      );
    }
  });
}

// A rule a transaction was routed by stays, because the trail names it;
// deactivate instead.
export async function deleteApprovalRule(
  id: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const used = await client.query(
      `select 1 from transaction where approval_rule_id = $1
       union all
       select 1 from transaction_transition where approval_rule_id = $1
       limit 1`,
      [id]
    );
    if (used.rowCount) {
      throw new ConfigError(
        'This rule has routed a transaction, so it stays on the trail. ' +
          'Deactivate it instead.',
        'conflict'
      );
    }
    const result = await client.query(
      'delete from approval_rule where id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That rule no longer exists.', 'not_found');
    }
  });
}

// ---------------------------------------------------------------------------
// S-1901 · The Society's bank accounts
// ---------------------------------------------------------------------------
// Configuration (migration 0082): which bank accounts the Society has, so
// a transaction that touches a bank can say which (S-1902) and Phase 5 can
// reconcile a statement against it. The number is the sensitive part:
// bank_account.view reads it masked to its last four digits,
// bank_account.manage whole. The balance is not here — it is derived from
// posted transactions (src/lib/ledger/bank-accounts.ts), never stored.
export interface BankAccount {
  id: string;
  code: string;
  name: string;
  bankName: string;
  // Masked unless the caller may see it whole (maskAccountNumber).
  accountNumber: string;
  currency: string;
  openingBalance: string;
  // ISO date: the day the system started recording against it.
  openingDate: string;
  isActive: boolean;
  sortOrder: number;
}

export const PERMISSION_BANK_ACCOUNT_VIEW = 'bank_account.view';
export const PERMISSION_BANK_ACCOUNT_MANAGE = 'bank_account.manage';

// Everything but the last four characters, so a list a clerk can see
// identifies the account without giving the number away.
export function maskAccountNumber(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 4) return '••••';
  return '•'.repeat(trimmed.length - 4) + trimmed.slice(-4);
}

async function readBankAccounts(): Promise<BankAccount[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    bank_name: string;
    account_number: string;
    currency: string;
    opening_balance: string;
    opening_date: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `select id, code, name, bank_name, account_number, currency,
            opening_balance::text as opening_balance,
            opening_date::text as opening_date, is_active, sort_order
       from bank_account
      order by sort_order, name`
  );
  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    currency: r.currency,
    openingBalance: r.opening_balance,
    openingDate: r.opening_date,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

// The full list, numbers whole: for a caller that has checked
// bank_account.manage, and for the ledger, which names an account by id.
export function listBankAccounts(): Promise<BankAccount[]> {
  return cached('bank-accounts', readBankAccounts);
}

// The list as a holder of bank_account.view may see it.
export async function listBankAccountsMasked(): Promise<BankAccount[]> {
  return (await listBankAccounts()).map(a => ({
    ...a,
    accountNumber: maskAccountNumber(a.accountNumber),
  }));
}

// What a form offers a transaction that touches a bank: the active ones.
export async function offeredBankAccounts(): Promise<BankAccount[]> {
  return (await listBankAccounts()).filter(a => a.isActive);
}

export async function bankAccountById(id: string): Promise<BankAccount | null> {
  return (await listBankAccounts()).find(a => a.id === id) ?? null;
}

export interface BankAccountInput {
  name: string;
  bankName: string;
  accountNumber: string;
  currency?: string;
  openingBalance: string;
  openingDate?: string;
  isActive: boolean;
}

function validateBankAccount(input: BankAccountInput): {
  name: string;
  bankName: string;
  accountNumber: string;
  currency: string;
  openingBalance: string;
  openingDate: string | null;
} {
  const name = input.name.trim();
  const bankName = input.bankName.trim();
  const accountNumber = input.accountNumber.trim();
  const currency = (input.currency ?? 'MUR').trim().toUpperCase() || 'MUR';
  const openingBalance = input.openingBalance.trim().replace(/,/g, '') || '0';
  const openingDate = (input.openingDate ?? '').trim() || null;
  if (!name) throw new ConfigError('A name is required.');
  if (!bankName) throw new ConfigError('The bank is required.');
  if (!/^[A-Za-z0-9 -]{4,40}$/.test(accountNumber)) {
    throw new ConfigError(
      'The account number is letters, digits, spaces and dashes, 4 to 40 long.'
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ConfigError('The currency is a three-letter code, such as MUR.');
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(openingBalance)) {
    throw new ConfigError(
      `${input.openingBalance || 'That'} is not an amount in rupees.`
    );
  }
  if (openingDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) {
    throw new ConfigError('The opening date is not a date.');
  }
  return {
    name,
    bankName,
    accountNumber,
    currency,
    openingBalance,
    openingDate,
  };
}

export async function createBankAccount(
  input: BankAccountInput & { code: string },
  actor: Actor
): Promise<string> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ConfigError(
      'A code must start with a letter and contain only lowercase letters, ' +
        'digits and underscores.'
    );
  }
  const fields = validateBankAccount(input);
  return withConfigurationActor(actorFor(actor), async client => {
    const existing = await client.query(
      'select 1 from bank_account where code = $1',
      [code]
    );
    if (existing.rowCount) {
      throw new ConfigError(
        `A bank account with code ${code} already exists.`,
        'conflict'
      );
    }
    const result = await client.query<{ id: string }>(
      `insert into bank_account
         (code, name, bank_name, account_number, currency, opening_balance,
          opening_date, is_active, sort_order)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::date, current_date), $8,
               coalesce((select max(sort_order) + 10 from bank_account), 10))
       returning id`,
      [
        code,
        fields.name,
        fields.bankName,
        fields.accountNumber,
        fields.currency,
        fields.openingBalance,
        fields.openingDate,
        input.isActive,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updateBankAccount(
  id: string,
  input: BankAccountInput,
  actor: Actor
): Promise<void> {
  const fields = validateBankAccount(input);
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update bank_account
          set name = $2, bank_name = $3, account_number = $4, currency = $5,
              opening_balance = $6,
              opening_date = coalesce($7::date, opening_date),
              is_active = $8
        where id = $1`,
      [
        id,
        fields.name,
        fields.bankName,
        fields.accountNumber,
        fields.currency,
        fields.openingBalance,
        fields.openingDate,
        input.isActive,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That bank account no longer exists.', 'not_found');
    }
  });
}
