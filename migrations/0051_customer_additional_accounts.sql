-- Officer feedback: a customer (someone who holds an account but is not a
-- member — S-614) could not open a further account of their own. The button
-- on their page only offered "Apply to become a member"; there was no way to,
-- say, add an Investment account beside the HSA they already hold without
-- becoming a member.
--
-- The additional_account kind (S-612) already does exactly this for members —
-- it just had nowhere to record that the owner is a customer, not a member.
-- This adds that: existing_customer_id, the customer counterpart of
-- existing_member_id, with the kind-shape check widened so an
-- additional_account names exactly one owner — a member or a customer, never
-- both, never neither. Everything else the flow needs (capture-free applicant
-- details, the signed form, documents, payment, the review chain, and opening
-- the account under the owner on approval) is application code, the same as
-- every earlier phase of this feature.
set local albarakah.actor_description =
    'migration 0051_customer_additional_accounts';

alter table membership_application
    add column existing_customer_id uuid references customer(id);

comment on column membership_application.existing_customer_id is
    'Set only when application_kind = ''additional_account'' and the account '
    'is being opened for an existing customer (S-614 follow-up) rather than a '
    'member. Exactly one of existing_member_id / existing_customer_id is set '
    '(membership_application_kind_shape).';

create index membership_application_existing_customer_idx
    on membership_application (existing_customer_id)
    where existing_customer_id is not null;

-- Widen the kind-shape check (migration 0027) so additional_account admits a
-- customer owner. The other two kinds are unchanged, now also asserting
-- existing_customer_id is null so the column can only ever be set on the one
-- kind that means it.
alter table membership_application
    drop constraint membership_application_kind_shape;

alter table membership_application
    add constraint membership_application_kind_shape check (
        (application_kind = 'membership'
            and membership_type_id is not null
            and existing_member_id is null
            and existing_customer_id is null)
        or
        (application_kind = 'additional_account'
            and membership_type_id is null
            -- Exactly one owner: a member or a customer, never both, never
            -- neither.
            and (existing_member_id is not null)
                <> (existing_customer_id is not null))
        or
        (application_kind = 'customer_account'
            and membership_type_id is not null
            and existing_member_id is null
            and existing_customer_id is null)
    );
