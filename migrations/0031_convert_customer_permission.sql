-- Officer feedback: "Apply to become a member" (S-614 phase 5,
-- startMembershipApplicationFromCustomer) rode on application.capture —
-- whoever could capture any application could also convert any non-member
-- customer into a membership applicant. The Society wants that narrower
-- and configurable on its own, not tied to capture rights in general: this
-- role might be the Regional Officer, or it might not.
set local albarakah.actor_description = 'migration 0031_convert_customer_permission';

insert into permission (code, description) values
    ('member.convert',
     'Start a membership application for a non-member customer '
     '("Apply to become a member")')
on conflict (code) do nothing;

-- Matches what regional_officer could already do through application.capture
-- (members/[id].astro's own gate, until this migration), so nothing an
-- administrator has not touched changes behaviour on deploy. Configuration
-- -> Roles is where it moves from here.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'member.convert'
 where r.code = 'regional_officer'
on conflict do nothing;
