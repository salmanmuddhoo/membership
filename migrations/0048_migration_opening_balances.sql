-- M7, second increment (docs/backlog.md): S-709's opening balances, and the
-- two gaps officer feedback found in the first increment — a migrated
-- member's own AB number preserved from the legacy register rather than
-- reassigned, and importing the same legacy code a second time to correct a
-- detail instead of being refused as a duplicate.
--
-- Only this file's own concern is schema: a migrated balance is written as
-- its own payment (payments.ts's recordMigrationOpeningBalances), and needs
-- a method distinguishable from one an officer actually took at the counter
-- (S-708) — 'migration', never offered on an officer's own payment form
-- (PAYMENT_METHODS in payments.ts), written only by the import.
set local albarakah.actor_description = 'migration 0048_migration_opening_balances';

alter table payment
    drop constraint payment_method_check;

alter table payment
    add constraint payment_method_check
    check (method in ('cash', 'cheque', 'bank_transfer', 'card', 'mobile',
                       'migration'));

comment on column payment.method is
    'How the money moved. ''migration'' is the one value an officer never '
    'chooses from their own form (PAYMENT_METHODS, payments.ts) — written '
    'only by the legacy import, marking an opening balance as what it is '
    'rather than a counter transaction nobody took (S-708).';

-- S-705's own acceptance criterion: "the member number sequence must be
-- advanced past anything the register already contains". migration 0005
-- grants albarakah_app usage and select on every sequence, which covers
-- reading member_number_seq's own current value — advancing it past an
-- imported AB number is a setval(), which needs update, the one sequence
-- privilege 0005 deliberately left out. Scoped to this one sequence rather
-- than widened for every sequence in the schema: nothing else the
-- application does ever needs to move a sequence by hand.
grant update on sequence member_number_seq to albarakah_app;
