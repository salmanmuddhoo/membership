-- Who may do what to money (S-1311, FRD 5, 6.3, 12).
--
-- The permissions a transaction needs, in the entity.action form every other
-- permission takes, and the default mapping onto FRD Section 5's roles —
-- editable at Administration -> Roles like the rest (S-201). The roles that
-- Section 5 names and Phase 1 never needed — Clerk, Account Officer, Auditor
-- — are created here with no members, so the mapping is complete on day one
-- and an administrator assigns people rather than inventing roles.
--
--   transaction.capture  record a transaction (0068; Regional Officer, Clerk)
--   transaction.post     post one below the escalation threshold, directly
--                        (FRD 6.3 "Account Officer can action directly");
--                        the Regional Officer holds it too, because at a
--                        regional counter the officer who takes a deposit is
--                        the one who posts it (S-1305)
--   transaction.view     read transactions
--   account.view         read an account's balance and history
--   receipt.void         void a transaction's receipt (the Treasurer's, as
--                        payment.void is)
--
-- And the segregation rules (S-203): the officer who captured a transaction
-- may not be the one who approves it, posts it through a chain, or voids
-- its receipt. A deposit below the threshold is captured and posted in one
-- act by one person (FRD 6.2, 6.3) and no rule is consulted for it; the
-- rules bite where posting is a separate act — M14's chain — and where a
-- receipt is voided.
set local albarakah.actor_description = 'migration 0069_transaction_permissions';

insert into permission (code, description) values
    ('transaction.view',  'View transactions'),
    ('transaction.post',  'Post a transaction directly, below the escalation threshold'),
    ('account.view',      'View an account''s balance and history'),
    ('receipt.void',      'Void a transaction''s receipt')
on conflict (code) do nothing;

insert into role (code, name, description) values
    ('clerk', 'Clerk',
     'Records transactions at the counter for an Account Officer to post (FRD Section 5).'),
    ('account_officer', 'Account Officer',
     'Posts transactions below the escalation threshold and actions the first approval step (FRD Section 5, 6.3).'),
    ('auditor', 'Auditor',
     'Reads accounts, transactions and the audit trail; changes nothing (FRD Section 5).')
on conflict (code) do nothing;

-- The default mapping. Two views ride on what a role already sees — money
-- follows the member, and a transaction follows a payment — so nobody who
-- could see a member's page yesterday loses the balance on it today.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('clerk',            'transaction.capture'),
    ('clerk',            'transaction.view'),
    ('clerk',            'account.view'),
    ('clerk',            'member.view'),
    ('account_officer',  'transaction.capture'),
    ('account_officer',  'transaction.post'),
    ('account_officer',  'transaction.view'),
    ('account_officer',  'account.view'),
    ('account_officer',  'member.view'),
    ('regional_officer', 'transaction.post'),
    ('treasurer',        'receipt.void'),
    ('auditor',          'transaction.view'),
    ('auditor',          'account.view'),
    ('auditor',          'member.view'),
    ('auditor',          'payment.view'),
    ('auditor',          'audit.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id and held.code = 'member.view'
  join permission p on p.code = 'account.view'
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id and held.code = 'payment.view'
  join permission p on p.code = 'transaction.view'
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  cross join permission p
 where r.code = 'system_administrator'
   and p.code in ('transaction.view', 'transaction.post', 'account.view',
                  'receipt.void')
on conflict do nothing;

-- The segregation rules. Keyed on the transaction's reference, which is what
-- post_transaction() and the capture path write as the audit entity id.
insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('transaction',
     'transaction.captured',
     'transaction.approved',
     'The officer who captured a transaction may not approve it.'),
    ('transaction',
     'transaction.captured',
     'transaction.posted',
     'The officer who captured a transaction may not post it through a chain.'),
    ('transaction',
     'transaction.captured',
     'transaction.voided',
     'The officer who captured a transaction may not void its receipt.')
on conflict do nothing;
