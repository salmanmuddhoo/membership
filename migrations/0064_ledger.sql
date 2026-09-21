-- The account ledger (S-1301, S-1302; Phase 2 FRD 3, 6.1).
--
-- Until now the system recorded what was paid and never a balance: "opening
-- payment less refund" was the nearest thing, computed on the fly. Phase 2
-- moves money, so a balance has to be something the history proves rather
-- than a number a program keeps.
--
-- Three tables and one function:
--
--   transaction      — one row per intended movement of money. Only `deposit`
--                      exists yet; each later milestone widens the kind check
--                      by its own migration as it adds a type.
--   account_entry    — one immutable row per account a POSTED transaction
--                      touched. The balance is the sum of these. Nothing
--                      updates or deletes one, ever, the way audit_event has
--                      worked since 0004.
--   account_balance  — one row per account, a CACHE of that sum, maintained
--                      in the same database transaction as the entries it
--                      summarises. Read for speed; never trusted over the
--                      entries. `ledger_drift()` finds any disagreement and
--                      `rebuild_account_balance()` resolves it from the entries
--                      — never the other way round.
--
-- post_transaction() is the only road in. It is security definer, owned by
-- the schema owner, and the application role holds NO insert, update or
-- delete on account_entry or account_balance at all — the pattern
-- reset_all_test_data (0019) and the retention job (0061) already use. So
-- FRD 6.1's "no transaction type may be implemented as a one-off balance
-- update outside this engine" is a grant the database enforces, and
-- scripts/schema.test.ts asserts, rather than a rule a reviewer remembers.
--
-- Direction is from the ACCOUNT HOLDER'S side, because that is how a member
-- reads a statement: a credit puts money in and raises the balance, a debit
-- takes it out and lowers it. balance = sum(credits) - sum(debits).
--
-- Nothing creates a transaction row yet. This migration changes the
-- behaviour of nothing on its own; the deposit flow that first uses it is its
-- own change, as M11's schema-first phase was.
set local albarakah.actor_description = 'migration 0064_ledger';

-- ---------------------------------------------------------------------------
-- The transaction
-- ---------------------------------------------------------------------------
-- A serial and a generated reference, as receipt_number does (0017): the
-- number is the truth and the text is derived from it, so a gap is
-- arithmetic rather than string parsing.
create sequence transaction_reference_seq;

create table transaction (
    id                uuid        primary key default gen_random_uuid(),

    serial_no         bigint      not null unique
                      default nextval('transaction_reference_seq'),
    reference         text        not null unique
                      generated always as ('TX-' || lpad(serial_no::text, 6, '0'))
                      stored,

    -- The closed set FRD 6.1 names. Widened by migration, never by code, as
    -- each type arrives: withdrawal, transfer_leg, disbursement.
    kind              text        not null,
    constraint transaction_kind_check check (kind in ('deposit')),

    member_id         uuid        not null references member(id),
    account_id        uuid        not null references account(id),

    amount            numeric(14, 2) not null check (amount > 0),
    currency          text        not null default 'MUR',

    -- Free text until S-1307 makes payment methods configuration; the
    -- reference is whatever the method needs (cheque number, transfer
    -- reference) and is nothing the database validates.
    method            text        not null,
    method_reference  text,
    reason            text,

    -- The whole lifecycle, named now so the approval chain (M14) can address
    -- these statuses from workflow_step without a further migration.
    status            text        not null default 'draft',
    constraint transaction_status_check check (status in (
        'draft', 'submitted', 'under_review', 'approved', 'posted',
        'returned', 'rejected', 'cancelled'
    )),

    -- Issued at posting, by the deposit flow that first uses this (S-1305);
    -- an opening balance carried over from a Phase 1 payment (S-1303)
    -- references that payment's receipt instead of taking a new one.
    receipt_number_id uuid        unique references receipt_number(id),

    -- The same key twice from the same person is the same transaction,
    -- never a second one (S-1308). Enforced here, not only in the endpoint.
    idempotency_key   text,

    captured_by       uuid        not null references app_user(id),
    posted_at         timestamptz,
    posted_by         uuid        references app_user(id),

    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    constraint transaction_posted_is_complete check (
        (status = 'posted') = (posted_at is not null and posted_by is not null)
    )
);

