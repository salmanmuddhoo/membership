-- Who may read the API reference (S-110 follow-up).
--
-- The document itself is generated from the route descriptors and has always
-- existed as docs/openapi.json; this is the permission for reading it inside
-- the application, where it can also be used to make a request.
--
-- A note on what this permission is and is not. It governs SEEING the
-- reference. It does not govern what those requests may do: every request the
-- explorer makes goes through the same middleware, the same permission check
-- and the same rate limit as any other caller, so it can only ever do what the
-- signed-in officer could already do through the screens. The explorer grants
-- no access; it removes the need for a separate HTTP client.
--
-- Its own permission rather than an existing one because the audience is
-- different from every other admin page: whoever integrates with this system.
-- That is often not the person who administers roles or reads the audit trail.
--
-- Same shape as audit.view (0036) and notification.view (0056): granted to
-- System Administrator to start with, and Configuration -> Roles extends it.
set local albarakah.actor_description = 'migration 0058_api_explorer_permission';

insert into permission (code, description) values
    ('api.explore', 'Read the API reference and make requests with it')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'api.explore'
 where r.code = 'system_administrator'
on conflict do nothing;
