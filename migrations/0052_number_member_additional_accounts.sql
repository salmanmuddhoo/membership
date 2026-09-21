-- Bug: an additional account opened directly for a member (S-613 — an HSA or
-- Investment on top of their Shares/MSA) was inserted with no account number
-- of its own. loadMember and listMembers both fall back to the member's own
-- number when an account has none (coalesce(account_no, member_no)), so the
-- new HSA read as AB0002 — the very number the member's Shares and MSA already
-- carry — instead of HSA0001.
--
-- openAccountsForApplication (members/create.ts) now numbers a member's
-- additional account the same way a non-member's is numbered
-- (next_customer_account_number, from the account type's own prefix), which
-- account_owner_shape has permitted for a member-owned account since migration
-- 0038. This recovers the accounts opened before that fix: every member-owned,
-- non-default account still missing a number is given one now, from the same
-- per-type counter, so it reads HSA0001/INV0001-style from here on.
--
-- Only non-default accounts (is_membership_default = false) are touched —
-- Shares and the MSA never carry a number of their own and stay null. Only
-- types that actually have a prefix configured are numbered; one without a
-- prefix cannot be numbered and is left as it was rather than failing the
-- migration (its absence is a configuration gap to fix in its own right).
set local albarakah.actor_description = 'migration 0052_number_member_additional_accounts';

do $$
declare
    r record;
begin
    for r in
        select a.id, a.account_type_id
          from account a
          join account_type t on t.id = a.account_type_id
         where a.member_id is not null
           and a.account_no is null
           and a.is_membership_default = false
           and coalesce(btrim(t.number_prefix), '') <> ''
         -- Earliest-opened first, so the numbers run in the order the
         -- accounts were actually opened.
         order by a.opened_at, a.id
    loop
        update account
           set account_no = next_customer_account_number(r.account_type_id)
         where id = r.id;
    end loop;
end $$;
