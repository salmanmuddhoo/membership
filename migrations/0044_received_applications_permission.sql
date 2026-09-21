-- Officer feedback: every regional officer who can submit a captured
-- application at all (application.submit, seeded to regional_officer by
-- migration 0011) could already see and pick up every application received
-- from the mobile app (RECEIVED_STATUS, migration 0039) — a shared queue
-- with no gate of its own. The business wants online applications handled
-- by specific staff, not the whole branch.
--
-- application.submit_online is that gate — a second permission a role needs
-- alongside application.submit before an application 'received' from the
-- phone shows up for them at all, in the Applications list, the nav badge,
-- or by direct URL. Nobody has it yet: assigning it to a role (regional_
-- officer itself, or a role made just for this) is a decision the business
-- makes in Configuration → Roles, not one this migration makes for them.
set local albarakah.actor_description = 'migration 0044_received_applications_permission';

insert into permission (code, description) values
    ('application.submit_online',
     'Handle an application submitted through the mobile app')
on conflict (code) do nothing;
