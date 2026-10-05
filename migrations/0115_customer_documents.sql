-- A non-member's own documents (officer request): an identity card or a
-- utility bill filed for a customer from their Documents page, outside any
-- application, and carried onto the next application that asks for it — as
-- a member's already are (document.member_id, 0013).
--
-- A document still belongs to exactly one owner: an application, a member,
-- a customer or a transaction.
set local albarakah.actor_description = 'migration 0115_customer_documents';

alter table document
    add column customer_id uuid references customer(id),
    drop constraint document_belongs_to_exactly_one,
    add constraint document_belongs_to_exactly_one
        check (num_nonnulls(application_id, member_id, customer_id,
                            transaction_id) = 1);

-- One per (customer, type, subject): a second identity card is a
-- replacement, a new version of the same document.
create unique index document_unique_for_customer_idx
    on document (customer_id, document_type_id, subject)
    where customer_id is not null;

comment on column document.customer_id is
    'A document filed for a non-member customer outside any application '
    '(their Documents page). Filed in the folder of the application the '
    'customer came from; carried onto their later applications.';
