-- Who may reach the reports (S-905, S-906, S-907).
--
-- One permission to reach the page, and then nothing of its own: each report
-- names an EXISTING data permission — member.view, payment.view, audit.view —
-- and is shown only to someone who holds it.
--
-- That split matters. A report is a second way to read data that is already
-- governed, so giving reports their own permissions would create a parallel
-- access-control scheme that drifts from the first: someone barred from
-- payments would need to be barred twice, and the day somebody forgot is the
-- day the report became the way round it. Here there is one answer to "may
-- this person see payments", and the reports page asks it.
--
-- So report.view is deliberately weak on its own. It opens a page that lists
-- whatever the holder could already read elsewhere, and for someone with no
-- data permissions at all, nothing.
set local albarakah.actor_description = 'migration 0060_reports_permission';

insert into permission (code, description) values
    ('report.view', 'Reach the reports (each report still needs its own data permission)')
on conflict (code) do nothing;

-- Granted to System Administrator to start with, like every other permission
-- introduced here; Configuration -> Roles extends it to the Secretary, the
-- Treasurer and whoever else the Society decides.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'report.view'
 where r.code = 'system_administrator'
on conflict do nothing;
