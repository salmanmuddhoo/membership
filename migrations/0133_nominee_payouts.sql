-- A death claim paid to the nominees, split by nominee (officer request,
-- 26 November 2026).
--
-- An account opened for an existing holder can name a nominee of its own
-- (application_party on the additional-account application; nothing new in
-- the schema). When a claim pays "the nominee", each nominee is paid what
-- their accounts hold, one cheque each, the Takaful benefit with the
-- founding nominee (src/lib/ledger/nominee-payouts.ts). What was paid to
-- whom is kept on the transaction as it is disbursed:
-- [{name, nic, relation, accounts: [account no], amount, method_reference}].
-- Null for every transaction paid in one.
set local albarakah.actor_description = 'migration 0133_nominee_payouts';

alter table transaction add column payouts jsonb;

comment on column transaction.payouts is
    'A claim paid to more than one nominee: who received what, and the '
    'reference of each payment. Null when paid in one.';
