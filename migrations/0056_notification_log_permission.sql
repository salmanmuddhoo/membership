-- Who may look at what the Society sent (S-904).
--
-- Its own permission rather than audit.view's: the two answer different
-- questions to different people. The audit trail is who did what, and is read
-- when something is being investigated. The delivery log is whether a member
-- was actually reached, and is read by whoever is about to ring them — an
-- officer chasing a document nobody responded to needs to know the email
-- bounced, and that is not a reason to give them the whole audit trail.
--
-- Same shape as audit.view (0036) and system.reset_data (0019): granted to
-- System Administrator to start with, and Configuration -> Roles extends it
-- from there.
set local albarakah.actor_description =
    'migration 0056_notification_log_permission';

insert into permission (code, description) values
    ('notification.view', 'View what the Society sent to members')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'notification.view'
 where r.code = 'system_administrator'
on conflict do nothing;
