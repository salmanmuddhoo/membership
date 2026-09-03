-- S-612: additional-account applications — schema foundation.
--
-- "As an existing member I need to open an account type membership did not
-- already open for me (HSA, Investment, or anything else added later),
-- through the same Regional Manager -> Secretary -> President chain a
-- membership application already uses." Officer feedback, business
-- direction to share the exact same workflow settings as membership
-- applications, not a chain configured separately for it.
--
-- Sharing settings is what decides the shape of this: rather than a second
-- workflow_definition an administrator would have to keep in step with the
-- first by hand, this application lives in the SAME membership_application
-- table, under the SAME entity_type ('membership_application') every
-- workflow_step, segregation_rule and audit action already keys on.
-- Enabling Regional oversight, or changing its quorum, governs both kinds
-- of application at once with no code change either way — the same "no
-- code change" activeChain() already gives every other step (S-611).
--
-- Phase 1 of 2. This is schema only: what an application needs to record
-- it is opening an account rather than capturing a membership, and which
-- account type(s) it is opening. The capture flow, the document/signature/
-- payment shape that flow actually needs, and the pages an officer works
-- it through are a later, migration-free change — same as any other
-- application-side logic in this codebase. Nothing here is reachable until
-- that code exists: every existing row defaults to application_kind =
-- 'membership' and this migration changes no existing behaviour.
set local albarakah.actor_description = 'migration 0025_additional_account_applications';

alter table membership_application
    add column application_kind text not null default 'membership'
        check (application_kind in ('membership', 'additional_account')),
    add column existing_member_id uuid references member(id),
    alter column membership_type_id drop not null;

comment on column membership_application.application_kind is
    '''membership'': the walking-skeleton flow (S-301) — captures an '
    'applicant and, on approval, creates a Member. ''additional_account'' '
    '(S-612): an existing member opening an account type membership did '
    'not already open for them — no applicant is captured, and approval '
    'opens the selected account(s) under existing_member_id rather than '
    'creating a member.';

comment on column membership_application.existing_member_id is
    'Set only when application_kind = ''additional_account'': the member '
    'this application is opening an account for (S-612). Null for a '
    'membership application, which has no member yet to reference.';

alter table membership_application
    add constraint membership_application_kind_shape check (
        (application_kind = 'membership'
            and membership_type_id is not null
            and existing_member_id is null)
        or
        (application_kind = 'additional_account'
            and membership_type_id is null
            and existing_member_id is not null)
    );

-- Which account type(s) an additional_account application opens on approval
-- — "Select HSA Account or Investment account or both" is a set, not a
-- single choice. Nothing here names HSA or Investment: any active,
-- non-membership-default account type is a valid selection, since both are
-- ordinary Account types (Configuration -> Account types) an administrator
-- creates the same way MSA and Shares were, not a special case this schema
-- knows by name.
create table application_account_selection (
    application_id  uuid not null references membership_application(id) on delete cascade,
    account_type_id uuid not null references account_type(id),
    primary key (application_id, account_type_id)
);

comment on table application_account_selection is
    'Which account type(s) an additional_account application (S-612) opens '
    'on approval. Empty for a membership application, whose accounts come '
    'from account_type.is_membership_default instead.';

create index application_account_selection_type_idx
    on application_account_selection (account_type_id);
