-- The cash drawer (S-2001, S-2002; CSH-US-001 to CSH-US-004; FRD 14).
--
-- A cashier opens the drawer with a float, takes and pays out cash all
-- day, and closes it against a count. What the drawer should hold is not
-- typed in: it is the float plus every cash movement the ledger and the
-- fee receipts recorded while the drawer was open, and the difference
-- between that and the count is the over or short the session carries
-- from then on. A cashier has one drawer open at a time and closes only
-- the one they opened.
--
-- Attribution is done by the database, once, rather than by every path
-- that moves cash: when a cash transaction posts, or a cash fee payment
-- is recorded, a trigger looks up the acting user's open session and
-- writes it onto the row. A movement with no open session is nobody's
-- drawer, which the daily report (S-2003) will show.
--
-- There is no region or branch to record: nothing in the data has one
-- (the regional roles are roles, not places). A session is a cashier's.
set local albarakah.actor_description = 'migration 0084_cash_sessions';

insert into permission (code, description) values
    ('cash.session', 'Open and close one''s own cash drawer'),
    ('cash.view',    'See every cash drawer session and its count')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('clerk',            'cash.session'),
    ('account_officer',  'cash.session'),
    ('regional_officer', 'cash.session'),
    ('treasurer',        'cash.session'),
    ('treasurer',        'cash.view'),
    ('regional_manager', 'cash.view'),
    ('auditor',          'cash.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  cross join permission p
 where r.code = 'system_administrator'
   and p.code in ('cash.session', 'cash.view')
on conflict do nothing;

create table cash_session (
    id                uuid        primary key default gen_random_uuid(),
    cashier_user_id   uuid        not null references app_user(id),
    opened_at         timestamptz not null default now(),
    opening_float     numeric(14, 2) not null check (opening_float >= 0),
    closed_at         timestamptz,
    -- What was in the drawer at the count, what the ledger said should
    -- be, and the difference — fixed at closing, never recomputed.
    closing_count     numeric(14, 2) check (closing_count >= 0),
    expected_at_close numeric(14, 2),
    over_short        numeric(14, 2),
    note              text        not null default '',
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint cash_session_closed_is_counted check (
        (closed_at is null) = (closing_count is null)
        and (closed_at is null) = (expected_at_close is null)
        and (closed_at is null) = (over_short is null)
    )
);

-- One open drawer per cashier.
create unique index cash_session_one_open_idx
    on cash_session (cashier_user_id)
    where closed_at is null;

create index cash_session_cashier_idx
    on cash_session (cashier_user_id, opened_at desc);

create trigger cash_session_set_updated_at
    before update on cash_session
    for each row execute function set_updated_at();

-- A closed session is a record of a count that happened; nothing on it
-- changes afterwards, and no session is ever deleted.
create or replace function guard_cash_session()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
        raise exception 'a cash session is never deleted (%)', old.id
            using errcode = 'restrict_violation';
    end if;
    if old.closed_at is not null then
        raise exception 'cash session % is closed and cannot change', old.id
            using errcode = 'restrict_violation';
    end if;
    if (new.id, new.cashier_user_id, new.opened_at, new.opening_float)
       is distinct from
       (old.id, old.cashier_user_id, old.opened_at, old.opening_float) then
        raise exception
            'a cash session''s opening cannot change (%)', old.id
            using errcode = 'restrict_violation';
    end if;
    return new;
end;
$$;

create trigger cash_session_guard
    before update or delete on cash_session
    for each row execute function guard_cash_session();

-- Which drawer a cash movement went through.
alter table transaction
    add column cash_session_id uuid references cash_session(id);
alter table payment
    add column cash_session_id uuid references cash_session(id);

create index transaction_cash_session_idx
    on transaction (cash_session_id) where cash_session_id is not null;
create index payment_cash_session_idx
    on payment (cash_session_id) where cash_session_id is not null;

-- The acting user's open drawer, if they have one.
create or replace function open_cash_session_for(p_user_id uuid)
returns uuid
language sql
stable
as $$
    select id from cash_session
     where cashier_user_id = p_user_id and closed_at is null
$$;

-- A cash transaction is attributed to the drawer of whoever posted it,
-- at the moment it posts. Runs before transaction_guard (trigger names
-- fire alphabetically), on the same update post_transaction makes.
create or replace function attribute_transaction_cash_session()
returns trigger
language plpgsql
as $$
declare
    v_is_cash boolean;
begin
    if new.status = 'posted' and old.status <> 'posted'
       and new.cash_session_id is null and new.posted_by is not null then
        select is_cash into v_is_cash from payment_method where code = new.method;
        if coalesce(v_is_cash, false) then
            new.cash_session_id := open_cash_session_for(new.posted_by);
        end if;
    end if;
    return new;
end;
$$;

create trigger transaction_cash_session
    before update on transaction
    for each row execute function attribute_transaction_cash_session();

-- A cash fee receipt, or its refund, to the drawer of whoever recorded it.
create or replace function attribute_payment_cash_session()
returns trigger
language plpgsql
as $$
declare
    v_is_cash boolean;
begin
    if new.cash_session_id is null then
        select is_cash into v_is_cash from payment_method where code = new.method;
        if coalesce(v_is_cash, false) then
            new.cash_session_id := open_cash_session_for(new.recorded_by);
        end if;
    end if;
    return new;
end;
$$;

create trigger payment_cash_session
    before insert on payment
    for each row execute function attribute_payment_cash_session();

comment on table cash_session is
    'A cashier''s drawer for a stretch of the day (S-2001): opened with a '
    'float, closed against a count; expected_at_close is the float plus '
    'the cash movements attributed to it, over_short the count less that.';
comment on column transaction.cash_session_id is
    'The drawer a cash transaction went through (S-2002), set by trigger '
    'when it posts, from the open session of whoever posted it.';
comment on column payment.cash_session_id is
    'The drawer a cash fee receipt or refund went through (S-2002), set by '
    'trigger when it is recorded, from the open session of whoever '
    'recorded it.';

-- The test-data reset (0046) reaches transaction and payment through
-- membership_application, but nothing reaches cash_session: a drawer is a
-- cashier's, not a member's. Restated whole with cash_session in the
-- list, so a reset Test environment starts with no drawer open either.
create or replace function reset_all_test_data(
    p_actor_user_id     uuid,
    p_actor_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'reset_all_test_data requires a named actor'
            using errcode = 'restrict_violation';
    end if;

    perform set_config('albarakah.allow_full_reset', 'true', true);

    truncate table
        membership_application,
        receipt_number,
        sharepoint_folder,
        cash_session,
        audit_event
    cascade;

    truncate table account_number_counter;
    alter sequence application_reference_seq restart;
    alter sequence member_number_seq restart;
    alter sequence receipt_number_seq restart;

    insert into audit_event (
        actor_user_id, actor_description, action, entity_type, entity_id,
        new_value
    ) values (
        p_actor_user_id, p_actor_description, 'system.data_reset',
        'database', 'all',
        jsonb_build_object('reset_at', now())
    );
end;
$$;
