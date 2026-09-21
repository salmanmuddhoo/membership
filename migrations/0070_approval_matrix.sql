-- The approval matrix, on the chain that already exists (M14: S-1401,
-- S-1402, S-1406; FRD 6.5, 9, 17).
--
-- Phase 1's workflow_definition and workflow_step do everything a chain
-- needs — steps assigned to roles, an order, is_enabled, a quorum, and
-- activeChain() reading it live (S-209, S-611). What they lack is the
-- MATRIX: which chain, or none, a given transaction falls under. That is
-- one table (approval_rule) and one function in the service (resolveRoute),
-- plus the status vocabulary and the chains that let the existing steps
-- name a transaction's states, and a transition log for the trail.
--
-- The threshold. FRD 9 wants it configurable; here it is the band on the
-- rule, edited on Configuration -> Approval matrix like the rest of the
-- matrix rather than a second number somewhere else that the rule would
-- have to be kept in step with. The 100,000 the defaults are seeded with
-- is a placeholder for the Society to confirm (open point 15).
set local albarakah.actor_description = 'migration 0070_approval_matrix';

-- ---------------------------------------------------------------------------
-- The transaction's status vocabulary, as configuration (S-1402)
-- ---------------------------------------------------------------------------
-- The same codes 0064's check constraint names, so a workflow_step can say
-- `submitted -> under_review` about a transaction exactly as it says
-- `new -> submitted_for_approval` about an application.
insert into workflow_status
    (entity_type, code, name, description, is_terminal, is_active, sort_order)
values
    ('transaction', 'draft',        'Draft',        'Being captured; nothing has moved.',                       false, true, 0),
    ('transaction', 'submitted',    'Submitted',    'Waiting at the first step of its chain, or posted at once.', false, true, 1),
    ('transaction', 'under_review', 'Under review', 'Reviewed; waiting for the decision.',                      false, true, 2),
    ('transaction', 'approved',     'Approved',     'Decided; waiting to be posted.',                           false, true, 3),
    ('transaction', 'posted',       'Posted',       'On the ledger.',                                           true,  true, 4),
    ('transaction', 'returned',     'Returned',     'Sent back to the officer who captured it, with a comment.', false, true, 5),
    ('transaction', 'rejected',     'Rejected',     'Refused, with a comment.',                                 true,  true, 6),
    ('transaction', 'cancelled',    'Cancelled',    'Withdrawn before it posted.',                              true,  true, 7)
on conflict (entity_type, code) do nothing;

-- ---------------------------------------------------------------------------
-- A chain per kind (S-1402): Secretary -> President, FRD 6.5's default
-- ---------------------------------------------------------------------------
-- The same two steps for every kind, seeded separately per kind so an
-- administrator can add a Regional Manager step to withdrawals alone, or
-- disable the Secretary on closures, on Configuration -> Workflows — which
-- edits these with no new screen.
insert into workflow_definition (code, name, description, entity_type) values
    ('transaction_deposit',     'Deposit approval',
     'A deposit above the matrix threshold.', 'transaction'),
    ('transaction_withdrawal',  'Withdrawal approval',
     'A withdrawal above the matrix threshold.', 'transaction'),
    ('transaction_transfer',    'Transfer approval',
     'A transfer out above the matrix threshold.', 'transaction'),
    ('transaction_closure',     'Account closure approval',
     'Closing an HSA or Investment account.', 'transaction'),
    ('transaction_resignation', 'Resignation approval',
     'A member leaving the Society.', 'transaction'),
    ('transaction_demise',      'Demised member claim approval',
     'Settling a deceased member''s accounts.', 'transaction')
on conflict (code) do nothing;

insert into workflow_step
    (definition_id, step_no, code, name, role_id, from_status, to_status)
select d.id, s.step_no, s.code, s.name, r.id, s.from_status, s.to_status
  from workflow_definition d
  cross join (values
    (1, 'secretary_review',   'Secretary review',   'secretary', 'submitted',    'under_review'),
    (2, 'president_decision', 'President decision', 'president', 'under_review', 'approved')
  ) as s(step_no, code, name, role_code, from_status, to_status)
  join role r on r.code = s.role_code
 where d.entity_type = 'transaction'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- The matrix (S-1401)
