-- Fees, payments and receipts (M5, S-501 to S-507).
--
-- What an applicant pays is recorded itemised against a receipt number, and
-- the sequence of those numbers is evidence. Three properties drive the whole
-- design, and each one is enforced here rather than promised by the service:
--
--   1. A receipt number is never reused. Not after a failure, not after a
--      void, not after a refund.
--   2. A gap in the sequence is VISIBLE, with its reason where the system
--      knows it. A bare sequence cannot do this: nextval() is non
--      transactional, so a rolled-back payment consumes a number and leaves
--      nothing behind to say what happened to it. So the number is a row,
--      written and committed before the payment is attempted — a payment that
--      then fails leaves that row stranded, which is exactly the visible gap
--      S-502 asks for.
--   3. Nothing that was recorded is ever edited. A mistake is voided and a
--      refund is its own record pointing at the original.
set local albarakah.actor_description = 'migration 0017_payments_and_receipts';

-- ---------------------------------------------------------------------------
-- S-502 · Receipt numbers
-- ---------------------------------------------------------------------------
create sequence receipt_number_seq;

-- The allocation ledger. One row per number ever handed out, whatever became
-- of it. Reconciliation reads this table, not the payments: a number that
-- never reached a payment is precisely the thing that has to be reportable.
create table receipt_number (
    id           uuid        primary key default gen_random_uuid(),

    -- The ordinal, and the printed form derived from it. Storing the number
    -- and generating the text (rather than the other way round) is what makes
    -- "is anything missing between these two receipts" arithmetic instead of
    -- string parsing, and it leaves one source of truth rather than two
    -- columns that could disagree.
    serial_no    bigint      not null unique
                 default nextval('receipt_number_seq'),
    receipt_no   text        not null unique
                 generated always as ('RCT-' || lpad(serial_no::text, 6, '0'))
                 stored,

    state        text        not null default 'allocated'
                 check (state in ('allocated', 'issued', 'abandoned', 'void')),

    -- Why it is not 'issued', where the system knows. S-502 asks for the gap
    -- to be reportable "with the reason, if known" — an allocation stranded by
    -- a crashed request has no reason, and reads as unexplained.
    reason       text,

    allocated_by uuid        not null references app_user(id),
    allocated_at timestamptz not null default now(),
    settled_at   timestamptz
);

create index receipt_number_state_idx on receipt_number (state, serial_no);
create index receipt_number_allocated_at_idx on receipt_number (allocated_at);

comment on table receipt_number is
    'Every receipt number ever allocated, and what became of it. Rows are '
    'never deleted, so a gap in the sequence is a row in a non-issued state '
    'rather than a number nobody can account for.';

-- A number, once allocated, is that number for ever, and a settled one does
-- not go back to being open. Voiding an issued receipt is the one transition
-- out of a settled state, because a receipt written in error has to be
-- withdrawable without the number being reused.
create or replace function guard_receipt_number()
returns trigger
language plpgsql
as $$
begin
    if tg_op in ('DELETE', 'TRUNCATE') then
        raise exception
            'receipt_number is a ledger; % is not permitted', tg_op
            using errcode = 'restrict_violation';
    end if;

    if new.serial_no <> old.serial_no then
        raise exception 'a receipt number cannot be changed once allocated'
            using errcode = 'restrict_violation';
    end if;

    if old.state <> new.state
       and not (old.state = 'allocated'
                and new.state in ('issued', 'abandoned', 'void'))
       and not (old.state = 'issued' and new.state = 'void') then
        raise exception 'receipt % cannot go from % to %',
            old.receipt_no, old.state, new.state
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

-- Row level, not statement level. A statement-level DELETE guard refuses the
-- statement before it looks at any row, which breaks every referential action
-- that reaches this table even when it would touch nothing (M3 learned this
-- the hard way in 0014).
create trigger receipt_number_guard
    before update or delete on receipt_number
    for each row execute function guard_receipt_number();

create trigger receipt_number_no_truncate
    before truncate on receipt_number
    for each statement execute function guard_receipt_number();

