-- S-614: a non-member's own account(s) move with them when they become a
-- member (startMembershipApplicationFromCustomer, capture.ts, phase 5).
--
-- Officer feedback: someone who already holds an HSA or Investment account
-- as a customer should not end up owning it twice over once they are a
-- member — the account they already have is the one that becomes theirs
-- as a member, not a second one alongside it. Named here, on the
-- application itself, so createMemberFromApplication (members/create.ts)
-- knows at approval time whether there is something to transfer, and
-- which customer it came from, without going back to the audit trail to
-- find out.
--
-- Schema only: nothing here transfers anything by itself. This column is
-- null on every application that predates it, and stays null on every
-- ordinary membership application going forward — set only by
-- startMembershipApplicationFromCustomer.
alter table membership_application
    add column source_customer_id uuid references customer(id);

alter table membership_application
    add constraint membership_application_source_customer_shape check (
        source_customer_id is null or application_kind = 'membership'
    );

comment on column membership_application.source_customer_id is
    'Set only when this application was started from an existing '
    'non-member customer (startMembershipApplicationFromCustomer) -- names '
    'whose account(s) transfer to the new Member on approval '
    '(createMemberFromApplication). Null for every ordinary application.';
