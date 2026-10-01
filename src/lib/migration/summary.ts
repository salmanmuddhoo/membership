// What the legacy migration has brought in (officer direction): how many
// members and non-members were imported, and the funds that came with them —
// members by membership type (Individual, Corporate, Minor), non-members by
// the accounts they hold (HSA, Investment). Read from the records themselves
// rather than from a batch log: a migrated member or customer carries its
// legacy_code (0047, 0049), and its opening balances are the one payment
// the import records against its application, method 'migration'
// (payments.ts recordMigrationOpeningBalances) — Shares and the MSA as
// payment lines, every other account as a payment account line. A voided
// receipt takes its payment out of the funds.
import { query } from '../db/pool';
import { toCents } from '../payments/money';

export interface MigrationSummary {
  members: { typeName: string; holders: number; amountCents: number }[];
  nonMembers: {
    holders: number;
    amountCents: number;
    accounts: { typeName: string; count: number; amountCents: number }[];
  };
  total: { holders: number; amountCents: number };
}

const MIGRATION_PAYMENTS = `
  select p.id, p.application_id
    from payment p
    join receipt_number rn on rn.id = p.receipt_number_id
   where p.method = 'migration' and rn.state <> 'void'`;

/** Everything imported from the legacy register to date. */
export async function migrationSummary(): Promise<MigrationSummary> {
  const [members, customers, accounts] = await Promise.all([
    query<{ type_name: string; holders: string; amount: string }>(
      `with mig as (${MIGRATION_PAYMENTS}),
            funds as (
              select mig.application_id, l.amount
                from mig join payment_line l on l.payment_id = mig.id
              union all
              select mig.application_id, l.amount
                from mig join payment_account_line l on l.payment_id = mig.id)
       select mt.name as type_name, count(distinct m.id)::text as holders,
              coalesce(sum(f.amount), 0)::text as amount
         from member m
         join membership_type mt on mt.id = m.membership_type_id
         left join funds f on f.application_id = m.application_id
        where m.legacy_code is not null
        group by mt.name, mt.sort_order
        order by mt.sort_order, mt.name`
    ),
    query<{ holders: string; amount: string }>(
      `with mig as (${MIGRATION_PAYMENTS})
       select count(distinct c.id)::text as holders,
              coalesce(sum(l.amount), 0)::text as amount
         from customer c
         left join mig on mig.application_id = c.application_id
         left join payment_account_line l on l.payment_id = mig.id
        where c.legacy_code is not null`
    ),
    query<{ type_name: string; count: string; amount: string }>(
      `with mig as (${MIGRATION_PAYMENTS})
       select at.name as type_name, count(*)::text as count,
              sum(l.amount)::text as amount
         from customer c
         join mig on mig.application_id = c.application_id
         join payment_account_line l on l.payment_id = mig.id
         join account_type at on at.id = l.account_type_id
        where c.legacy_code is not null
        group by at.name, at.sort_order
        order by at.sort_order, at.name`
    ),
  ]);

  const memberRows = members.rows.map(r => ({
    typeName: r.type_name,
    holders: Number(r.holders),
    amountCents: toCents(r.amount),
  }));
  const nonMembers = {
    holders: Number(customers.rows[0]?.holders ?? 0),
    amountCents: toCents(customers.rows[0]?.amount ?? '0'),
    accounts: accounts.rows.map(r => ({
      typeName: r.type_name,
      count: Number(r.count),
      amountCents: toCents(r.amount),
    })),
  };
  return {
    members: memberRows,
    nonMembers,
    total: {
      holders:
        memberRows.reduce((n, r) => n + r.holders, 0) + nonMembers.holders,
      amountCents:
        memberRows.reduce((n, r) => n + r.amountCents, 0) +
        nonMembers.amountCents,
    },
  };
}

/**
 * What one upload added: the summary after it, less the summary before. A
 * row that only updated a record already on file adds no holder, and a
 * balance already on file is not written twice, so neither is counted.
 */
export function summaryDifference(
  before: MigrationSummary,
  after: MigrationSummary
): MigrationSummary {
  const memberBefore = new Map(before.members.map(r => [r.typeName, r]));
  const accountBefore = new Map(
    before.nonMembers.accounts.map(r => [r.typeName, r])
  );
  const members = after.members
    .map(r => ({
      typeName: r.typeName,
      holders: r.holders - (memberBefore.get(r.typeName)?.holders ?? 0),
      amountCents:
        r.amountCents - (memberBefore.get(r.typeName)?.amountCents ?? 0),
    }))
    .filter(r => r.holders !== 0 || r.amountCents !== 0);
  const accounts = after.nonMembers.accounts
    .map(r => ({
      typeName: r.typeName,
      count: r.count - (accountBefore.get(r.typeName)?.count ?? 0),
      amountCents:
        r.amountCents - (accountBefore.get(r.typeName)?.amountCents ?? 0),
    }))
    .filter(r => r.count !== 0 || r.amountCents !== 0);
  return {
    members,
    nonMembers: {
      holders: after.nonMembers.holders - before.nonMembers.holders,
      amountCents: after.nonMembers.amountCents - before.nonMembers.amountCents,
      accounts,
    },
    total: {
      holders: after.total.holders - before.total.holders,
      amountCents: after.total.amountCents - before.total.amountCents,
    },
  };
}
