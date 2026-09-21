-- Membership applications, members and accounts (M3, S-301 to S-310).
--
-- The walking skeleton: an Individual application is captured, goes through
-- the Secretary and the President, and becomes a Member with an MSA account.
-- This is the first migration whose tables are *read* through the reference
-- configuration of M2 rather than duplicating it: which fields the form shows,
-- which are mandatory, which documents are needed and who approves all come
-- from there.

-- ---------------------------------------------------------------------------
-- Correcting the workflow seeded by 0010
-- ---------------------------------------------------------------------------
-- 0010 mapped FRD 7.4.3's status list onto steps without a draft state, which
-- made the capture step read `new -> submitted_for_review`. That is backwards:
-- FRD 7.4.3 defines New as "captured ... AND SUBMITTED by regional staff", so
-- capture is what *produces* New, and the state before it is a draft.
--
-- FRD 7.4.3 anticipates this: "Additional configurable sub-statuses (e.g.,
-- Draft, Returned for Correction) may be layered on top of this model at
-- implementation time without changing the core state machine." So they are
-- added as configuration rows, which is what decision 8 bought us.
set local albarakah.actor_description = 'migration 0011_membership_applications';

insert into workflow_status
    (entity_type, code, name, description, is_terminal, is_active, sort_order)
values
    ('membership_application', 'draft', 'Draft',
     'Being captured by regional staff. Not yet visible to central processing.',
     false, true, 0),
    ('membership_application', 'returned', 'Returned for Correction',
     'Sent back to the originating staff with a comment (FRD 7.4.3).',
     false, true, 7)
on conflict (entity_type, code) do nothing;

-- Capture now runs draft -> new.
update workflow_step
   set from_status = 'draft', to_status = 'new'
 where code = 'capture';

-- The Regional Manager gate sits on New, before central review.
update workflow_step
   set from_status = 'new', to_status = 'new'
 where code = 'regional_review';

-- The Secretary acts on New directly. 'submitted_for_review' stays an active
-- status because FRD 7.4.3 confirms it, but no enabled step produces it yet:
-- it is the state for a Secretary "claim" action, which the walking skeleton
-- does not need and which would be speculative to build now.
update workflow_step
   set from_status = 'new'
 where code = 'secretary_review';

-- ---------------------------------------------------------------------------
-- S-303 · Unique application reference
-- ---------------------------------------------------------------------------
-- A plain sequence, formatted on insert. Gaps are acceptable here and will
-- happen (a rolled-back capture consumes a number) — unlike receipt numbers in
-- M5, where a gap is an audit signal and the allocation has to be different.
create sequence application_reference_seq;

create or replace function next_application_reference()
returns text
language sql
volatile
as $$
    select 'APP-' || to_char(now(), 'YYYY') || '-'
           || lpad(nextval('application_reference_seq')::text, 6, '0');
$$;

