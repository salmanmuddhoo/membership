-- M7 · Legacy migration (docs/backlog.md), first increment: members only,
-- added directly and approved on the spot — no capture, no review, no
-- approval chain (business direction: "all should be added directly ...
-- All will be in status Approved"). Balances (S-709) are a later pass, per
-- the milestone's own goal: "members first, finance later".
--
-- A migrated member is created the same way an ordinary approval creates
-- one — membership_application (status 'approved') + application_party +
-- member + accounts (src/lib/members/create.ts's createMemberFromApplication,
-- reused as-is) — so every existing page that reads a member already knows
-- how to show one. legacy_code is the only new thing a migrated record
-- carries.
set local albarakah.actor_description = 'migration 0047_member_migration';

-- S-705: "Preserve the legacy member code as a cross-reference ... distinct
-- from the Member ID this system allocates." member_no keeps coming from
-- next_member_number() untouched — legacy_code is never assigned as one,
-- so the "advance the sequence past the register" concern S-705 also raises
-- does not apply here: the two numbering schemes never share a namespace,
-- there is nothing for member_number_seq to collide with.
alter table member add column legacy_code text unique;

comment on column member.legacy_code is
    'The code Al Barakah''s legacy register used for this member, kept '
    'searchable as a cross-reference (S-705). Null for a member created the '
    'ordinary way, through an application.';

insert into permission (code, description) values
    ('system.migrate_members',
     'Import members directly from the legacy register, approved without '
     'review (System Administrator)')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'system.migrate_members'
 where r.code = 'system_administrator'
on conflict do nothing;
