-- Recording a transfer is its own permission (officer direction).
--
-- A transfer between two accounts here was recorded under transaction.post,
-- the permission for posting a deposit, a withdrawal and the rest directly
-- at the counter: at once below the escalation threshold, and once the
-- chain approved it. transaction.record_transfer is that act for a
-- transfer alone, so an administrator can let a role record transfers
-- without posting anything else, or the other way round, at Configuration
-- → Roles. Every role that holds transaction.post today is given it, so
-- nobody's work changes until someone moves it. A legacy transfer to a
-- payee is still paid out under transaction.disburse (0095).
set local albarakah.actor_description =
    'migration 0116_transaction_record_transfer';

insert into permission (code, description) values
    ('transaction.record_transfer',
     'Record a transfer between accounts: at once below the escalation threshold, or once approved')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select distinct rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id
  join permission p    on p.code = 'transaction.record_transfer'
 where held.code = 'transaction.post'
on conflict do nothing;
