// Who is paid when an account holder dies, shared by a member's demised
// claim (demises.ts, S-1704) and a deceased non-member's closure
// (closures.ts, business decision after the lifecycle test): the nominee
// the holder named on their application, or another person in full.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query } from '../db/pool';
import { loadApplication } from '../applications/capture';
import type { Claimant } from './review';

export interface ClaimantInput {
  kind: 'nominee' | 'other';
  // For 'other'. For 'nominee' these come from the application.
  name?: string;
  nic?: string;
  address?: string;
  relation?: string;
  // Where they are written to (S-1705); either may be left out.
  email?: string;
  mobile?: string;
}

/** The first nominee on an application, as a claimant; null if none. */
export async function nomineeOnApplication(
  applicationId: string | null
): Promise<Claimant | null> {
  if (!applicationId) return null;
  const application = await loadApplication(applicationId);
  const party = application?.parties.find(
    p => p.subject === 'nominee' && p.ordinal === 1
  );
  if (!party) return null;
  const v = party.values;
  const name = [v.name, v.surname]
    .map(part => (part ?? '').trim())
    .filter(part => part !== '')
    .join(' ');
  if (name === '') return null;
  return {
    name,
    nic: (v.nic ?? '').trim(),
    address: (v.address ?? '').trim(),
    relation: 'Nominee',
    email: (v.email ?? '').trim() || null,
    mobile: (v.mobile ?? '').trim() || null,
  };
}

/**
 * The claimant an officer named: the nominee on file, or another person
 * with every field a payout needs. Refused in the caller's own words.
 */
export function claimantFrom(
  input: ClaimantInput,
  nominee: Claimant | null,
  refuse: (message: string) => Error,
  noNominee: string
): Claimant {
  if (input.kind === 'nominee') {
    if (!nominee) throw refuse(noNominee);
    return nominee;
  }
  if (input.kind !== 'other') {
    throw refuse('Say who the claimant is.');
  }
  const claimant: Claimant = {
    name: (input.name ?? '').trim(),
    nic: (input.nic ?? '').trim(),
    address: (input.address ?? '').trim(),
    relation: (input.relation ?? '').trim(),
    email: (input.email ?? '').trim() || null,
    mobile: (input.mobile ?? '').trim() || null,
  };
  const missing = (['name', 'nic', 'address', 'relation'] as const).filter(
    field => claimant[field] === ''
  );
  if (missing.length > 0) {
    const labels: Record<string, string> = {
      name: 'name',
      nic: 'NIC',
      address: 'address',
      relation: 'relation to the deceased',
    };
    throw refuse(
      `Enter the claimant’s ${missing.map(m => labels[m]).join(', ')}.`
    );
  }
  for (const field of ['name', 'nic', 'address', 'relation'] as const) {
    if (claimant[field].length > 200) {
      throw refuse(`The claimant’s ${field} is too long.`);
    }
  }
  return claimant;
}

/**
 * After a deceased non-member's closure posts: once nothing of theirs is
 * left open, the record says they died — status 'demised', as a member's
 * claim leaves it — so nothing more is recorded for them. Until then the
 * other accounts stay closable. Called inside the posting transaction.
 */