-- ---------------------------------------------------------------------------
-- Ordered; the first match wins. A rule that names no chain means "post
-- immediately". account_type_id and initiating_role_id narrow a rule; null
-- means any. The band is inclusive at both ends, so "up to 100,000" and
-- "100,000.01 and above" read on the screen the way an administrator would
-- write them.
create table approval_rule (
    id                     uuid        primary key default gen_random_uuid(),
    kind                   text        not null
                           check (kind in ('deposit', 'withdrawal', 'transfer',
                                           'closure', 'resignation', 'demise')),
    account_type_id        uuid        references account_type(id),
    initiating_role_id     uuid        references role(id),
    amount_from            numeric(14, 2) not null default 0
                           check (amount_from >= 0),
    amount_to              numeric(14, 2)
                           check (amount_to is null or amount_to >= amount_from),
    workflow_definition_id uuid        references workflow_definition(id),
    note                   text        not null default '',
    sort_order             integer     not null default 0,
    is_active              boolean     not null default true,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create index approval_rule_kind_idx on approval_rule (kind, sort_order);

create trigger approval_rule_set_updated_at
    before update on approval_rule
    for each row execute function set_updated_at();

create trigger approval_rule_audit
    after insert or update or delete on approval_rule
    for each row execute function record_configuration_change();

-- FRD 6.5's table: deposits, withdrawals and transfers post up to the
-- threshold and go Secretary -> President above it; closures, resignations
-- and demised claims always go Secretary -> President.
insert into approval_rule
    (kind, amount_from, amount_to, workflow_definition_id, sort_order, note)
select k.kind, k.amount_from, k.amount_to,
       case when k.chain then d.id end, k.sort_order, k.note
  from (values
    ('deposit',     0::numeric,         100000::numeric, false, 10, 'Posts at once'),
    ('deposit',     100000.01::numeric, null::numeric,   true,  20, 'Above the threshold'),
    ('withdrawal',  0::numeric,         100000::numeric, false, 10, 'Posts at once'),
    ('withdrawal',  100000.01::numeric, null::numeric,   true,  20, 'Above the threshold'),
    ('transfer',    0::numeric,         100000::numeric, false, 10, 'Posts at once'),
    ('transfer',    100000.01::numeric, null::numeric,   true,  20, 'Above the threshold'),
    ('closure',     0::numeric,         null::numeric,   true,  10, 'Always reviewed'),
    ('resignation', 0::numeric,         null::numeric,   true,  10, 'Always reviewed'),
    ('demise',      0::numeric,         null::numeric,   true,  10, 'Always reviewed')
  ) as k(kind, amount_from, amount_to, chain, sort_order, note)
  left join workflow_definition d on d.code = 'transaction_' || k.kind
 where not exists (select 1 from approval_rule);

-- ---------------------------------------------------------------------------
-- Where a transaction is on its chain
-- ---------------------------------------------------------------------------
alter table transaction
    add column approval_rule_id        uuid references approval_rule(id),
    add column workflow_definition_id  uuid references workflow_definition(id),
    -- The step it is waiting at, by code; null once nothing is waiting.
    add column current_step_code       text,
    add column submitted_at            timestamptz;

comment on column transaction.approval_rule_id is
    'The matrix rule that routed it (S-1401), so the trail can say why it '
    'went where it went. Null for a transaction that predates the matrix.';

-- ---------------------------------------------------------------------------
-- The trail (S-1406): application_transition's shape, plus what routed it
-- ---------------------------------------------------------------------------
create table transaction_transition (
    id                     bigserial   primary key,
    transaction_id         uuid        not null references transaction(id) on delete cascade,

    from_status            text,
    to_status              text        not null,
    step_code              text,

    actor_user_id          uuid        not null references app_user(id),
    actor_role             text,
    comment                text,

    approval_rule_id       uuid        references approval_rule(id),
    workflow_definition_id uuid        references workflow_definition(id),

    occurred_at            timestamptz not null default now()
);

create index transaction_transition_chain_idx
    on transaction_transition (transaction_id, occurred_at);

-- Append-only, honouring the test-data reset's flag (0019) so a reset that
-- truncates transaction reaches this through the cascade.
create or replace function reject_transaction_transition_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return null;
    end if;
    raise exception
        'transaction_transition is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

-- Row-level for update and delete, so deleting a draft transaction that has
-- no transitions yet cascades through without tripping it.
create trigger transaction_transition_append_only
    before update or delete on transaction_transition
    for each row execute function reject_transaction_transition_mutation();

create trigger transaction_transition_no_truncate
    before truncate on transaction_transition
    for each statement execute function reject_transaction_transition_mutation();

revoke update, delete on transaction_transition from albarakah_app;
