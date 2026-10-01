-- The Treasurer sees the fee schedules and nothing else of Configuration
-- (officer feedback).
--
-- 0017 gave the Treasurer config.view beside fee.manage, so that the fee
-- page would open for them — and config.view opens every page under
-- /admin/configuration/: account types, workflows, the approval matrix,
-- notification wording. The fee page now has its own read permission,
-- fee.view, held by every role that could already see it (config.view) or
-- change it (fee.manage); and config.view comes off the Treasurer.
set local albarakah.actor_description = 'migration 0091_fee_view';

insert into permission (code, description) values
    ('fee.view', 'View the fee schedules')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select distinct rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id
  join permission p    on p.code = 'fee.view'
 where held.code in ('config.view', 'fee.manage')
on conflict do nothing;

delete from role_permission rp
 using role r, permission p
 where rp.role_id = r.id and rp.permission_id = p.id
   and r.code = 'treasurer' and p.code = 'config.view';
