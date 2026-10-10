// What a guardian may read about the minors in their care (docs/member-app.md).
//
// A minor — a Minor member, or a minor non-member who holds an account of
// their own — has a guardian block on their founding application
// (application_party, subject 'guardian'), naming the guardian by their own
// Member No. and NIC. A member signed in to the app is the guardian of a
// minor when that block names them, matched exactly as capture and every
// other guardian path match (members/guardian.ts, ledger/resignations.ts):
// this member's number, or the NIC on their own applicant party.
//
// The block is replaced only when a guardian is demised and a new one is
// approved (members/guardian.ts), so matching the block as it stands means a
// guardian who has been replaced no longer sees the minor, and the new one
// does — no separate bookkeeping to keep in step.
//
// A guardian sees the minor's accounts, balances and the entries behind
// them, and may ask for a deposit, a withdrawal or a transfer on them from
// the app (officer direction), exactly as on their own: the request goes to
// the same officers and nothing moves until they approve it
// (member/transactions.ts, accountInReach). Every money-out path still
// refuses a minor whose guardian is demised (members/guardian.ts) — none of
// which this touches.
import { ApiError } from '../api/envelope';
import { query } from '../db/pool';
import type { MemberPrincipal } from './identity';
import {
  accountsForHolder,
  accountTransactionsFor,
  ownedAccountId,
  type AccountSummary,
  type AccountTransaction,
} from './profile';

export interface Dependent {
  // The minor's own id: a member's, or a non-member customer's.
  id: string;
  kind: 'member' | 'customer';
  // The minor's Member No., or null for a non-member who only holds an account.
  memberNo: string | null;
  name: string;
  // How the guardian is related to the minor, as the block records it.
  relationship: string | null;
  status: string;
  accounts: AccountSummary[];
}

interface MinorRow {
  id: string;
  kind: 'member' | 'customer';
  member_no: string | null;
  name: string;
  relationship: string | null;
  status: string;
}

// The active minors this member is the guardian of, member and non-member
// alike. Matched on the guardian block as it stands, by this member's number
// or NIC — the same match members/guardian.ts and ledger/resignations.ts
// make. A minor whose application is still on its way holds no account and is
// left out; only a holder with accounts to show is a dependent here.
async function minorsGuardedBy(memberId: string): Promise<MinorRow[]> {
  const result = await query<MinorRow>(
    `with me as (
       select m.member_no, coalesce(p.values->>'nic', '') as nic
         from member m
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        where m.id = $1
     )
     select id, kind, member_no, name, relationship, status from (
       select m.id, 'member'::text as kind, m.member_no,
              trim(concat_ws(' ', a.values->>'name', a.values->>'surname')) as name,
              nullif(trim(g.values->>'relationship'), '') as relationship,
              m.status,
              m.member_no as sort
         from member m
         join membership_type t on t.id = m.membership_type_id
         join application_party g
           on g.application_id = m.application_id
          and g.subject = 'guardian' and g.ordinal = 1
         left join application_party a
           on a.application_id = m.application_id
          and a.subject = 'applicant' and a.ordinal = 1
         cross join me
        where m.id <> $1 and t.code = 'minor' and m.status = 'active'
          and ((me.member_no <> ''
                and lower(g.values->>'member_id') = lower(me.member_no))
               or (me.nic <> '' and g.values->>'nic' = me.nic))
       union all
       select c.id, 'customer'::text as kind, null::text as member_no,
              trim(concat_ws(' ', a.values->>'name', a.values->>'surname')) as name,
              nullif(trim(g.values->>'relationship'), '') as relationship,
              c.status,
              coalesce(ap.reference, '') as sort
         from customer c
         join membership_application ap on ap.id = c.application_id
         join membership_type t on t.id = ap.membership_type_id
         join application_party g
           on g.application_id = ap.id
          and g.subject = 'guardian' and g.ordinal = 1
         left join application_party a
           on a.application_id = ap.id
          and a.subject = 'applicant' and a.ordinal = 1
         cross join me
        where t.code = 'minor' and c.status = 'active'
          and ((me.member_no <> ''
                and lower(g.values->>'member_id') = lower(me.member_no))
               or (me.nic <> '' and g.values->>'nic' = me.nic))
     ) wards
     order by name, sort`,
    [memberId]
  );
  return result.rows;
}

