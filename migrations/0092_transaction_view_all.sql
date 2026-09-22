-- Who sees every transaction in the Society's day, and who sees only their
-- own (officer feedback).
--
-- Transactions → Today's transactions listed every transaction recorded,
-- for anyone holding transaction.view. A Regional Officer or Regional
-- Manager should see the ones they recorded; the Secretary, the President,
-- the Treasurer and the other roles that oversee the day see them all.
-- transaction.view_all is that difference, a permission like any other, so
-- an administrator moves it between roles at Configuration → Roles.
set local albarakah.actor_description = 'migration 0092_transaction_view_all';

insert into permission (code, description) values
    ('transaction.view_all',
     'See every transaction in the day''s list, not only the ones you recorded')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select distinct rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id
  join role r          on r.id = rp.role_id
  join permission p    on p.code = 'transaction.view_all'
 where held.code = 'transaction.view'
   and r.code not in ('regional_officer', 'regional_manager')
on conflict do nothing;
