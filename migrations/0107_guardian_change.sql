-- Changing a Minor's guardian (officer direction, after the Phase 2 test
-- round): when a guardian dies the minor needs another before money leaves
-- their accounts again.
--
-- An officer records the change on the minor's page — the new guardian is
-- an existing member, found as capture finds one, so their identity is
-- already on file under their own membership — and a second person approves
-- it before it takes effect. Until then the minor's guardian block is
-- untouched. On approval the block on the minor's founding application is
-- replaced with what the change carries, and the old one is kept here and
-- in the audit trail.
--
-- member.guardian_change records one; member.guardian_approve decides it,
-- never on a change the same person recorded. Both are ordinary
-- permissions an administrator moves at Configuration → Roles.
set local albarakah.actor_description = 'migration 0107_guardian_change';

insert into permission (code, description) values
    ('member.guardian_change',
     'Record a new guardian for a Minor member, for approval'),
    ('member.guardian_approve',
     'Approve or reject a Minor member''s change of guardian')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('regional_officer', 'member.guardian_change'),
    ('regional_manager', 'member.guardian_change'),
    ('regional_manager', 'member.guardian_approve'),
    ('secretary',        'member.guardian_approve')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

create table guardian_change (
    id               uuid        primary key default gen_random_uuid(),
    member_id        uuid        not null references member(id) on delete cascade,
    -- The guardian block as it was when the change was recorded, and as it
    -- will be once approved: the same keys capture writes (surname, name,
    -- nic, member_id, relationship, mobile).
    previous_values  jsonb       not null,
    new_values       jsonb       not null,
    status           text        not null default 'submitted'
                     check (status in ('submitted', 'approved', 'rejected',
                                       'cancelled')),
    captured_by      uuid        references app_user(id) on delete set null,
    captured_at      timestamptz not null default now(),
    decided_by       uuid        references app_user(id) on delete set null,
    decided_at       timestamptz,
    -- Required when rejected, optional when approved.
    comment          text,
    constraint guardian_change_decided_is_dated
        check ((status = 'submitted') = (decided_at is null))
);

-- One change waiting per minor: a second would race the first to the
-- guardian block.
create unique index guardian_change_one_open_idx
    on guardian_change (member_id)
 where status = 'submitted';

comment on table guardian_change is
    'A Minor member''s change of guardian, recorded by one officer and '
    'approved by another before the guardian block is replaced.';