create unique index transaction_idempotency_idx
    on transaction (captured_by, idempotency_key)
    where idempotency_key is not null;

create index transaction_account_idx on transaction (account_id, created_at);
create index transaction_member_idx  on transaction (member_id, created_at);
create index transaction_status_idx  on transaction (status)
    where status not in ('posted', 'rejected', 'cancelled');

create trigger transaction_set_updated_at
    before update on transaction
    for each row execute function set_updated_at();

-- A posted transaction is a record of something that happened, and it is
-- corrected by a reversing transaction that names it (S-1505), never by an
-- edit. Before posting it is a working record: a draft may be deleted by the
-- officer who started it, a returned one edited and resubmitted. The
-- columns that identify it never change in either case.
create or replace function guard_transaction()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    if tg_op = 'TRUNCATE' then
        raise exception 'transaction is append-only; TRUNCATE is not permitted'
            using errcode = 'restrict_violation';
    end if;

    if tg_op = 'DELETE' then
        if old.status <> 'draft' then
            raise exception
                'only a draft transaction can be deleted; % is %',
                old.reference, old.status
                using errcode = 'restrict_violation';
        end if;
        return old;
    end if;

    if old.status = 'posted' then
        raise exception
            'a posted transaction cannot be edited; reverse it instead (%)',
            old.reference
            using errcode = 'restrict_violation';
    end if;

    if (new.id, new.serial_no, new.kind, new.member_id, new.captured_by,
        new.created_at)
       is distinct from
       (old.id, old.serial_no, old.kind, old.member_id, old.captured_by,
        old.created_at) then
        raise exception
            'a transaction''s identity cannot change (%)', old.reference
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

create trigger transaction_guard
    before update or delete on transaction
    for each row execute function guard_transaction();

create trigger transaction_no_truncate
    before truncate on transaction
    for each statement execute function guard_transaction();

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------
create table account_entry (
    id             uuid        primary key default gen_random_uuid(),

    -- Posting order, for a running balance that is the same on every read.
    -- posted_at alone is not: two entries in one transaction share it.
    sequence_no    bigint      generated always as identity,

    account_id     uuid        not null references account(id),
    transaction_id uuid        not null references transaction(id),

    direction      text        not null check (direction in ('credit', 'debit')),
    amount         numeric(14, 2) not null check (amount > 0),

    posted_at      timestamptz not null default now()
);

create unique index account_entry_sequence_idx on account_entry (sequence_no);
create index account_entry_account_idx on account_entry (account_id, sequence_no);
create index account_entry_transaction_idx on account_entry (transaction_id);

create or replace function reject_account_entry_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception
        'account_entry is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger account_entry_no_update
    before update on account_entry
    for each row execute function reject_account_entry_mutation();

create trigger account_entry_no_delete
    before delete on account_entry
    for each row execute function reject_account_entry_mutation();

create trigger account_entry_no_truncate
    before truncate on account_entry
    for each statement execute function reject_account_entry_mutation();

-- ---------------------------------------------------------------------------
-- The cache
-- ---------------------------------------------------------------------------
create table account_balance (
    account_id         uuid        primary key references account(id),
    balance            numeric(14, 2) not null default 0,
    entry_count        bigint      not null default 0,
    -- The last entry this figure includes. What lets a verifier ask "does the
    -- sum up to here equal this" without recomputing the whole account.
    as_of_sequence_no  bigint,
    updated_at         timestamptz not null default now()
);

create or replace function reject_account_balance_truncate()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return null;
    end if;

    raise exception 'account_balance is maintained by the ledger; TRUNCATE is not permitted'
        using errcode = 'restrict_violation';
end;
$$;

create trigger account_balance_no_truncate
    before truncate on account_balance
    for each statement execute function reject_account_balance_truncate();

-- ---------------------------------------------------------------------------
-- financial_event learns about transactions
-- ---------------------------------------------------------------------------
-- 0017 built the stream for payments alone, so payment_id was the event's
-- subject and could not be null. A transaction is a second kind of subject:
-- exactly one of the two is set. receipt_no follows: a transaction takes its
-- receipt at posting (S-1305) or carries a Phase 1 payment's (S-1303), so it
-- is on the payload rather than a column every subject must fill.
alter table financial_event
    alter column payment_id drop not null,
    alter column receipt_no drop not null,
    add column transaction_id uuid references transaction(id) on delete restrict;

