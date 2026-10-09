-- Where a member's own transaction from the app goes (officer direction,
-- October 2026; S-2102, docs/member-app.md).
--
-- Every request made through the app is validated by officers before
-- money moves, and the member sees "Pending approval" until then. The
-- approval matrix (0070) already lets a rule name the Member role (0085)
-- as the one initiating it; without such a rule a member's deposit of up
-- to the threshold matched "Posts at once" and was refused for the app,
-- which never posts. Three rules, ahead of the defaults:
--
--   deposit     any amount  Accounts verification (Account Officer), then
--                           an Account Officer records it (transaction.post)
--   withdrawal  any amount  Secretary -> President, then the Treasurer
--                           disburses (transaction.disburse, 0095)
--   transfer    any amount  Secretary -> President, then it is recorded
--
-- The deposit chain is new: one step, the accounts department checking the
-- money arrived in the Society's bank account before it is recorded. Being
-- a chain's last step, it is a decision (transaction.approve), so the
-- Account Officer role is given that permission; acting on any step still
-- needs the step's own role, so it reaches no other chain's decision.
--
-- All of it is configuration, edited at Configuration -> Approval matrix
-- and -> Workflows like the rest. Which operations the app may start at
-- all stays member_api.enabled_operations (Configuration -> Member app),
-- unchanged here.
set local albarakah.actor_description = 'migration 0120_member_transaction_routes';

insert into workflow_definition (code, name, description, entity_type) values
    ('transaction_member_deposit', 'Deposit from the member app',
     'A deposit a member reports from the app: the accounts department ' ||
     'checks the money reached the Society''s bank account, then records it.',
     'transaction')
on conflict (code) do nothing;

insert into workflow_step
    (definition_id, step_no, code, name, role_id, from_status, to_status)
select d.id, 1, 'accounts_verification', 'Accounts verification', r.id,
       'submitted', 'approved'
  from workflow_definition d
  join role r on r.code = 'account_officer'
 where d.code = 'transaction_member_deposit'
   and not exists (select 1 from workflow_step s where s.definition_id = d.id);

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'transaction.approve'
 where r.code = 'account_officer'
on conflict do nothing;

-- Sort order 1, ahead of the defaults' 10 and 20: the first match wins,
-- and these match only the Member role. Skipped for a kind an
-- administrator has already written a Member rule for.
insert into approval_rule
    (kind, initiating_role_id, amount_from, amount_to, workflow_definition_id,
     sort_order, note)
select k.kind, ro.id, 0, null, d.id, 1, k.note
  from (values
    ('deposit',    'transaction_member_deposit',
     'From the member app: verified by the accounts department'),
    ('withdrawal', 'transaction_withdrawal',
     'From the member app: Secretary, President, then the Treasurer disburses'),
    ('transfer',   'transaction_transfer',
     'From the member app: Secretary, President, then recorded')
  ) as k(kind, workflow_code, note)
  join workflow_definition d on d.code = k.workflow_code
  join role ro on ro.code = 'member'
 where not exists (
   select 1 from approval_rule a
    where a.kind = k.kind and a.initiating_role_id = ro.id
 );

-- What the member is told when one is refused (push only: the outcome of a
-- request made from the phone belongs on the phone). The withdrawal's
-- email and WhatsApp wording already exist (0081); a refused deposit or
-- transfer is new to the vocabulary.
insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('withdrawal.rejected', 'push',
     'Withdrawal not approved',
     'Your withdrawal of Rs {{amount}} from {{account}} was not approved. {{comment}}',
     'Sent to the member''s phone when a withdrawal is refused.'),
    ('deposit.rejected', 'push',
     'Deposit not accepted',
     'Your deposit of Rs {{amount}} to {{account}} could not be verified. {{comment}}',
     'Sent to the member''s phone when a deposit is refused.'),
    ('transfer.rejected', 'push',
     'Transfer not approved',
     'Your transfer of Rs {{amount}} from {{account}} was not approved. {{comment}}',
     'Sent to the member''s phone when a transfer is refused.')
on conflict (event_code, channel) do nothing;
