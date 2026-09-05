-- Officer feedback: a non-member's HSA/Investment accounts, transferred to
-- the Member they became on approval (S-614's createMemberFromApplication),
-- read as Rs 0 afterwards — the money never moved, but the balance and
-- transaction history the member's own page shows for that account vanish.
--
-- The account row itself never carried a durable link to whichever
-- application actually paid for it (payments.ts's own transactionsForAccount
-- said as much: "the account row itself keeps no link back to it"). Instead
-- it was derived on the fly from the account's CURRENT owner shape: a
-- membership default via the member's founding application, an
-- additional_account-opened account via application_account_selection, a
-- customer's own account via customer.application_id. The S-614 transfer
-- (customer -> member) clears customer_id and account_no, and there is no
-- additional_account application for a transferred account either — so once
-- transferred, none of the three derivations finds anything, and the
-- balance and transaction list both read empty.
--
-- opened_by_application_id records the answer once, at the moment the
-- account is opened by any of the three paths that ever create one, and
-- never changes afterwards — the S-614 transfer included, which is the
-- whole point: the application that paid for an account does not change
-- just because who holds it does.
set local albarakah.actor_description = 'migration 0037_account_opened_by_application';

alter table account
    add column opened_by_application_id uuid references membership_application(id);

comment on column account.opened_by_application_id is
    'Which application''s payment actually funded this account (S-308, '
    'S-613, S-614) — set once, at creation, and never touched again, '
    'including across S-614''s customer-to-member transfer. The one durable '
    'link back to a payment once an account outlives the shape (membership '
    'default, additional_account, or customer) it was opened under.';

-- Backfilled for every account already open, so a balance that reads
-- correctly today keeps reading correctly, and one that was already broken
-- (a converted customer's transferred HSA/Investment) is fixed retroactively
-- rather than only from here on.

-- 1. A membership default (Shares, MSA) — opened by the member's own
--    founding application (migration 0018: there is only ever one).
update account a
   set opened_by_application_id = m.application_id
  from member m
 where a.member_id = m.id
   and a.is_membership_default
   and a.opened_by_application_id is null;

-- 2. A customer's own account, still held as a customer (not yet
--    converted) — opened by their one customer_account application.
update account a
   set opened_by_application_id = c.application_id
  from customer c
 where a.customer_id = c.id
   and a.opened_by_application_id is null;

-- 3. A member's non-default account genuinely opened by an additional_account
--    application (S-613) — found the same way transactionsForAccount used
--    to derive it, before this column existed.
update account a
   set opened_by_application_id = (
     select ma.id
       from membership_application ma
       join application_account_selection s on s.application_id = ma.id
      where ma.existing_member_id = a.member_id
        and ma.application_kind = 'additional_account'
        and s.account_type_id = a.account_type_id
      order by ma.decided_at desc nulls last
      limit 1
   )
 where a.member_id is not null
   and not a.is_membership_default
   and a.opened_by_application_id is null;

-- 4. What (3) cannot find: a member's non-default account that was actually
--    a customer's, transferred by an earlier S-614 approval before this
--    column existed. The transfer itself erased customer_id and account_no,
--    so this reaches back through the audit trail instead — customer.status
--    became 'converted' at the same moment, recording which member the
--    customer became (audit_event, migration 0004); the customer row itself
--    is never deleted, so its application_id is still exactly what it always
--    was.
update account a
   set opened_by_application_id = (
     select s.application_id
       from audit_event ae
       join customer c on c.id = ae.entity_id::uuid
       join member m on m.member_no = (ae.new_value ->> 'becameMemberNo')
       join application_account_selection s
         on s.application_id = c.application_id
        and s.account_type_id = a.account_type_id
      where ae.action = 'customer.converted'
        and ae.entity_type = 'customer'
        and m.id = a.member_id
      limit 1
   )
 where a.member_id is not null
   and not a.is_membership_default
   and a.opened_by_application_id is null;
