-- Payment methods become configuration (S-1307, FRD 6.6, open point 4).
--
-- Until now a method was a check constraint (0017, widened by 0048) and a
-- constant in payments.ts, and adding one — Juice, a salary deduction, a
-- standing order — was a release. FRD 6.6 wants the list to match how
-- members actually pay, changed by an administrator. So: a configuration
-- table, audited like every other one, seeded with today's codes so nothing
-- that exists changes meaning, and the two columns that name a method become
-- references to it.
--
-- What a method carries is what the rest of the system asks of one:
--
--   is_cash             the cash controls (0032, 0062) apply — the Source of
--                       Fund threshold and the ceiling. On the method, not
--                       on a list of method names in code (S-1306).
--   requires_reference  a cheque number, a transfer reference — the form
--                       demands one and the record keeps one. The Phase 1
--                       rule "show the reference for cheque, transfer and
--                       mobile money" becomes this column.
--   touches_bank        the money reaches a bank account, so M19's
--                       reconciliation will want to see it.
--   is_system           written only by the system, never offered on a
--                       form and not an administrator's to change:
--                       'migration', the legacy import's own mark (0048).
set local albarakah.actor_description = 'migration 0067_payment_methods';

create table payment_method (
    id                 uuid        primary key default gen_random_uuid(),
    code               text        not null unique
                       check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    name               text        not null,
    is_cash            boolean     not null default false,
    requires_reference boolean     not null default false,
    touches_bank       boolean     not null default false,
    is_system          boolean     not null default false,
    is_active          boolean     not null default true,
    sort_order         integer     not null default 0,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create trigger payment_method_set_updated_at
    before update on payment_method
    for each row execute function set_updated_at();

-- The same trail every configuration table has had since 0010.
create trigger payment_method_audit
    after insert or update or delete on payment_method
    for each row execute function record_configuration_change();

-- Today's five under their existing codes, so every payment already recorded
-- keeps saying what it said; the FRD's six additions; and the import's own.
-- touches_bank is everything that is not cash and not "other".
insert into payment_method
    (code, name, is_cash, requires_reference, touches_bank, is_system, sort_order)
values
    ('cash',             'Cash',              true,  false, false, false, 10),
    ('cheque',           'Cheque',            false, true,  true,  false, 20),
    ('bank_transfer',    'Bank transfer',     false, true,  true,  false, 30),
    ('card',             'Card',              false, false, true,  false, 40),
    ('mobile',           'Mobile money',      false, true,  true,  false, 50),
    ('juice',            'Juice',             false, true,  true,  false, 60),
    ('salary_deduction', 'Salary deduction',  false, false, true,  false, 70),
    ('standing_order',   'Standing order',    false, true,  true,  false, 80),
    ('deposit_at_bank',  'Deposit at bank',   false, true,  true,  false, 90),
    ('internet_banking', 'Internet banking',  false, true,  true,  false, 100),
    ('other',            'Other',             false, false, false, false, 110),
    ('migration',        'Legacy migration',  false, false, false, true,  999)
on conflict (code) do nothing;

-- The check constraint gives way to the reference. Every existing row names
-- one of the codes above, or this fails and rolls back — which is the right
-- outcome for a method the table has never heard of.
alter table payment
    drop constraint payment_method_check,
    add constraint payment_method_fkey
        foreign key (method) references payment_method(code);

alter table transaction
    add constraint transaction_method_fkey
        foreign key (method) references payment_method(code);

comment on column payment.method is
    'How the money moved: a payment_method code (0067). ''migration'' is '
    'the one an officer never chooses — written only by the legacy import.';

comment on table payment_method is
    'How money moves (S-1307). Configuration: an administrator adds or '
    'retires one on Configuration -> Payment methods. is_cash drives the '
    'cash controls, requires_reference the reference field, touches_bank '
    'bank reconciliation, is_system marks the import''s own mark.';