/**
 * The minors this member guards, each with their accounts and balances.
 * Empty for a member who guards nobody, and for an applicant or customer
 * session (a guardian is matched by Member No. or NIC on a member record).
 */
export async function listDependents(
  principal: MemberPrincipal
): Promise<Dependent[]> {
  if (!principal.memberId) return [];
  const minors = await minorsGuardedBy(principal.memberId);
  return Promise.all(
    minors.map(async m => ({
      id: m.id,
      kind: m.kind,
      memberNo: m.member_no,
      name: m.name,
      relationship: m.relationship,
      status: m.status,
      accounts: await accountsForHolder(
        m.kind === 'member' ? m.id : null,
        m.kind === 'customer' ? m.id : null
      ),
    }))
  );
}

// The minor if this member currently guards them, else null. The lookup is
// minorsGuardedBy over again, filtered to the one id: a guardian who does
// not guard this minor gets the same answer as one naming a minor that does
// not exist.
async function guardedMinor(
  principal: MemberPrincipal,
  dependentId: string
): Promise<MinorRow | null> {
  if (!principal.memberId) return null;
  const minors = await minorsGuardedBy(principal.memberId);
  return minors.find(m => m.id === dependentId) ?? null;
}

/**
 * A minor's account transactions, once it is established that the caller
 * guards the minor and the account is the minor's. Anything else — a minor
 * they do not guard, an account that is not that minor's, an id that is not
 * even a uuid — is the same not_found, so the app never learns an id it
 * should not have named exists (as ownedAccountId gives for one's own).
 */
export async function dependentAccountTransactions(
  principal: MemberPrincipal,
  dependentId: string,
  accountId: string
): Promise<AccountTransaction[]> {
  const minor = await guardedMinor(principal, dependentId);
  if (!minor) throw new ApiError('not_found', 'No such account.');

  const owned = await query<{ id: string }>(
    `select id from account
      where id = $1::uuid
        and (($2 = 'member' and member_id = $3::uuid)
          or ($2 = 'customer' and customer_id = $3::uuid))`,
    [isUuid(accountId) ? accountId : null, minor.kind, minor.id]
  );
  if (!owned.rows[0]) throw new ApiError('not_found', 'No such account.');

  return accountTransactionsFor(accountId);
}

// --- Moving money for a minor ------------------------------------------------

/** A minor in the caller's care, as a request made for them names them. */
export interface Ward {
  id: string;
  kind: 'member' | 'customer';
  memberNo: string | null;
  name: string;
}

function wardOf(m: MinorRow): Ward {
  return { id: m.id, kind: m.kind, memberNo: m.member_no, name: m.name };
}

/** The minors the caller guards today; empty for anyone else. */
export async function wardsOf(principal: MemberPrincipal): Promise<Ward[]> {
  if (!principal.memberId) return [];
  return (await minorsGuardedBy(principal.memberId)).map(wardOf);
}

/**
 * An account the caller may move money on, and whose it is: one of their
 * own (ward null), or one held by a minor they guard today. Anything else
 * is the same not_found ownedAccountId gives, so the app never learns that
 * an id it should not have named exists.
 */
export async function accountInReach(
  principal: MemberPrincipal,
  accountId: string
): Promise<{ accountId: string; ward: Ward | null }> {
  try {
    return {
      accountId: await ownedAccountId(principal, accountId),
      ward: null,
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
  }
  const wards = await wardsOf(principal);
  if (wards.length > 0 && isUuid(accountId)) {
    const held = await query<{
      member_id: string | null;
      customer_id: string | null;
    }>(`select member_id, customer_id from account where id = $1::uuid`, [
      accountId,
    ]);
    const row = held.rows[0];
    const ward = row
      ? wards.find(w =>
          w.kind === 'member'
            ? w.id === row.member_id
            : w.id === row.customer_id
        )
      : undefined;
    if (ward) return { accountId, ward };
  }
  throw new ApiError('not_found', 'No such account.');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value ?? ''
  );
}