export async function markDeceasedOnceAllClosed(
  client: PoolClient,
  transactionId: string,
  actor: { userId: string; email: string }
): Promise<void> {
  const holder = await client.query<{
    member_id: string | null;
    customer_id: string | null;
    reference: string;
  }>(
    `select member_id, customer_id, reference from transaction
      where id = $1 and kind = 'closure' and claimant_kind is not null`,
    [transactionId]
  );
  const t = holder.rows[0];
  if (!t) return;
  const marked = t.member_id
    ? await client.query<{ id: string }>(
        `update member m
            set status = 'demised', status_changed_at = now(),
                updated_at = now()
          where m.id = $1 and m.status <> 'demised'
            and not exists (select 1 from account a
                             where a.member_id = m.id
                               and a.status <> 'closed')
          returning m.id`,
        [t.member_id]
      )
    : await client.query<{ id: string }>(
        `update customer c
            set status = 'demised', updated_at = now()
          where c.id = $1 and c.status <> 'demised'
            and not exists (select 1 from account a
                             where a.customer_id = c.id
                               and a.status <> 'closed')
          returning c.id`,
        [t.customer_id]
      );
  if (!marked.rowCount) return;
  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: t.member_id ? 'member.demised' : 'customer.demised',
      entityType: t.member_id ? 'member' : 'customer',
      entityId: marked.rows[0].id,
      newValue: { status: 'demised', closed_by: t.reference },
    },
    client
  );
}

/**
 * After an ordinary closure of a non-member's account posts: once nothing
 * of theirs is left open, they are no longer an active customer — status
 * 'closed' (officer feedback: someone whose only HSA was closed still read
 * "Active", with no account at all). Opening a new account for them makes
 * them active again (members/create.ts). A death claim is
 * markDeceasedOnceAllClosed's; a member's own accounts end with a
 * resignation, not here. Called inside the posting transaction.
 */
export async function markCustomerClosedOnceAllClosed(
  client: PoolClient,
  transactionId: string,
  actor: { userId: string; email: string }
): Promise<void> {
  const marked = await client.query<{ id: string; reference: string }>(
    `update customer c
        set status = 'closed', updated_at = now()
       from transaction t
      where t.id = $1 and t.kind = 'closure' and t.claimant_kind is null
        and t.customer_id = c.id and c.status = 'active'
        and not exists (select 1 from account a
                         where a.customer_id = c.id
                           and a.status <> 'closed')
      returning c.id, t.reference`,
    [transactionId]
  );
  if (!marked.rowCount) return;
  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'customer.closed',
      entityType: 'customer',
      entityId: marked.rows[0].id,
      newValue: { status: 'closed', closed_by: marked.rows[0].reference },
    },
    client
  );
}

export interface AccountClosedOnDeath {
  id: string;
  accountNo: string;
  typeName: string;
  // What it holds now; once posted, what was paid out of it.
  amount: string;
}

/**
 * The accounts a deceased non-member's closure covers (migration 0099), or
 * a deceased member's claim (S-1704): every account of the holder it has
 * not closed yet, with its balance — or, once it has posted, the ones it
 * closed, with what each paid. Those close in the posting's own statement,
 * so their closing time is its posting time exactly. Empty for anything
 * but a closure on a death or a claim.
 */
export async function accountsClosedOnDeath(
  transactionId: string
): Promise<AccountClosedOnDeath[]> {
  const result = await query<{
    id: string;
    account_no: string;
    type_name: string;
    amount: string;
  }>(
    `select a.id, coalesce(a.account_no, m.member_no) as account_no,
            at.name as type_name,
            (case when t.status = 'posted'
                  then coalesce((select sum(e.amount) from account_entry e
                                  where e.transaction_id = t.id
                                    and e.account_id = a.id), 0)
                  else coalesce(b.balance, 0)
             end)::numeric(14, 2)::text as amount
       from transaction t
       join account a
         on a.member_id = t.member_id or a.customer_id = t.customer_id
       join account_type at on at.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join account_balance b on b.account_id = a.id
      where t.id = $1
        and ((t.kind = 'closure' and t.claimant_kind is not null)
          or t.kind = 'demise')
        and (case when t.status = 'posted' then a.closed_at = t.posted_at
                  when t.status in ('rejected', 'cancelled') then a.id = t.account_id
                  else a.status <> 'closed' end)
      order by at.sort_order, a.opened_at`,
    [transactionId]
  );
  return result.rows.map(r => ({
    id: r.id,
    accountNo: r.account_no,
    typeName: r.type_name,
    amount: r.amount,
  }));
}
