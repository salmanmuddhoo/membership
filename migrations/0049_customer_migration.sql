-- M7 · Legacy migration, third increment (docs/backlog.md): not everyone in
-- the legacy register is a Member. Someone whose only legacy accounts are
-- HSA/Investment — never Shares, never the MSA — is not, and never was, one
-- (S-614's own member/customer distinction), and imports the same shape a
-- live customer_account application already produces: a bare `customer`
-- row, application_party for their captured details, and their account(s)
-- carrying their own legacy number, the same as account_owner_shape has
-- always required for a customer-owned account.
--
-- legacy_code mirrors member.legacy_code exactly (migration 0047) — same
-- purpose, same shape, the other half of S-705's own cross-reference now
-- that a migrated record is not always a member.
set local albarakah.actor_description = 'migration 0049_customer_migration';

alter table customer add column legacy_code text unique;

comment on column customer.legacy_code is
    'The code Al Barakah''s legacy register used for this customer, kept '
    'searchable as a cross-reference (S-705, extended to non-members). Null '
    'for a customer created the ordinary way, through a customer_account '
    'application.';
