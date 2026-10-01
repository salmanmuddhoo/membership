-- Disbursement is the Treasurer's (officer direction).
--
-- Approval decides; paying the money out is a separate act. Until now the
-- act after the chain — postApprovedTransaction — needed transaction.post,
-- the permission for posting a small transaction directly at the counter,
-- so an Account Officer could pay out what the President had approved and
-- the Treasurer could not. The Society's workflow is Secretary, President,
-- then the Treasurer disburses. transaction.disburse is that act for the
-- transactions that pay money out — a withdrawal, a transfer to a payee, a
-- closure, a resignation, a claim — and the Treasurer holds it. Posting an
-- approved deposit (money in) stays transaction.post. A permission like any
-- other, so an administrator moves it at Configuration → Roles.
set local albarakah.actor_description = 'migration 0095_transaction_disburse';

insert into permission (code, description) values
    ('transaction.disburse',
     'Pay out an approved withdrawal, transfer, closure, resignation or claim')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'transaction.disburse'
 where r.code = 'treasurer'
on conflict do nothing;
