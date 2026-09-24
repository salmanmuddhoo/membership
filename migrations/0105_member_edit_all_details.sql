-- Officer request: a permission that lets whoever holds it correct any
-- detail of a member or non-member — name and NIC included, not only the
-- contact fields member.edit_contact (0045) opens. Saved the same way, on
-- the member/customer page, checked as on the application (a mandatory
-- field cannot be emptied, a NIC cannot be one already on file for someone
-- else) and audited as member.details.corrected.
--
-- Granted to no role here: a System Administrator assigns it on the Roles
-- page to whoever should hold it.
set local albarakah.actor_description = 'migration 0105_member_edit_all_details';

insert into permission (code, description) values
    ('member.edit_all_details',
     'Correct any detail of a member or non-member, name and NIC included')
on conflict (code) do nothing;