-- ---------------------------------------------------------------------------
-- S-301 · The application
-- ---------------------------------------------------------------------------
create table membership_application (
    id                  uuid        primary key default gen_random_uuid(),
    reference           text        not null unique default next_application_reference(),

    membership_type_id  uuid        not null references membership_type(id),

    -- Status codes are configuration (workflow_status), so this is text rather
    -- than an enum: adding Abeyance must not need a migration.
    status              text        not null default 'draft',

    -- Who captured it. Needed for the segregation check (S-203): the officer
    -- who captured an application may not review or approve it.
    captured_by         uuid        not null references app_user(id),

    submitted_at        timestamptz,
    decided_at          timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create trigger membership_application_set_updated_at
    before update on membership_application
    for each row execute function set_updated_at();

create index membership_application_status_idx
    on membership_application (status, updated_at desc);
create index membership_application_captured_by_idx
    on membership_application (captured_by, updated_at desc);

-- The people an application is about. One row per subject instance, so the
-- FRD's "one or more Nominees where configured" (5.3) needs no schema change.
--
-- `values` is jsonb keyed by field_key because the fields themselves are
-- configuration (S-205): a column per field would put the form's shape back
-- into the schema and undo the point of Feature 2.2.
create table application_party (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references membership_application(id) on delete cascade,

    subject         text        not null
        check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary')),

    -- Distinguishes the first nominee from the second.
    ordinal         integer     not null default 1 check (ordinal >= 1),

    values          jsonb       not null default '{}'::jsonb,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (application_id, subject, ordinal)
);

create trigger application_party_set_updated_at
    before update on application_party
    for each row execute function set_updated_at();

-- Finding an applicant by NIC or surname without a scan.
create index application_party_values_idx
    on application_party using gin (values jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- S-307 · Status history
-- ---------------------------------------------------------------------------
-- audit_event already records every action, but reconstructing an approval
-- chain from it means filtering a table that holds everything. This is the
-- chain itself: one row per transition, in order, with the comment that
-- accompanied it. Append-only for the same reason audit_event is.
create table application_transition (
    id              bigserial   primary key,
    application_id  uuid        not null references membership_application(id) on delete cascade,

    from_status     text,
    to_status       text        not null,

    -- Which configured step performed it, so a transition can be traced back
    -- to the chain that authorised it.
    step_code       text,

    actor_user_id   uuid        not null references app_user(id),
    actor_role      text,

    -- Mandatory for a return or a rejection (S-305, S-306). Enforced in the
    -- service, which is where the message can explain itself.
    comment         text,

    occurred_at     timestamptz not null default now()
);

create index application_transition_chain_idx
    on application_transition (application_id, occurred_at);

create or replace function reject_transition_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'application_transition is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger application_transition_append_only
    before update or delete or truncate on application_transition
    for each statement execute function reject_transition_mutation();

-- ---------------------------------------------------------------------------
-- S-308 · Members
-- ---------------------------------------------------------------------------
-- "Member ID shall remain unique throughout the lifecycle, including for
-- members migrated from the legacy Excel register" (FRD 7.5). A sequence gives
-- uniqueness; the legacy import in M7 will need to reserve or advance it past
-- whatever the register already contains, which is why the format is fixed
-- here and the sequence is not restarted anywhere.
create sequence member_number_seq;

create or replace function next_member_number()
returns text
language sql
volatile
as $$
    select 'ABM-' || lpad(nextval('member_number_seq')::text, 6, '0');
$$;

create table member (
    id                  uuid        primary key default gen_random_uuid(),
    member_no           text        not null unique default next_member_number(),

    -- The application this member came from. Null for legacy records imported
    -- in M7, which have no application in this system.
    application_id      uuid        unique references membership_application(id),

    membership_type_id  uuid        not null references membership_type(id),

    status              text        not null default 'active',

    joined_at           timestamptz not null default now(),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create trigger member_set_updated_at
    before update on member
    for each row execute function set_updated_at();

create index member_status_idx on member (status, member_no);

-- ---------------------------------------------------------------------------
-- S-309 · Accounts
-- ---------------------------------------------------------------------------
create sequence account_number_seq;

create or replace function next_account_number()
returns text
language sql
volatile
as $$
    select 'ACC-' || lpad(nextval('account_number_seq')::text, 8, '0');
$$;

create table account (
    id               uuid        primary key default gen_random_uuid(),
    account_no       text        not null unique default next_account_number(),

    member_id        uuid        not null references member(id),
    account_type_id  uuid        not null references account_type(id),

    status           text        not null default 'active',

    -- True for the account opened automatically when the membership was
    -- approved. A partial unique index below makes "exactly one MSA is
    -- created" (S-309) something the database enforces rather than something
    -- the service promises — a retry that ran twice would violate it.
    is_membership_default boolean not null default false,

    opened_at        timestamptz not null default now(),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create trigger account_set_updated_at
    before update on account
    for each row execute function set_updated_at();

create unique index account_one_default_per_member_idx
    on account (member_id) where is_membership_default;

create index account_member_idx on account (member_id, opened_at);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into permission (code, description) values
    ('application.view',    'View membership applications'),
    ('application.capture', 'Capture and edit a draft membership application'),
    ('application.submit',  'Submit a captured application for central processing'),
    ('application.review',  'Review an application and forward it or return it'),
    ('application.approve', 'Approve or reject an application'),
    ('member.view',         'View members and their accounts')
on conflict (code) do nothing;

-- The roles 0010 created gain the capabilities their workflow steps imply.
-- Deliberately narrow: an officer cannot review, a Secretary cannot approve.
-- Segregation of duties (S-203) is a second, per-record check on top of this,
-- not a replacement for it — these grants stop a Secretary approving ANY
-- application; segregation stops one person acting twice on the SAME one.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('regional_officer', 'application.view'),
    ('regional_officer', 'application.capture'),
    ('regional_officer', 'application.submit'),
    ('regional_officer', 'member.view'),
    ('regional_manager', 'application.view'),
    ('regional_manager', 'application.review'),
    ('regional_manager', 'member.view'),
    ('secretary',        'application.view'),
    ('secretary',        'application.review'),
    ('secretary',        'member.view'),
    ('president',        'application.view'),
    ('president',        'application.approve'),
    ('president',        'member.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

-- The System Administrator gets to LOOK, and nothing more. Administering the
-- system is not the same as running the Society's business, and an
-- administrator who could approve applications would defeat both the
-- permission model and the segregation rules that sit on top of it. To walk an
-- application through, an administrator assigns themselves — or other people —
-- the business roles through /admin/users, which is auditable.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code in ('application.view', 'member.view')
 where r.code = 'system_administrator'
on conflict do nothing;
