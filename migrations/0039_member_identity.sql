-- The member mobile application's identity (AD-03, docs/member-app.md).
--
-- Members have no account in app_user, and must not: that table is staff,
-- matched on an Entra subject, with roles and permissions. A member is
-- identified by NIC + AB Number, verified by a one-time code to the mobile
-- on their record, and authenticated from then on by a session held on the
-- device. Three things, three places:
--
--   member_login_challenge  one code, one purpose, hashed, few attempts
--   member_session          the authenticated mobile identity, and its link
--                           (member_id) to the member record — resolved
--                           server-side on every request, never sent to the
--                           phone
--   member_details_request  a member's own capture of their details, held
--                           for staff to verify before the record changes
--
-- Applications started from the phone are captured by a system user, so
-- captured_by stays not null and the audit trail names who did it; the
-- applicant's own verified mobile is what ties the row to their sessions.
set local albarakah.actor_description = 'migration 0039_member_identity';

-- ---------------------------------------------------------------------------
-- The system user the member app captures as
-- ---------------------------------------------------------------------------
-- entra_subject is set to a value no token can carry, so
-- claimPreProvisionedAccount (principal.ts) can never bind a real sign-in to
-- it, and no role is granted: it holds no permission and cannot reach a page.
insert into app_user (entra_subject, email, display_name)
values ('system:member-app', 'member-app@system.albarakah.mu', 'Member app')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- Received online: submitted from the phone, not yet the branch's
-- ---------------------------------------------------------------------------
-- The officer's own submit (draft -> new, the 'capture' step) requires the
-- signed form filed and the payment recorded, neither of which a phone can
-- do. So an application submitted online lands here instead, back in the
-- officer's hands exactly as a 'returned' one is: they check the documents,
-- print the form for signing, take the payment and submit it into the chain
-- as usual. Statuses are configuration (decision 8), so this is a row.
insert into workflow_status
    (entity_type, code, name, description, is_terminal, is_active, sort_order)
values
    ('membership_application', 'received', 'Received online',
     'Submitted by the applicant from the member app. An officer completes ' ||
     'the signed form and payment at the branch, then submits it.',
     false, true, 1)
on conflict (entity_type, code) do nothing;

-- Which verified mobile started this application from the app. Null for
-- everything captured by staff. Not a foreign key to anything: an applicant
-- is nobody yet, and the number is the only identity they have.
alter table membership_application
    add column applicant_mobile text;

create index membership_application_applicant_mobile_idx
    on membership_application (applicant_mobile)
    where applicant_mobile is not null;

comment on column membership_application.applicant_mobile is
    'E.164 mobile the applicant verified in the member app before starting '
    'this application. What ties the row to their sessions; null when staff '
    'captured it.';

-- ---------------------------------------------------------------------------
-- One-time codes
-- ---------------------------------------------------------------------------
-- A link attempt that named nobody still gets a challenge row
-- ('link_member_miss'): the response is the same shape and the same
-- timing as a hit, no code is ever sent, and verifying against it fails
-- and burns exactly as a wrong code does. That is what keeps the answer
-- from saying whether a NIC + AB Number pair exists.
create table member_login_challenge (
    id            uuid        primary key default gen_random_uuid(),
    purpose       text        not null
                  check (purpose in ('link_member', 'link_member_miss', 'sign_up')),
    -- What the request was keyed on, for the resend cooldown: the AB Number
    -- for a link attempt (hit or miss), the number given for a sign-up.
    request_key   text        not null,
    -- E.164. For link_member, the member's registered mobile — the person
    -- never typed it. For sign_up, the number they gave. Empty for a miss.
    mobile        text        not null,
    -- Set for link_member only: the member NIC + AB Number identified.
    member_id     uuid        references member(id),
    -- Never the code itself.
    code_hash     text        not null,
    attempts      int         not null default 0,
    expires_at    timestamptz not null,
    consumed_at   timestamptz,
    created_at    timestamptz not null default now(),

    constraint member_login_challenge_purpose_agrees_with_member
        check ((purpose = 'link_member') = (member_id is not null))
);

create index member_login_challenge_expiry_idx
    on member_login_challenge (expires_at);
create index member_login_challenge_request_key_idx
    on member_login_challenge (request_key, created_at desc);

-- ---------------------------------------------------------------------------
-- Sessions: the authenticated mobile identity
-- ---------------------------------------------------------------------------
create table member_session (
    id                 uuid        primary key default gen_random_uuid(),
    -- Verified, E.164.
    mobile             text        not null,
    -- The link. Null for an applicant session, which can start and follow
    -- its own applications and nothing else. Never both.
    member_id          uuid        references member(id),
    customer_id        uuid        references customer(id),
    refresh_token_hash text        not null unique,
    linked_at          timestamptz not null default now(),
    last_used_at       timestamptz not null default now(),
    expires_at         timestamptz not null,
    revoked_at         timestamptz,
    -- What the phone reported about itself, for a member looking at their
    -- own sessions one day. Free text, never trusted for anything.
    device_label       text,

    constraint member_session_one_link
        check (member_id is null or customer_id is null)
);

create index member_session_member_idx
    on member_session (member_id) where revoked_at is null;
create index member_session_mobile_idx
    on member_session (mobile) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- A member's own capture of their details
-- ---------------------------------------------------------------------------
-- What KYC verified must not change from a phone with nobody checking; a
-- member who moved house must still be able to say so. This sits between:
-- the values they entered, as the officer's form would have them, held
-- until staff apply or decline them.
create table member_details_request (
    id            uuid        primary key default gen_random_uuid(),
    member_id     uuid        not null references member(id),
    session_id    uuid        not null references member_session(id),
    -- [{ subject, ordinal, values }], the shape application_party has.
    parties       jsonb       not null,
    status        text        not null default 'pending'
                  check (status in ('pending', 'applied', 'declined')),
    submitted_at  timestamptz not null default now(),
    decided_at    timestamptz,
    decided_by    uuid        references app_user(id),
    comment       text,

    constraint member_details_request_decision_shape
        check ((status = 'pending') = (decided_at is null))
);

-- One open request per member: the app refuses a second while one waits.
create unique index member_details_request_one_pending_idx
    on member_details_request (member_id) where status = 'pending';

-- Migration 0005's default privileges already let the application read and
-- write these. A request is history once made: it is applied or declined,
-- never removed.
revoke delete on member_details_request from albarakah_app;
