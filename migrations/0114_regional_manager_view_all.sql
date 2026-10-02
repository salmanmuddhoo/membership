-- A Regional Manager sees every transaction the Regional Officers recorded
-- (officer request), not only their own: transaction.view_all, which 0092
-- withheld from them. Still a permission like any other, so an
-- administrator moves it at Configuration -> Roles.
set local albarakah.actor_description = 'migration 0114_regional_manager_view_all';

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'transaction.view_all'
 where r.code = 'regional_manager'
on conflict do nothing;