-- ---------------------------------------------------------------------------
-- S-501 · Payments
-- ---------------------------------------------------------------------------
create table payment (
    id                uuid        primary key default gen_random_uuid(),

    -- One receipt, one payment. The unique constraint is what stops a retry
    -- from filing a second payment under a number already printed.
    receipt_number_id uuid        not null unique references receipt_number(id),

    kind              text        not null default 'payment'
                      check (kind in ('payment', 'refund')),

    -- A refund names what it compensates. S-504: the original is never edited.
    refunds_id        uuid        references payment(id),

    -- Against an application before approval, or against a member after it.
    -- Exactly one, never both and never neither.
    application_id    uuid        references membership_application(id)
                      on delete restrict,
    member_id         uuid        references member(id) on delete restrict,

    -- The fee version in force when this was taken. Recorded so a later
    -- change to the schedule cannot alter what this applicant was charged —
    -- the acceptance criterion the versioning in 0010 exists to serve.
    fee_version_id    uuid        not null references fee_schedule_version(id),

    method            text        not null
                      check (method in ('cash', 'cheque', 'bank_transfer',
                                        'card', 'mobile')),
    -- Cheque number, transfer reference, terminal slip. Free text because the
    -- shape differs per method and none of it is ours to validate.
    method_reference  text        not null default '',

    currency          text        not null default 'MUR' check (currency = 'MUR'),
    total_amount      numeric(14, 2) not null check (total_amount >= 0),

    -- S-501: a tendered amount that does not match the schedule is allowed,
    -- but only deliberately. The service refuses to record one until it is
    -- acknowledged, and what was said is kept.
    variance_reason   text        not null default '',

    received_at       timestamptz not null default now(),
    recorded_by       uuid        not null references app_user(id),
    created_at        timestamptz not null default now(),

    -- A receipt withdrawn in error. The row stays; only these three columns
    -- may ever change after the insert.
    voided_at         timestamptz,
    voided_by         uuid        references app_user(id),
    void_reason       text,

    constraint payment_belongs_to_one_thing
        check (num_nonnulls(application_id, member_id) = 1),
    constraint payment_refund_names_its_original
        check ((kind = 'refund') = (refunds_id is not null)),
    constraint payment_void_is_complete
        check (num_nonnulls(voided_at, voided_by) in (0, 2))
);

create index payment_application_idx on payment (application_id, received_at);
create index payment_member_idx      on payment (member_id, received_at);
create index payment_refunds_idx     on payment (refunds_id);
create index payment_received_at_idx on payment (received_at);

-- The itemisation. This is what makes the receipt match the fee schedule
-- rather than being a single figure nobody can reconcile.
create table payment_line (
    id               uuid        primary key default gen_random_uuid(),
    payment_id       uuid        not null references payment(id) on delete restrict,

    component_code   text        not null
                     check (component_code in ('entrance', 'takaful', 'shares',
                                               'msa_deposit', 'processing')),

    -- What the schedule said at the time, kept beside what was actually
    -- taken. The difference is the variance, and it is arithmetic rather than
    -- a stored opinion. Null on a refund line, which has no scheduled amount.
    scheduled_amount numeric(14, 2) check (scheduled_amount >= 0),
    amount           numeric(14, 2) not null check (amount >= 0),

    sort_order       integer     not null default 0,

    unique (payment_id, component_code)
);

create index payment_line_component_idx on payment_line (component_code);

-- A payment is a record of something that happened. The only after-the-fact
-- change permitted is voiding it, and that is one-way.
create or replace function guard_payment()
returns trigger
language plpgsql
as $$
begin
    if tg_op in ('DELETE', 'TRUNCATE') then
        raise exception 'payment is append-only; % is not permitted', tg_op
            using errcode = 'restrict_violation';
    end if;

    if old.voided_at is not null then
        raise exception 'receipt already voided; it cannot be changed again'
            using errcode = 'restrict_violation';
    end if;

    -- Everything but the void columns must arrive unchanged. Listed rather
    -- than compared wholesale so that a column added later is refused by
    -- default until someone decides it may move.
    if (new.receipt_number_id, new.kind, new.refunds_id, new.application_id,
        new.member_id, new.fee_version_id, new.method, new.method_reference,
        new.currency, new.total_amount, new.variance_reason, new.received_at,
        new.recorded_by, new.created_at)
       is distinct from
       (old.receipt_number_id, old.kind, old.refunds_id, old.application_id,
        old.member_id, old.fee_version_id, old.method, old.method_reference,
        old.currency, old.total_amount, old.variance_reason, old.received_at,
        old.recorded_by, old.created_at) then
        raise exception 'a recorded payment cannot be edited; void it instead'
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

create trigger payment_guard
    before update or delete on payment
    for each row execute function guard_payment();

create trigger payment_no_truncate
    before truncate on payment
    for each statement execute function guard_payment();

create or replace function reject_payment_line_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception 'payment_line is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger payment_line_append_only
    before update or delete on payment_line
    for each row execute function reject_payment_line_mutation();

create trigger payment_line_no_truncate
    before truncate on payment_line
    for each statement execute function reject_payment_line_mutation();

-- S-503 asks that a reprinted receipt be identifiably a reprint. That is only
-- answerable if the first print is on the record, so each one is logged. The
-- payment itself cannot carry a counter: it is append-only, and rightly so.
create table receipt_print (
    id          uuid        primary key default gen_random_uuid(),
    payment_id  uuid        not null references payment(id) on delete restrict,
    printed_by  uuid        not null references app_user(id),
    printed_at  timestamptz not null default now()
);

create index receipt_print_payment_idx on receipt_print (payment_id, printed_at);

create or replace function reject_receipt_print_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception 'receipt_print is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger receipt_print_no_update
    before update on receipt_print
    for each row execute function reject_receipt_print_mutation();

