-- Identity and access (S-103).
--
-- Access is resolved from data, not from code: a user holds roles, a role holds
-- permissions, and the application asks the database what a user may do. Adding
-- a permission is therefore a migration plus configuration, not a release that
-- changes an if-statement.

create table app_user (
    -- Stable internal identity. Never the Entra subject: the external identity
    -- provider can change, and every foreign key in the system points here.
    id              uuid        primary key default gen_random_uuid(),

    -- The Entra subject claim ("sub"). Unique but nullable, so a user record can
    -- be created before that person has ever signed in.
    entra_subject   text        unique,

    email           citext      not null unique,
    display_name    text        not null,

    -- Deactivation, never deletion: audit rows and approvals must keep pointing
    -- at a real user for the retention period.
    is_active       boolean     not null default true,
    deactivated_at  timestamptz,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint app_user_deactivated_at_agrees_with_is_active
        check ((is_active and deactivated_at is null)
            or (not is_active and deactivated_at is not null))
);

comment on column app_user.entra_subject is
    'Entra "sub" claim. Null until the user first signs in.';

create table role (
    id          uuid        primary key default gen_random_uuid(),
    code        text        not null unique,
    name        text        not null,
    description text,
    -- A role the system relies on (e.g. Administrator) cannot be deleted by an
    -- administrator who would then be unable to undo it.
    is_system   boolean     not null default false,
    created_at  timestamptz not null default now()
);

create table permission (
    id          uuid  primary key default gen_random_uuid(),
    -- Dotted resource.action, e.g. 'member.approve'.
    code        text  not null unique,
    description text  not null
);

create table role_permission (
    role_id       uuid not null references role(id) on delete cascade,
    permission_id uuid not null references permission(id) on delete cascade,
    primary key (role_id, permission_id)
);

create table user_role (
    user_id     uuid        not null references app_user(id) on delete cascade,
    role_id     uuid        not null references role(id) on delete restrict,
    granted_at  timestamptz not null default now(),
    -- Who granted it. Kept even if that person is later deactivated, hence
    -- on delete restrict above and no cascade here.
    granted_by  uuid        references app_user(id),
    primary key (user_id, role_id)
);

-- The hot path: resolve a signed-in subject to a user, then that user to a set
-- of permission codes, on every request.
create index app_user_entra_subject_active_idx
    on app_user (entra_subject) where is_active;
create index user_role_user_id_idx on user_role (user_id);
create index role_permission_role_id_idx on role_permission (role_id);
