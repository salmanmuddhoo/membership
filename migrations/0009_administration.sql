-- Administration: segregation of duties, and the permissions that govern it
-- (S-201, S-203, M2 Feature 2.1).

-- Which pairs of actions the same person may not both perform on the same
-- record. Configuration, not code (S-203): the compliance owner adds a pair
-- without a release, and a pair can be disabled without being forgotten.
--
-- The rule is deliberately about ACTIONS on a RECORD, not about roles. A
-- Regional Officer who also covers Clerk duties (FRD 6.1) keeps both roles;
-- what they may not do is capture an application and then approve that same
-- application. Blocking the role combination instead would break the operating
-- model the FRD describes.
create table segregation_rule (
    id             uuid        primary key default gen_random_uuid(),

    -- The action that, once performed by someone, bars them from the later one.
    earlier_action text        not null,
    later_action   text        not null,

    -- Scopes the rule, so 'approved' on a membership application and 'approved'
    -- on a payment are separate concerns.
    entity_type    text        not null,

    -- Why this pair conflicts, in words an auditor can read.
    description    text        not null,

    is_enabled     boolean     not null default true,

    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),

    constraint segregation_rule_actions_differ
        check (earlier_action <> later_action),
    unique (entity_type, earlier_action, later_action)
);

create trigger segregation_rule_set_updated_at
    before update on segregation_rule
    for each row execute function set_updated_at();

-- The lookup happens before every governed action.
create index segregation_rule_lookup_idx
    on segregation_rule (entity_type, later_action) where is_enabled;

comment on table segregation_rule is
    'Pairs of actions the same person may not both perform on one record. '
    'Enforced by querying audit_event, which is append-only, so the history '
    'the check relies on cannot be edited to get around it.';

-- The confirmed conflict from FRD Section 6: whoever captures an application
-- must not be the one who reviews or approves it. Seeded disabled-by-default
-- would be the wrong default for a control, so these ship enabled.
insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('membership_application',
     'membership.application.captured',
     'membership.application.reviewed',
     'The officer who captured an application may not review it.'),
    ('membership_application',
     'membership.application.captured',
     'membership.application.approved',
     'The officer who captured an application may not approve it.'),
    ('membership_application',
     'membership.application.reviewed',
     'membership.application.approved',
     'The officer who reviewed an application may not also approve it.')
on conflict do nothing;

-- Permissions governing administration itself. Deny-by-default means an
-- endpoint is unreachable until its permission exists AND is granted, so these
-- have to be created before the admin API can be used at all.
insert into permission (code, description) values
    ('role.view',        'View roles and their permissions'),
    ('role.manage',      'Create and modify roles, and grant permissions to them'),
    ('user.view',        'View staff accounts and their roles'),
    ('user.manage',      'Create staff accounts, assign roles, and deactivate leavers'),
    ('segregation.view', 'View segregation-of-duties rules'),
    ('segregation.manage', 'Add, amend and disable segregation-of-duties rules')
on conflict (code) do nothing;

-- The System Administrator role holds them. It is otherwise unprivileged: it
-- passes routes that declare NO permission, but every permission a route does
-- declare must still be granted explicitly, here or later.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in ('role.view', 'role.manage', 'user.view', 'user.manage',
                  'segregation.view', 'segregation.manage')
 where r.code = 'system_administrator'
on conflict do nothing;
