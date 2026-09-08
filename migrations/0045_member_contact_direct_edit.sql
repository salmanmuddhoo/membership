-- Officer feedback: a regional officer corrects a member's or non-member's
-- telephone number or address on the spot — no review, no approval, saved
-- directly (src/lib/members/contact.ts). Distinct from member.details_verify
-- (migration 0042), which gates an unattended change a member sent in from
-- the app; neither reason for that queue applies when the officer is
-- looking at the person's own document across the counter.
set local albarakah.actor_description = 'migration 0045_member_contact_direct_edit';

insert into permission (code, description) values
    ('member.edit_contact',
     'Save a member''s or non-member''s telephone/address directly, no approval')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'member.edit_contact'
 where r.code = 'regional_officer'
on conflict do nothing;
