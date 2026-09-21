-- The first transaction an officer records: a deposit (S-1305, S-1306,
-- S-1308; FRD 6.2, 6.7, 3, 16).
--
-- The engine (0064) and the account types' rules (0065) exist; this is what
-- the capture path itself needs from the schema, which is little:
--
--   * The officer's confirmation that the Source of Fund form was completed
--     for a cash deposit above the threshold — the same column, with the
--     same meaning, that payment has carried since 0034. The controls are one
--     set, read from the same three configuration entries (S-1306).
--   * A fingerprint of what the transaction was for, beside the idempotency
--     key 0064 already has: the same key with the same payload is the same
--     transaction and is answered with it; the same key with a different
--     payload is a conflict and writes nothing (S-1308).
--   * Who may record one.
set local albarakah.actor_description = 'migration 0068_deposits';

alter table transaction
    add column source_of_fund_form_confirmed boolean not null default false,
    add column idempotency_fingerprint text,
    add constraint transaction_idempotency_is_complete
        check ((idempotency_key is null) = (idempotency_fingerprint is null));

comment on column transaction.idempotency_fingerprint is
    'A hash of what the caller asked for, stored with the key so a retry '
    'that repeats the request is answered with this row and one that '
    'changes it is refused (S-1308).';

-- Recording a deposit is the counter officer's act, as recording a payment
-- is (0017): whoever holds payment.record today holds this from the same
-- migration, so the officer who took the joining money takes the next
-- deposit without an administrator's visit. The rest of the transaction
-- permissions — viewing, posting through a chain, voiding a receipt — are
-- S-1311's, with the segregation rules that go with them.
insert into permission (code, description) values
    ('transaction.capture', 'Record a deposit and issue its receipt')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id and held.code = 'payment.record'
  join permission p on p.code = 'transaction.capture'
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'transaction.capture'
 where r.code = 'system_administrator'
on conflict do nothing;
