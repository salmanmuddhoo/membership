-- S-614, phase 1: opening an HSA/Investment account for someone who is not a
-- member at all — schema only, the same shape S-612 shipped this feature's
-- first phase in.
--
-- "As someone not yet on the system, I need to open an HSA or Investment
-- account without a membership application, providing my own details since
-- the Society has no record of me yet." Officer feedback, business
-- direction: accounts-only applicants never become Members — they get a
-- new kind of record of their own, and their accounts get their own
-- numbering (HSA0001, INV0001-style) rather than sharing one AB number the
-- way a member's Shares and MSA already do (migration 0018).
--
-- Three things, in order below: a third application_kind that captures an
-- applicant's own details (reusing the Individual membership type's field
-- and checklist configuration, per business direction — no new form to
-- design) alongside the account type(s) selected; a customer table,
-- deliberately as bare as member is bare (migration 0011) — no name or NIC
-- duplicated here, both live in application_party, exactly how member's own
-- name is read; and account gaining a nullable customer_id beside its
-- existing member_id, with the account_no migration 0018 dropped for members
-- (one shared number was clearer than two) reintroduced here for exactly the
-- opposite reason — a customer's accounts have no shared number to lean on,
-- so each one needs its own.
--
-- Nothing yet creates a row of any new shape here — every existing
-- application defaults to application_kind = 'membership', unaffected, so
-- this migration changes no behaviour on its own. The capture flow, the
-- document/signature/payment shape it actually needs, and the pages an
-- officer works it through are later, migration-free changes — same as
-- every phase of the existing-member flow before this one.
set local albarakah.actor_description = 'migration 0027_non_member_accounts';

-- ---------------------------------------------------------------------------
-- A third application_kind
-- ---------------------------------------------------------------------------
-- The inline check migration 0011 put on this column only ever named two
-- values; widened here to the three application_kind now has, rather than
-- left to silently admit anything once a third value exists.
alter table membership_application
    drop constraint membership_application_application_kind_check;

alter table membership_application
    add constraint membership_application_application_kind_check
        check (application_kind in
            ('membership', 'additional_account', 'customer_account'));

comment on column membership_application.application_kind is
    '''membership'' (S-301): captures an applicant and, on approval, '
    'creates a Member. ''additional_account'' (S-612): an existing member '
    'opening an account their membership did not already open — no '
    'applicant captured, existing_member_id names who it is for. '
    '''customer_account'' (S-614): someone not yet on the system at all, '
    'opening an account of their own — an applicant IS captured (reusing a '
    'membership type''s own field and checklist configuration, chosen at '
    'capture the same way a membership application picks one), and '
    'approval creates a customer rather than a member.';

alter table membership_application
    drop constraint membership_application_kind_shape;

alter table membership_application
    add constraint membership_application_kind_shape check (
        (application_kind = 'membership'
            and membership_type_id is not null
            and existing_member_id is null)
        or
        (application_kind = 'additional_account'
            and membership_type_id is null
            and existing_member_id is not null)
        or
        (application_kind = 'customer_account'
            and membership_type_id is not null
            and existing_member_id is null)
    );

-- ---------------------------------------------------------------------------
-- Customers: bare, exactly the way member is
-- ---------------------------------------------------------------------------
create table customer (
    id             uuid        primary key default gen_random_uuid(),

    -- The application this came from — the only place a customer's name,
    -- NIC and other details live, the same reason member carries no name of
    -- its own either (application_party, joined the same way).
    application_id uuid        unique references membership_application(id),

    status         text        not null default 'active',

    joined_at      timestamptz not null default now(),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create trigger customer_set_updated_at
    before update on customer
    for each row execute function set_updated_at();

create index customer_status_idx on customer (status);

comment on table customer is
    'Someone who holds an account but is not, and has never been, a Member '
    '(S-614) — deliberately its own kind of record so an accounts-only '
    'applicant never appears on the Members page. As bare as member: name, '
    'NIC and every other captured detail live in application_party against '
    'the application this came from, not duplicated here.';

-- ---------------------------------------------------------------------------
-- Accounts: a customer's, beside a member's
-- ---------------------------------------------------------------------------
-- account_no was dropped in 0018 because two Member accounts share one
-- number and storing a second would only invite disagreement. A customer's
-- accounts have no such shared number, so each needs one of its own —
-- reintroduced here nullable, populated only for a customer-owned account.
alter table account
    alter column member_id drop not null,
    add column customer_id uuid references customer(id),
    add column account_no text;

create unique index account_no_unique_idx
    on account (account_no) where account_no is not null;

alter table account
    add constraint account_owner_shape check (
        (member_id is not null and customer_id is null and account_no is null)
        or
        (member_id is null and customer_id is not null
            and account_no is not null)
    );

comment on column account.customer_id is
    'Set only for an account opened through the customer_account flow '
    '(S-614) — never both this and member_id (account_owner_shape).';

comment on column account.account_no is
    'HSA0001, INV0001-style — set only for a customer-owned account '
    '(account_owner_shape). A member-owned account carries no number of '
    'its own; the member''s own number (migration 0018) already identifies '
    'it, and duplicating it here would only invite the two to disagree.';

-- A customer holds at most one of each account type, the same rule
-- account_one_per_type_per_member_idx (0018) already gives a member — NULLs
-- never conflict, so this and that index coexist without a WHERE clause.
create unique index account_one_per_type_per_customer_idx
    on account (customer_id, account_type_id);

-- ---------------------------------------------------------------------------
-- What each account number is prefixed with
-- ---------------------------------------------------------------------------
-- Nothing before this named HSA or Investment specifically (S-612's own
-- reasoning); this does not either. An administrator sets the prefix the
-- same way they set every other fact about an account type — Configuration
-- → Account types — and it is required only once a customer actually opens
-- one of that type (checked in application code, not here, the same way
-- checklist_id is optional right up until a document is filed against it).
alter table account_type
    add column number_prefix text;

comment on column account_type.number_prefix is
    'What a customer-owned account of this type is numbered with — HSA, '
    'INV, whatever an administrator sets (S-614). Null until a customer '
    'flow needs one; a membership-default type (Shares, the MSA) never '
    'does, since a member''s accounts carry no number of their own.';

create table account_number_counter (
    account_type_id uuid primary key references account_type(id),
    next_serial     integer not null default 1 check (next_serial > 0)
);

comment on table account_number_counter is
    'One counter per account type, advanced by next_customer_account_number '
    '(S-614) — a table rather than a Postgres sequence per type because '
    'account types are administrator-created and open-ended (S-206); a '
    'sequence would have to be created and dropped alongside them.';

create or replace function next_customer_account_number(p_account_type_id uuid)
returns text
language plpgsql
as $$
declare
    v_prefix text;
    v_serial integer;
begin
    select number_prefix into v_prefix
      from account_type where id = p_account_type_id;
    if v_prefix is null or btrim(v_prefix) = '' then
        raise exception
            'account_type % has no number_prefix set — set one in '
            'Configuration before opening a customer account of this type',
            p_account_type_id;
    end if;

    insert into account_number_counter (account_type_id, next_serial)
    values (p_account_type_id, 2)
    on conflict (account_type_id)
        do update set next_serial = account_number_counter.next_serial + 1
    returning next_serial - 1 into v_serial;

    return upper(btrim(v_prefix)) || lpad(v_serial::text, 4, '0');
end;
$$;

comment on function next_customer_account_number(uuid) is
    'HSA0001, INV0001, ... — one counter per account type (S-614). Refuses '
    'a type with no number_prefix configured rather than numbering an '
    'account with nothing on it.';
