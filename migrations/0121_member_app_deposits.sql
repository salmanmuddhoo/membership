-- Deposits from the member app: who records them, and which account a
-- member pays into (officer direction, October 2026; docs/member-app.md).
--
-- Who records one. Once the accounts department has verified a deposit a
-- member made from the app, recording it moves the money onto the
-- member's balance. Until now that was transaction.post, which the
-- Regional Officer (0069) and any role an administrator gave it also hold
-- for the counter. A deposit from the app is the accounts department's
-- alone, so recording one is its own permission,
-- transaction.record_app_deposit, given to the Account Officer.
-- transaction.post no longer reaches it (ledger/review.ts,
-- permissionToPost). A permission like any other: an administrator moves
-- it at Configuration -> Roles.
--
-- Where a member pays. A member is shown one of the Society's bank
-- accounts to send the money to, never the list: the one marked as the
-- default for member app deposits at Configuration -> Bank accounts. At
-- most one is marked, and only an active one. A Society with a single
-- active account has nothing to choose, so that one is marked here;
-- with several, an administrator marks one, and until then deposits from
-- the app say they are not available.
set local albarakah.actor_description = 'migration 0121_member_app_deposits';

insert into permission (code, description) values
    ('transaction.record_app_deposit',
     'Record a deposit a member made from the app, once it is approved')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'transaction.record_app_deposit'
 where r.code = 'account_officer'
on conflict do nothing;

alter table bank_account
    add column is_member_app_default boolean not null default false,
    add constraint bank_account_member_app_default_is_active
        check (not is_member_app_default or is_active);

create unique index bank_account_one_member_app_default
    on bank_account ((true))
    where is_member_app_default;

comment on column bank_account.is_member_app_default is
    'The one account a member is shown to pay into for a deposit from the '
    'member app. At most one, and only an active one.';

update bank_account
   set is_member_app_default = true
 where is_active
   and (select count(*) from bank_account where is_active) = 1;
