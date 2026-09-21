-- S-613, phase 6: paying to open an account for an existing member.
--
-- An additional_account application (migration 0025) has no membership
-- type, and so no fee schedule to charge against — payment.fee_version_id
-- was `not null`, which made recording one against this kind of application
-- impossible at the schema level, not just unimplemented in code.
--
-- Officer direction: the amount to charge is simply each selected account
-- type's own minimum_opening_amount (account_type, migration 0010) — no
-- second "fee schedule" concept for an administrator to configure. So this
-- is not a fee_schedule_version by another name: payment_line.component_code
-- is deliberately a closed set of five FRD-defined codes (0017) that an
-- open-ended, admin-created account_type cannot be squeezed into. A parallel
-- table, snapshotting what was actually charged the same way payment_line's
-- own scheduled_amount already does, keeps the two kinds of line item apart
-- rather than widening a check constraint that exists to stay closed.
set local albarakah.actor_description = 'migration 0026_additional_account_payments';

alter table payment
    alter column fee_version_id drop not null;

comment on column payment.fee_version_id is
    'The membership fee schedule version charged, for a payment against a '
    'membership application or its member (S-501). Null for a payment '
    'against an additional_account application (S-613), which has no fee '
    'schedule — see payment_account_line instead.';

-- Generalised so the message names the table that was actually touched,
-- rather than always saying "payment_line" once a second append-only table
-- (payment_account_line, below) reuses this same function. The reset escape
-- hatch migration 0019 added stays exactly as it was — this only changes the
-- message in the branch that actually raises.
create or replace function reject_payment_line_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
        using errcode = 'restrict_violation';
end;
$$;

create table payment_account_line (
    id               uuid        primary key default gen_random_uuid(),
    payment_id       uuid        not null references payment(id) on delete restrict,

    account_type_id  uuid        not null references account_type(id),
    -- Snapshotted at the moment of payment, the same reason payment_line
    -- keeps scheduled_amount beside amount: an account type renamed later
    -- must not rewrite what a receipt already printed.
    account_type_code text       not null,
    account_type_name text       not null,

    amount           numeric(14, 2) not null check (amount >= 0),
    sort_order       integer     not null default 0,

    unique (payment_id, account_type_id)
);

create index payment_account_line_type_idx
    on payment_account_line (account_type_id);

-- Same append-only rule payment_line already carries (0017) — reusing that
-- trigger function rather than a second copy, since neither it nor the
-- exception it raises names a column.
create trigger payment_account_line_append_only
    before update or delete on payment_account_line
    for each row execute function reject_payment_line_mutation();

create trigger payment_account_line_no_truncate
    before truncate on payment_account_line
    for each statement execute function reject_payment_line_mutation();

comment on table payment_account_line is
    'What was charged, per selected account type, for a payment against an '
    'additional_account application (S-613) — payment_line''s counterpart '
    'for a payment that has no fee schedule to itemise against.';
