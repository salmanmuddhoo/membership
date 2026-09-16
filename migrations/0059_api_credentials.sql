-- Credentials for machine callers (S-909), and the system user their work is
-- attributed to (S-908).
--
-- Every caller the system has had so far is a person: a member of staff with a
-- session cookie, or a member with a token issued to a phone they proved they
-- hold. Albarakah.mu is neither. It is a server, it holds a credential rather
-- than a session, and nobody is present when it calls.
--
-- Three things follow from that, and they are why this is a table rather than
-- an environment variable:
--
--   It has to be revocable without a deploy. A secret in the environment is
--   changed by someone with access to the deployment at a moment when the
--   Society has already decided it is compromised.
--
--   There will be more than one. The website today; whatever the Society
--   integrates next after that. Each needs its own credential so revoking one
--   does not silence the others, and so the audit trail can say which called.
--
--   It has to carry its own ceiling. One integration looping on a bug must not
--   be able to exhaust the allowance of another.

create table api_credential (
    id          uuid        primary key default gen_random_uuid(),

    -- What this credential is for, in the Society's words. This is what the
    -- audit trail names, so "Albarakah.mu website" is worth more than a uuid.
    name        text        not null,

    -- The public half. Sent with every request, used to find the row, and not
    -- secret: it identifies the caller, it does not authenticate them.
    client_id   text        not null unique,

    -- SHA-256 of the secret half. Not bcrypt or argon2, deliberately: the
    -- secret is 32 bytes from the platform CSPRNG, not a passphrase somebody
    -- chose, so there is no dictionary to run and nothing a slow hash would
    -- buy. What matters is that the secret itself is never stored, so a copy
    -- of this table is not a set of working credentials.
    secret_hash text        not null,

    -- What it may do. An integration that submits applications has no business
    -- reading member records, and a column of them means the next integration
    -- does not need a migration to be narrower than this one.
    scopes      text[]      not null default '{}',

    -- Requests per minute for this credential alone.
    rate_limit_per_minute integer not null default 60
        check (rate_limit_per_minute > 0),

    is_active   boolean     not null default true,

    -- When it was last used, so a credential nobody calls any more is
    -- visible as such and can be revoked with confidence.
    last_used_at timestamptz,

    created_at  timestamptz not null default now(),
    created_by  uuid        references app_user(id),
    revoked_at  timestamptz,
    revoked_by  uuid        references app_user(id)
);

-- The sender asks one question on every request: which credential is this?
create index api_credential_active_idx
    on api_credential (client_id) where is_active;

comment on table api_credential is
    'A credential for a machine caller. The secret half is stored only as a '
    'hash; it is shown once, when issued, and cannot be recovered.';

set local albarakah.actor_description = 'migration 0059_api_credentials';

-- ---------------------------------------------------------------------------
-- Who may issue and revoke them
-- ---------------------------------------------------------------------------
-- Its own permission, and a narrow one: issuing a credential creates a caller
-- that can reach the system without a person behind it, which is a different
-- kind of act from editing a fee or reading the audit trail.
insert into permission (code, description) values
    ('api_credential.manage', 'Issue and revoke API credentials')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'api_credential.manage'
 where r.code = 'system_administrator'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Who the work is attributed to
-- ---------------------------------------------------------------------------
-- The same shape as the member app's own system user (migration 0039):
-- entra_subject is a value no token can carry, so claimPreProvisionedAccount
-- can never bind a real sign-in to it, and it holds no role, so it cannot
-- reach a page. Every audit row it writes names the credential that acted,
-- which is what makes "the website did this" answerable.
insert into app_user (entra_subject, email, display_name)
values ('system:public-api', 'public-api@system.albarakah.mu', 'Public API')
on conflict (email) do nothing;
