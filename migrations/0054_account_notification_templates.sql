-- Wording for the account applications, not just the membership one (S-902).
--
-- Migration 0053 seeded templates under `application.*`, written for someone
-- joining the Society. Two of the three application kinds are not that:
--
--   S-613's additional_account application opens another account for someone
--   who is already a member. Welcoming them to Al Barakah and giving them a
--   member number they have carried for years reads as a system that does not
--   know who they are.
--
--   S-614's customer_account application opens an account for someone who is
--   not a member at all, and is not becoming one. Telling them their
--   membership has been approved would be plainly false.
--
-- So those two kinds notify under `account.*` instead (eventCodeFor in
-- src/lib/notifications/events.ts), and this is the wording for it. An event
-- with no template sends nothing at all, which is why these have to exist
-- before those applicants hear anything.
--
-- Same shape as 0053's: plain text, {{placeholders}}, the Society's to edit —
-- including the `||`, which is there because an E'' prefix is only legal on
-- the first literal of a newline-separated group (see 0053's own note).

set local albarakah.actor_description =
    'migration 0054_account_notification_templates';

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('account.submitted', 'email',
     'We have your account application, {{applicant_name}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     || 'We have received your account application ({{reference}}) and it '
     || 'is now with our team for review. We will write again once a '
     || E'decision is made.\n\n'
     || 'Al Barakah MCSL',
     'Sent when an account application is submitted for central processing.'),

    ('account.returned', 'email',
     'Your account application {{reference}} needs a correction',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     || E'Your account application ({{reference}}) needs one thing '
     || E'corrected:\n\n'
     || E'{{comment}}\n\n'
     || E'Please contact your regional officer to put it right.\n\n'
     || 'Al Barakah MCSL',
     'Sent when an account application is returned to the originating staff.'),

    -- No member number here: the applicant either already had one or is not a
    -- member at all. What they want to know is that the account is open.
    ('account.approved', 'email',
     'Your account is open, {{applicant_name}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     || 'Your account application ({{reference}}) has been approved and '
     || E'your account is now open.\n\n'
     || 'Al Barakah MCSL',
     'Sent when an account application is approved.'),

    ('account.rejected', 'email',
     'About your account application {{reference}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     || 'Your account application ({{reference}}) was not approved on this '
     || E'occasion.\n\n'
     || E'{{comment}}\n\n'
     || 'Al Barakah MCSL',
     'Sent when an account application is rejected.'),

    -- The WhatsApp counterpart of 0053's one message, for the same reason:
    -- approval is the news worth a message on the phone. No subject; the
    -- channel has no such field.
    ('account.approved', 'whatsapp', null,
     'Assalamoualaikoum {{applicant_name}}, your Al Barakah account '
     'application {{reference}} has been approved and your account is now '
     'open.',
     'Sent when an account application is approved.');
