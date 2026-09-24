-- Sign-out after inactivity (officer request).
--
-- A staff session left untouched for session.idle_minutes is signed out:
-- the page signs itself out once nobody has used it for that long, and the
-- server refuses a session whose last use is older, whichever comes first.
-- 0 turns the idle sign-out off, leaving only the 8-hour cap from sign-in.
-- Each sign-in, sign-out and idle sign-out is written to the audit trail
-- under the session's own id, so the trail says who was signed in when.
set local albarakah.actor_description = 'migration 0100_session_idle_timeout';

insert into config_entry (key, value, value_type, description)
values
    ('session.idle_minutes', '15'::jsonb, 'number',
     'A staff session with no activity for this many minutes is signed ' ||
     'out. 0 turns the idle sign-out off.')
on conflict (key) do nothing;
