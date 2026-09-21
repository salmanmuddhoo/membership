-- Officer feedback: a page over the audit trail (FRD Section 10), filterable
-- rather than a raw table dump, gated by its own permission — same shape as
-- system.reset_data (0019) — so who may see it is Configuration -> Roles'
-- decision, not this page's own.
set local albarakah.actor_description = 'migration 0036_audit_log_permission';

insert into permission (code, description) values
    ('audit.view', 'View the audit trail')
on conflict (code) do nothing;

-- Granted by default to System Administrator, the same starting point every
-- other admin-only permission here ships with; Configuration -> Roles can
-- extend it to anyone else.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'audit.view'
 where r.code = 'system_administrator'
on conflict do nothing;
