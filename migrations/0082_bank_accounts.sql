-- The Society's own bank accounts (S-1901, BNK-US-001, BNK-US-004, FRD 15).
--
-- Phase 5 reconciles bank statements against what this system recorded,
-- and that is only possible if every transaction that touched a bank says
-- which one. So the accounts become configuration here — bank, the number,
-- currency, an opening balance for the day the system took over, active
-- or not — audited like every other configuration table; and transaction
-- gains a nullable bank_account_id for the next migration's rule (S-1902)
-- to make mandatory wherever the method touches a bank.
--
-- Two permissions rather than config.view/config.manage: an account number
-- is not a fee schedule. bank_account.view reads the list with the number
-- masked to its last four digits; bank_account.manage sees it whole and
-- may add or change one. The Treasurer holds both, the Auditor the first,
-- the System Administrator both as for everything else.
--
-- A balance is not stored. It is derived, when asked for, from the opening
-- balance and the posted transactions that name the account — there is no
-- second ledger to drift from the first.
set local albarakah.actor_description = 'migration 0082_bank_accounts';

insert into permission (code, description) values
    ('bank_account.view',   'See the Society''s bank accounts, numbers masked'),
    ('bank_account.manage', 'See the Society''s bank accounts in full, and add or change one')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('treasurer', 'bank_account.view'),
    ('treasurer', 'bank_account.manage'),
    ('auditor',   'bank_account.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  cross join permission p
 where r.code = 'system_administrator'
   and p.code in ('bank_account.view', 'bank_account.manage')
on conflict do nothing;

create table bank_account (
    id              uuid        primary key default gen_random_uuid(),
    code            text        not null unique
                    check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    -- What the office calls it: "MCB current account".
    name            text        not null,
    bank_name       text        not null,
    account_number  text        not null,
    currency        text        not null default 'MUR',
    -- What the account held on the day this system started recording
    -- against it; the derived balance counts forward from here.
    opening_balance numeric(14, 2) not null default 0,
    opening_date    date        not null default current_date,
    is_active       boolean     not null default true,
    sort_order      integer     not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create trigger bank_account_set_updated_at
    before update on bank_account
    for each row execute function set_updated_at();

create trigger bank_account_audit
    after insert or update or delete on bank_account
    for each row execute function record_configuration_change();

alter table transaction
    add column bank_account_id uuid references bank_account(id);

create index transaction_bank_account_idx
    on transaction (bank_account_id)
    where bank_account_id is not null;

comment on table bank_account is
    'The Society''s own bank accounts (S-1901). Configuration -> Bank '
    'accounts; bank_account.view sees the number masked, '
    'bank_account.manage in full. The balance is derived from posted '
    'transactions naming the account, never stored.';

comment on column transaction.bank_account_id is
    'Which of the Society''s bank accounts the money reached or left '
    '(S-1901). Optional until S-1902 makes it mandatory wherever the '
    'method touches a bank.';
