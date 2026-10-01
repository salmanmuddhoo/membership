// Who is paid when an account holder dies, shared by a member's demised
// claim (demises.ts, S-1704) and a deceased non-member's closure
// (closures.ts, business decision after the lifecycle test): the nominee
// the holder named on their application, or another person in full.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query } from '../db/pool';
import { loadApplication } from '../applications/capture';
import type { Claimant } from './review';

/**
 * Whether a holder of this membership type can die, and so be settled by a
 * demised claim or a closure on a death. A Corporate holder is an entity, not
 * a person: it leaves by resignation or by closing its accounts. `typeCode`
 * is the membership type's own code, not its label, as depositorFor reads it.
 */
export function claimableMembershipType(typeCode: string): boolean {
  return typeCode !== 'corporate';
}

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

export interface AccountClosedTogether {
  id: string;
  accountNo: string;
  typeName: string;
  // What it holds now; once posted, what was paid out of it.
  amount: string;
}

/**
 * The accounts one request closes together, with what each paid: a deceased
 * non-member's closure (migration 0099) and a deceased member's claim
 * (S-1704) close every account of the holder; a resignation (S-1703) the
 * Shares and the MSA. Before posting, the ones it will close with their
 * balances; once posted, the ones it closed — in the posting's own
 * statement, so their closing time is its posting time exactly. Empty for
 * anything else.
 */
export async function accountsClosedTogether(
  transactionId: string
): Promise<AccountClosedTogether[]> {
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
          or t.kind in ('demise', 'resignation'))
        and (case when t.status = 'posted' then a.closed_at = t.posted_at
                  when t.status in ('rejected', 'cancelled') then a.id = t.account_id
                  else a.status <> 'closed'
                       and (t.kind <> 'resignation' or a.is_membership_default)
             end)
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

export interface DraftLeftOnDeath {
  id: string;
  // What staff quote: a transfer's TR reference, otherwise the TX.
  reference: string;
  kindName: string;
  status: 'draft' | 'returned';
  amount: string;
}

const KIND_NAMES: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  closure: 'Closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};

// Every transaction not yet submitted — a draft, or one returned to its
// officer — that touches the holder: in their name, on one of their
// accounts, or a transfer with a leg on one. A transfer is listed once, by
// its debit leg.
const DRAFTS_OF_HOLDER = `
  select * from (
  select distinct on (coalesce(t.transfer_id, t.id))
         t.id, t.transfer_id, coalesce(tr.reference, t.reference) as reference,
         t.kind, t.status, t.amount::text as amount, t.created_at
    from transaction t
    left join transfer tr on tr.id = t.transfer_id
   where t.status in ('draft', 'returned')
     and t.id <> $2::uuid
     and (t.member_id = $1 or t.customer_id = $1
          or t.account_id in (select id from account
                               where member_id = $1 or customer_id = $1)
          or t.transfer_id in (select l.transfer_id
                                 from transaction l
                                 join account a on a.id = l.account_id
                                where (a.member_id = $1 or a.customer_id = $1)
                                  and l.transfer_id is not null))
   order by coalesce(t.transfer_id, t.id), t.leg_direction = 'debit' desc
  ) drafts
  order by created_at`;

/**
 * What a death claim will cancel once it is disbursed (officer direction):
 * the holder's drafts and returned transactions, which can never go through
 * once every account is closed. `claimId` is the claim itself, left out.
 */
export async function draftsLeftOnDeath(
  holderId: string,
  claimId: string
): Promise<DraftLeftOnDeath[]> {
  const result = await query<{
    id: string;
    reference: string;
    kind: string;
    status: 'draft' | 'returned';
    amount: string;
  }>(DRAFTS_OF_HOLDER, [holderId, claimId]);
  return result.rows.map(r => ({
    id: r.id,
    reference: r.reference,
    kindName: KIND_NAMES[r.kind] ?? r.kind,
    status: r.status,
    amount: r.amount,
  }));
}

/**
 * Once a death claim posts and the holder reads 'demised' — a member's
 * demised claim, or the closure that closed a deceased non-member's last
 * account — every draft and returned transaction of theirs is cancelled,
 * both legs of a transfer with it, each logged and audited as though its
 * officer had withdrawn it. Called inside the posting transaction, after
 * markDeceasedOnceAllClosed.
 */
export async function cancelDraftsOnDeath(
  client: PoolClient,
  transactionId: string,
  actor: { userId: string; email: string; roleNames: string[] }
): Promise<void> {
  const claim = await client.query<{
    holder_id: string;
    reference: string;
  }>(
    `select coalesce(t.member_id, t.customer_id) as holder_id, t.reference
       from transaction t
       left join member m on m.id = t.member_id
       left join customer c on c.id = t.customer_id
      where t.id = $1 and t.status = 'posted'
        and (t.kind = 'demise'
          or (t.kind = 'closure' and t.claimant_kind is not null))
        and coalesce(m.status, c.status) = 'demised'`,
    [transactionId]
  );
  const t = claim.rows[0];
  if (!t) return;
  const drafts = await client.query<{
    id: string;
    transfer_id: string | null;
  }>(DRAFTS_OF_HOLDER, [t.holder_id, transactionId]);
  for (const draft of drafts.rows) {
    const legs = await client.query<{
      id: string;
      reference: string;
      status: string;
    }>(
      `select id, reference, status from transaction
        where status in ('draft', 'returned')
          and (id = $1 or ($2::uuid is not null and transfer_id = $2::uuid))`,
      [draft.id, draft.transfer_id]
    );
    for (const leg of legs.rows) {
      await client.query(
        `update transaction set status = 'cancelled', current_step_code = null
          where id = $1`,
        [leg.id]
      );
      await client.query(
        `insert into transaction_transition
           (transaction_id, from_status, to_status, step_code, actor_user_id,
            actor_role, comment)
         values ($1, $2, 'cancelled', null, $3, $4, $5)`,
        [
          leg.id,
          leg.status,
          actor.userId,
          actor.roleNames.join(', ') || null,
          `Cancelled with ${t.reference}: the holder is demised.`,
        ]
      );
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.email,
          action: 'transaction.cancelled',
          entityType: 'transaction',
          entityId: leg.reference,
          previousValue: { status: leg.status },
          newValue: { status: 'cancelled', cancelled_by: t.reference },
        },
        client
      );
    }
    if (draft.transfer_id) {
      await client.query(
        `update transfer set status = 'cancelled' where id = $1`,
        [draft.transfer_id]
      );
    }
  }
}
