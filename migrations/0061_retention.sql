-- Retention and disposal (S-1003).
--
-- The Society had not stated its retention periods, and the backlog treated
-- that as blocking the work. It is the other way round: the periods are the
-- Society's to state and the mechanism is ours to provide, so this ships the
-- mechanism with NO period set. Nothing is disposed of until somebody enters a
-- number on Configuration -> Retention, which means merging this changes the
-- behaviour of nothing, and the Society states its policy by using the system
-- rather than by sending an email somebody then has to translate into code.
--
-- What is deliberately NOT here is disposal of audit_event. Migration 0004
-- refuses UPDATE, DELETE and TRUNCATE on it with a trigger, and migration 0005
-- revokes those privileges from the application role as well — two independent
-- controls, described there as defence in depth. Honouring a retention period
-- on the audit trail means drilling through both, and that is a decision for
-- the Society with its cost stated, not a consequence of a backlog line
-- mentioning audit. docs/retention.md puts the question.
set local albarakah.actor_description = 'migration 0061_retention';

-- ---------------------------------------------------------------------------
-- The policy
-- ---------------------------------------------------------------------------
-- One row per class of record that can be disposed of. period_months null is
-- the default and means retain indefinitely — the behaviour every deployment
-- has today, so a database that has run this migration and nothing else
-- behaves exactly as it did before.
create table retention_policy (
    id            uuid        primary key default gen_random_uuid(),
    code          text        not null unique,
    label         text        not null,

    -- Null: retain indefinitely. A minimum of one month rather than zero,
    -- because a period of zero is not a policy, it is a mistake with no undo.
    period_months integer     check (period_months is null or period_months >= 1),

    sort_order    integer     not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create trigger retention_policy_set_updated_at
    before update on retention_policy
    for each row execute function set_updated_at();

-- Setting a period is a configuration change, audited like every other one.
-- It is also the only record of who authorised a disposal: the job that does
-- the work names this policy, and this row names the person who set it.
create trigger retention_policy_audit
    after insert or update or delete on retention_policy
    for each row execute function record_configuration_change();

-- The three classes that can be disposed of today. Each is a class whose
-- anchor date is a fact the system already holds:
--
--   notification_log     created_at    — when the message was sent
--   rejected_application decided_at    — when the application was refused
--   abandoned_draft      updated_at    — when the draft was last touched
--
-- A member's own KYC documents are NOT here, and cannot be until Phase 2. The
-- period for those runs from the end of the relationship, and resignation and
-- closure are M8, deferred. Anchoring them on the upload date instead would
-- destroy an active member's identity papers because they joined a long time
-- ago, which is not a retention policy, it is data loss with a schedule.
insert into retention_policy (code, label, sort_order) values
    ('notification_log',
     'Notification log', 1),
    ('rejected_application',
     'Applications that were not approved', 2),
    ('abandoned_draft',
     'Drafts that were never submitted', 3)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Marking what has been disposed of
-- ---------------------------------------------------------------------------
-- What disposal does differs by class, because what is left afterwards
-- differs:
--
--   A notification row IS the personal data — a member's number or address,
--   and the full text of what was said to them. Redacting it leaves an empty
--   shell, so the row goes.
--
--   A rejected application is not. Its reference, its status and the date it
--   was refused hold nothing about anybody; the applicant's details are in
--   application_party, and the identity papers are in SharePoint. So those go
--   and the row stays, marked below — the Society can still answer "was this
--   application refused, and when" without holding the papers to prove who
--   it was about.
--
--   An abandoned draft is neither. Nobody submitted it, nobody acted on it,
--   and it is an applicant's half-typed details and nothing else. It goes
--   entirely, through the same path an officer deleting a draft already uses.
--
-- disposed_at is what makes the middle case idempotent: a second run skips a
-- row that has already been through, so an interrupted run resumes without
-- repeating work and a chunk processed twice is harmless. The other two need
-- no marker — a deleted row is not selected again.
alter table membership_application
    add column disposed_at timestamptz;

-- The job asks "what is due" on every run; these keep that from becoming a
-- scan of everything ever recorded once the tables are years deep.
create index notification_disposal_idx
    on notification (created_at);

create index membership_application_disposal_idx
    on membership_application (status, decided_at)
    where disposed_at is null;

-- ---------------------------------------------------------------------------
-- Who may set a period
-- ---------------------------------------------------------------------------
-- Separate from config.manage, which every other Configuration page uses.
-- Setting a retention period is the one control in this application that
-- schedules the irreversible destruction of member data, and it should not be
-- reachable by everyone who may rename a document type.
insert into permission (code, description) values
    ('retention.manage', 'Set how long each kind of record is kept')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'retention.manage'
 where r.code = 'system_administrator'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Who the disposal is attributed to
-- ---------------------------------------------------------------------------
-- The same shape as the member app's (0039) and the public API's (0059):
-- entra_subject is a value no token can carry, so no real sign-in can ever
-- bind to it, and it holds no role, so it cannot reach a page. Deleting an
-- abandoned draft goes through deleteDraftApplication, which checks a staff
-- permission on a Principal; the job needs a user to be that Principal, and
-- every audit row it writes then names the job rather than a person.
insert into app_user (entra_subject, email, display_name)
values ('system:retention', 'retention@system.albarakah.mu', 'Retention')
on conflict (email) do nothing;
