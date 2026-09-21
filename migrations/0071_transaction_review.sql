-- Acting on a transaction that waits on a chain (S-1403, S-1404, FRD 5,
-- 6.5, 12).
--
-- Two permissions, by position on the chain rather than by step name, so a
-- chain an administrator re-shapes at Configuration -> Workflows needs no
-- release: every step but the last is a review (forward or return), and
-- the last is the decision (approve or reject).
--
--   transaction.review   act at a review step on a transaction chain
--   transaction.approve  decide at the last step of a transaction chain
--
-- Mapped onto FRD Section 5's roles: the Secretary reviews, the President
-- decides, and both can see the transaction and the account it moves.
-- Posting an approved transaction stays transaction.post (0069): approval
-- decides, disbursement moves money, and the two are not the same click
-- (S-1403, S-1503).
--
-- And one more segregation rule (S-203): the officer who captured a
-- transaction may not be the one who reviews it, alongside 0069's "may not
-- approve" and "may not post through a chain".
set local albarakah.actor_description = 'migration 0071_transaction_review';

insert into permission (code, description) values
    ('transaction.review',  'Review a transaction at a step on its approval chain'),
    ('transaction.approve', 'Approve or reject a transaction at the last step of its chain')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('secretary', 'transaction.review'),
    ('secretary', 'transaction.view'),
    ('secretary', 'account.view'),
    ('secretary', 'member.view'),
    ('president', 'transaction.approve'),
    ('president', 'transaction.view'),
    ('president', 'account.view'),
    ('president', 'member.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  cross join permission p
 where r.code = 'system_administrator'
   and p.code in ('transaction.review', 'transaction.approve')
on conflict do nothing;

insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('transaction',
     'transaction.captured',
     'transaction.reviewed',
     'The officer who captured a transaction may not review it.')
on conflict do nothing;