alter table financial_event
    add constraint financial_event_has_one_subject check (
        (payment_id is not null)::int + (transaction_id is not null)::int = 1
    );

create index financial_event_transaction_idx on financial_event (transaction_id);

-- The check on event_type was unnamed in 0017; find it by what it constrains
-- rather than by a name PostgreSQL chose.
do $$
declare
    v_name text;
begin
    select conname into v_name
      from pg_constraint
     where conrelid = 'financial_event'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%event_type%';
    if v_name is not null then
        execute format('alter table financial_event drop constraint %I', v_name);
    end if;
end;
$$;

alter table financial_event
    add constraint financial_event_event_type_check check (event_type in (
        'payment.recorded', 'payment.refunded', 'payment.voided',
        'transaction.posted'
    ));

-- ---------------------------------------------------------------------------
-- Posting: the one road to a balance
-- ---------------------------------------------------------------------------
-- Everything atomic about posting happens here, in one transaction: the
-- entries, the cache, the status, the financial event and the audit row. So
-- "half posted" is not a state that can exist. The service layer decides
-- WHETHER a transaction may post — the account type's rules, the approval
-- chain — and calls this once it may. What this checks itself is the small
-- set of invariants that must hold whoever calls it.
create or replace function post_transaction(
    p_transaction_id    uuid,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tx         transaction%rowtype;
    v_acc_status text;
    v_direction  text;
    v_entry_seq  bigint;
    v_balance    numeric(14, 2);
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'post_transaction requires a named actor'
            using errcode = 'restrict_violation';
    end if;

    select * into v_tx from transaction where id = p_transaction_id for update;
    if not found then
        raise exception 'no transaction %', p_transaction_id
            using errcode = 'no_data_found';
    end if;

    if v_tx.status not in ('submitted', 'approved') then
        raise exception
            'transaction % is %, and only a submitted or approved one posts',
            v_tx.reference, v_tx.status
            using errcode = 'restrict_violation';
    end if;

    select status into v_acc_status from account where id = v_tx.account_id for update;
    if v_acc_status is distinct from 'active' then
        raise exception
            'account % is %, and money cannot move on it',
            v_tx.account_id, coalesce(v_acc_status, 'missing')
            using errcode = 'restrict_violation';
    end if;

    -- The only kind that exists. Each later migration that adds one replaces
    -- this function with the direction that kind takes.
    if v_tx.kind = 'deposit' then
        v_direction := 'credit';
    else
        raise exception 'post_transaction does not know kind %', v_tx.kind
            using errcode = 'restrict_violation';
    end if;

    insert into account_entry (account_id, transaction_id, direction, amount)
    values (v_tx.account_id, v_tx.id, v_direction, v_tx.amount)
    returning sequence_no into v_entry_seq;

    insert into account_balance (account_id, balance, entry_count, as_of_sequence_no)
    values (
        v_tx.account_id,
        case v_direction when 'credit' then v_tx.amount else -v_tx.amount end,
        1,
        v_entry_seq
    )
    on conflict (account_id) do update set
        balance           = account_balance.balance
                            + case v_direction when 'credit' then v_tx.amount
                                               else -v_tx.amount end,
        entry_count       = account_balance.entry_count + 1,
        as_of_sequence_no = v_entry_seq,
        updated_at        = now()
    returning balance into v_balance;

    update transaction
       set status    = 'posted',
           posted_at = now(),
           posted_by = p_actor_user_id
     where id = v_tx.id;

    insert into financial_event (event_type, transaction_id, receipt_no, payload)
    select 'transaction.posted',
           v_tx.id,
           rn.receipt_no,
           jsonb_build_object(
               'reference',    v_tx.reference,
               'kind',         v_tx.kind,
               'member_id',    v_tx.member_id,
               'account_id',   v_tx.account_id,
               'direction',    v_direction,
               'amount',       v_tx.amount,
               'currency',     v_tx.currency,
               'method',       v_tx.method,
               'method_reference', v_tx.method_reference,
               'receipt_no',   rn.receipt_no,
               'balance_after', v_balance,
               'entry_sequence_no', v_entry_seq,
               'captured_by',  v_tx.captured_by,
               'posted_by',    p_actor_user_id,
               'posted_at',    now()
           )
      from (select v_tx.receipt_number_id as id) t
      left join receipt_number rn on rn.id = t.id;

    insert into audit_event (
        actor_user_id, actor_description, action, entity_type, entity_id,
        new_value
    ) values (
        p_actor_user_id, p_actor_description, 'transaction.posted',
        'transaction', v_tx.reference,
        jsonb_build_object(
            'kind',          v_tx.kind,
            'account_id',    v_tx.account_id,
            'amount',        v_tx.amount,
            'balance_after', v_balance
        )
    );
end;
$$;

comment on function post_transaction(uuid, uuid, text) is
    'The only road to a balance. Posts a submitted or approved transaction: '
    'writes its account entries, moves the balance cache in the same '
    'database transaction, marks it posted, emits transaction.posted on '
    'financial_event and records who did it. The application role cannot '
    'write account_entry or account_balance any other way.';

-- What the verifier asks: which accounts' cache disagrees with their entries.
create or replace function ledger_drift()
returns table (
    account_id      uuid,
    cached          numeric(14, 2),
    computed        numeric(14, 2),
    cached_entries  bigint,
    actual_entries  bigint
)
language sql
stable
as $$
    with sums as (
        select e.account_id,
               sum(case e.direction when 'credit' then e.amount else -e.amount end)
                   as computed,
               count(*) as actual_entries
          from account_entry e
         group by e.account_id
    )
    select coalesce(b.account_id, s.account_id),
           coalesce(b.balance, 0),
           coalesce(s.computed, 0),
           coalesce(b.entry_count, 0),
           coalesce(s.actual_entries, 0)
      from account_balance b
      full outer join sums s on s.account_id = b.account_id
     where coalesce(b.balance, 0) is distinct from coalesce(s.computed, 0)
        or coalesce(b.entry_count, 0) is distinct from coalesce(s.actual_entries, 0);
$$;

-- The resolution, always from the entries. Returns what the cache now says.
create or replace function rebuild_account_balance(p_account_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance numeric(14, 2);
    v_count   bigint;
    v_seq     bigint;
begin
    perform 1 from account where id = p_account_id for update;
    if not found then
        raise exception 'no account %', p_account_id using errcode = 'no_data_found';
    end if;

    select coalesce(sum(case direction when 'credit' then amount else -amount end), 0),
           count(*),
           max(sequence_no)
      into v_balance, v_count, v_seq
      from account_entry
     where account_id = p_account_id;

    insert into account_balance (account_id, balance, entry_count, as_of_sequence_no)
    values (p_account_id, v_balance, v_count, v_seq)
    on conflict (account_id) do update set
        balance           = excluded.balance,
        entry_count       = excluded.entry_count,
        as_of_sequence_no = excluded.as_of_sequence_no,
        updated_at        = now();

    return v_balance;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- 0005's default privileges gave the application role full DML on every new
-- table. The ledger takes it back: the entries and the cache are written by
-- post_transaction() and rebuild_account_balance() alone, which run as the
-- owner. The transaction row itself stays the application's to create and
-- work — the guard above decides what may change on it.
revoke insert, update, delete on account_entry   from albarakah_app;
revoke insert, update, delete on account_balance from albarakah_app;

revoke all on function post_transaction(uuid, uuid, text) from public;
grant execute on function post_transaction(uuid, uuid, text) to albarakah_app;

revoke all on function rebuild_account_balance(uuid) from public;
grant execute on function rebuild_account_balance(uuid) to albarakah_app;

revoke all on function ledger_drift() from public;
grant execute on function ledger_drift() to albarakah_app;

-- ---------------------------------------------------------------------------
-- The test-data reset reaches the new tables
-- ---------------------------------------------------------------------------
-- reset_all_test_data (0046) truncates membership_application ... cascade,
-- which reaches transaction through member and account_entry through
-- transaction. account_balance is reached through account. Every guard
-- above honours the reset flag, so nothing here needs the function changed.
