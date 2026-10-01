-- Transaction receipts on the one sequence (S-1601, S-1603, FRD 6.8).
--
-- Every transaction has taken its receipt from receipt_number since 0068,
-- issued when it posts, so the sequence already means the same thing
-- everywhere. What arrives here is the rest of a receipt's life for a
-- transaction: a print is recorded against it (receipt_print, 0017, which
-- only knew a payment), and its void is an event on the stream.
set local albarakah.actor_description = 'migration 0075_transaction_receipts';

alter table receipt_print
    alter column payment_id drop not null,
    add column transaction_id uuid references transaction(id) on delete restrict,
    add constraint receipt_print_has_one_subject
        check (num_nonnulls(payment_id, transaction_id) = 1);

create index receipt_print_transaction_idx
    on receipt_print (transaction_id, printed_at)
    where transaction_id is not null;

alter table financial_event
    drop constraint financial_event_event_type_check,
    add constraint financial_event_event_type_check check (event_type in (
        'payment.recorded', 'payment.refunded', 'payment.voided',
        'transaction.posted', 'transaction.voided'
    ));