create trigger receipt_print_no_delete
    before delete on receipt_print
    for each row execute function reject_receipt_print_mutation();

create trigger receipt_print_no_truncate
    before truncate on receipt_print
    for each statement execute function reject_receipt_print_mutation();

-- ---------------------------------------------------------------------------
-- S-504 · The financial event stream
-- ---------------------------------------------------------------------------
-- Phase 3 will post these to an accounting system. It is a stream rather than
-- a query over the tables above because a consumer needs to know what it has
-- already seen, and an ordinal it can checkpoint against is the cheapest way
-- to give it that.
create table financial_event (
    id           uuid        primary key default gen_random_uuid(),

    -- A checkpoint ordinal for the consumer, not evidence in itself. It may
    -- gap where a rolled-back transaction took a value; the receipt sequence
    -- is the thing whose gaps mean something, and it is above.
    sequence_no  bigint      generated always as identity,

    event_type   text        not null
                 check (event_type in ('payment.recorded', 'payment.refunded',
                                       'payment.voided')),

    payment_id   uuid        not null references payment(id) on delete restrict,
    receipt_no   text        not null,

    -- The whole event, self-contained: fee version, components, amounts, who
    -- and when. A consumer must not have to re-derive it by joining back into
    -- tables that may have moved on.
    payload      jsonb       not null,

    occurred_at  timestamptz not null default now()
);

create unique index financial_event_sequence_idx on financial_event (sequence_no);
create index financial_event_payment_idx on financial_event (payment_id);
create index financial_event_occurred_idx on financial_event (occurred_at);

create or replace function reject_financial_event_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception 'financial_event is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger financial_event_no_update
    before update on financial_event
    for each row execute function reject_financial_event_mutation();

create trigger financial_event_no_delete
    before delete on financial_event
    for each row execute function reject_financial_event_mutation();

create trigger financial_event_no_truncate
    before truncate on financial_event
    for each statement execute function reject_financial_event_mutation();

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------
insert into role (code, name, description) values
    ('treasurer', 'Treasurer',
     'Owns the receipt sequence: refunds, voids, reconciliation and the fee schedules (FRD 7.8.2).')
on conflict (code) do nothing;

insert into permission (code, description) values
    ('payment.view',      'View payments and receipts'),
    ('payment.record',    'Record a payment and issue its receipt'),
    ('payment.refund',    'Refund against an issued receipt'),
    ('payment.void',      'Void a receipt issued in error'),
    ('receipt.reconcile', 'Reconcile the receipt sequence and see its exceptions')
on conflict (code) do nothing;

-- Who does what. FRD 6 puts the receipt in the Regional Officer's hands and
-- the sequence in the Treasurer's, which is itself a separation: the person
-- who takes the money is not the person who can unwind it.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('regional_officer', 'payment.view'),
    ('regional_officer', 'payment.record'),
    ('regional_manager', 'payment.view'),
    ('secretary',        'payment.view'),
    ('president',        'payment.view'),
    ('treasurer',        'payment.view'),
    ('treasurer',        'payment.refund'),
    ('treasurer',        'payment.void'),
    ('treasurer',        'receipt.reconcile'),
    -- S-207 named the Treasurer as the owner of the fee schedules; 0010 left
    -- fee.manage with the System Administrator only because the role did not
    -- exist yet. It does now.
    ('treasurer',        'fee.manage'),
    ('treasurer',        'config.view'),
    -- A Treasurer reconciling a receipt has to be able to open the
    -- application or member it was issued against.
    ('treasurer',        'application.view'),
    ('treasurer',        'member.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

-- The System Administrator gets to look, as it does everywhere else. Handling
-- money is running the Society's business, not administering the system.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code in ('payment.view', 'receipt.reconcile')
 where r.code = 'system_administrator'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- S-203 · Segregation of duties
-- ---------------------------------------------------------------------------
-- Taking the money and unwinding it are the conflicting pair. Refunding is
-- scoped to the payment record, so this bars the person who recorded a
-- particular receipt from refunding or voiding THAT receipt, not from doing
-- either job in general.
insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('payment',
     'membership.payment.recorded',
     'membership.payment.refunded',
     'The officer who recorded a payment may not refund it.'),
    ('payment',
     'membership.payment.recorded',
     'membership.payment.voided',
     'The officer who recorded a payment may not void it.')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The triggers above refuse these operations regardless. Revoking the
-- privilege as well means the attempt fails at the permission check, before a
-- row is touched — the same belt and braces the audit log has had since 0004.
-- Voiding is an UPDATE, so payment and receipt_number keep theirs.
revoke update, delete on financial_event from albarakah_app;
revoke update, delete on payment_line    from albarakah_app;
revoke update, delete on receipt_print   from albarakah_app;
revoke delete           on payment       from albarakah_app;
revoke delete           on receipt_number from albarakah_app;
