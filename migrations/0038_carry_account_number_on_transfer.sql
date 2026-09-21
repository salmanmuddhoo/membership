-- Officer feedback: a non-member's HSA/Investment account, transferred to
-- the Member they became on approval (S-614's createMemberFromApplication),
-- lost its own account number in the transfer — HSA0001 became AB0002, the
-- same number the member's Shares and MSA accounts already carry, reading
-- as if a brand new account had been issued rather than an existing one
-- carried over.
--
-- account_owner_shape (migration 0027) is why: it required account_no to be
-- null for every member-owned account, on the reasoning that a member's own
-- number already identifies all of theirs. True for Shares and the MSA,
-- which never had a number of their own — false for an account inherited
-- from a former customer identity, which did.
--
-- Widened rather than replaced: a customer's own account still needs its
-- number (nothing here relaxes that half), and nothing starts WRITING a
-- non-null account_no onto a Shares or MSA account just because the check
-- now permits one — createMemberFromApplication's own membership-default
-- insert never sets it, so those stay null exactly as before.
set local albarakah.actor_description = 'migration 0038_carry_account_number_on_transfer';

alter table account
    drop constraint account_owner_shape;

alter table account
    add constraint account_owner_shape check (
        (member_id is not null and customer_id is null)
        or
        (member_id is null and customer_id is not null
            and account_no is not null)
    );

comment on column account.account_no is
    'HSA0001, INV0001-style — set for a customer-owned account '
    '(account_owner_shape), and carried unchanged onto the member a '
    'customer becomes (S-614) rather than cleared. A Shares or MSA account, '
    'and any other account opened directly for a member (S-613), has none '
    'of its own; the member''s own number (migration 0018) identifies it '
    'instead.';

-- Recovers the number for an account already transferred under the old
-- rule — account.id is stable across the transfer, and
-- openAccountsForCustomerApplication's own 'account.opened' audit entry
-- (members/create.ts) recorded the number it assigned at the time, so it is
-- not lost even though the account row's own copy was cleared.
update account a
   set account_no = ae.new_value ->> 'accountNo'
  from audit_event ae
 where ae.action = 'account.opened'
   and ae.entity_type = 'account'
   and ae.entity_id = a.id::text
   and ae.new_value ->> 'openedBecause' = 'customer-account application approved'
   and a.member_id is not null
   and a.account_no is null;
