-- Staff access hours (officer request, 26 November 2026).
--
-- The system can be closed to staff for part of every day — say from 17:00
-- to 07:00, Mauritius time. access.closed_hours holds the window as
-- {"from": "HH:MM", "until": "HH:MM"}; a window that runs past midnight
-- (from later than until) is read as one, and blank times leave the system
-- open all day, which is how it ships. A signed-in officer is signed out at
-- their next request inside the window (src/middleware.ts).
--
-- Two kinds of staff are not held to it: whoever holds the System
-- Administrator role, so the window can never lock everyone out of the
-- screen that sets it, and any account marked out_of_hours_access on the
-- staff page, for someone whose work runs late.
set local albarakah.actor_description = 'migration 0131_staff_access_hours';

insert into config_entry (key, value, value_type, description)
values
    ('access.closed_hours', '{"from": "", "until": ""}'::jsonb, 'json',
     'Staff cannot use the system between these two times (Mauritius ' ||
     'time, HH:MM). Blank leaves it open all day.')
on conflict (key) do nothing;

alter table app_user
    add column out_of_hours_access boolean not null default false;

comment on column app_user.out_of_hours_access is
    'May use the system inside access.closed_hours.';
