-- What a member is told about their own transactions, and what staff are
-- told about work that waits on them (S-1803, S-1804, S-1805; NOTIF-US-001
-- to NOTIF-US-004; FRD 11.1, 11.2).
--
-- Member events, an email and a WhatsApp wording each, raised by the ledger
-- once a transaction has committed (src/lib/ledger/transaction-notifications.ts):
--
--   deposit.posted          the money is on the account
--   withdrawal.submitted    the request has reached its approval chain
--   withdrawal.under_review a reviewer forwarded it to a further step
--   withdrawal.disbursed    approved and paid out, with the receipt
--   withdrawal.rejected     refused, with the reason
--   transfer.posted         to the holder of each side that is an account
--                           here — one message when both sides are theirs
--   balance.near_floor      advisory: a posted debit left the account within
--                           balance.near_floor_margin of its type's floor
--
-- Staff events, email only — app_user has an email and nothing else:
--
--   transaction.awaiting    to every active holder of the step's role, when
--                           a transaction arrives at that step
--   transaction.returned    to the officer who captured it, with the
--                           reviewer's comment and a link
--   receipt.voided          to every active holder of receipt.void, with the
--                           reason and who voided it
--
-- The wording is the Society's to edit at Configuration -> Notification
-- wording; the margin sits beside the other amounts at Configuration ->
-- Fee schedules.
set local albarakah.actor_description = 'migration 0081_transaction_notifications';

insert into config_entry (key, value, value_type, description)
values
    ('balance.near_floor_margin', '500'::jsonb, 'number',
     'A posted debit that leaves an account within this amount (MUR) of ' ||
     'its type''s minimum balance sends the holder a balance.near_floor ' ||
     'advisory. 0 turns the advisory off.')
on conflict (key) do nothing;

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('deposit.posted', 'email',
     'Al Barakah: deposit of Rs {{amount}} received',
     E'Assalamoualaikoum {{member_name}},\n\nRs {{amount}} has been deposited to {{account}} ({{reference}}). The account now stands at Rs {{balance}}.\n\nAl Barakah MCSL',
     'Sent when a deposit is posted to the account.'),
    ('deposit.posted', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, Rs {{amount}} has been deposited to your {{account}} at Al Barakah ({{reference}}). Balance: Rs {{balance}}.',
     'Sent when a deposit is posted to the account.'),
    ('withdrawal.submitted', 'email',
     'Al Barakah: withdrawal request {{reference}} received',
     E'Assalamoualaikoum {{member_name}},\n\nYour withdrawal of Rs {{amount}} from {{account}} ({{reference}}) has been received. It will be reviewed and we will write to you when it is decided.\n\nAl Barakah MCSL',
     'Sent when a withdrawal reaches its approval chain.'),
    ('withdrawal.submitted', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, Al Barakah has received your withdrawal of Rs {{amount}} from {{account}} ({{reference}}). We will write to you when it is decided.',
     'Sent when a withdrawal reaches its approval chain.'),
    ('withdrawal.under_review', 'email',
     'Al Barakah: withdrawal request {{reference}} is under review',
     E'Assalamoualaikoum {{member_name}},\n\nYour withdrawal of Rs {{amount}} ({{reference}}) is now under review. {{comment}}\n\nAl Barakah MCSL',
     'Sent when a reviewer forwards it to the next step.'),
    ('withdrawal.under_review', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your withdrawal of Rs {{amount}} ({{reference}}) is under review at Al Barakah. {{comment}}',
     'Sent when a reviewer forwards it to the next step.'),
    ('withdrawal.disbursed', 'email',
     'Al Barakah: withdrawal {{reference}} paid out',
     E'Assalamoualaikoum {{member_name}},\n\nYour withdrawal of Rs {{amount}} from {{account}} ({{reference}}) has been paid out by {{method}} — receipt {{receipt_no}}. The account now stands at Rs {{balance}}.\n\nAl Barakah MCSL',
     'Sent when a withdrawal is paid out.'),
    ('withdrawal.disbursed', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your withdrawal of Rs {{amount}} from {{account}} ({{reference}}) has been paid out by {{method}}, receipt {{receipt_no}}. Balance: Rs {{balance}}. Al Barakah MCSL',
     'Sent when a withdrawal is paid out.'),
    ('withdrawal.rejected', 'email',
     'Al Barakah: withdrawal request {{reference}} not approved',
     E'Assalamoualaikoum {{member_name}},\n\nYour withdrawal of Rs {{amount}} ({{reference}}) was not approved. {{comment}}\n\nAl Barakah MCSL',
     'Sent when a withdrawal is rejected, with the reason.'),
    ('withdrawal.rejected', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your withdrawal of Rs {{amount}} ({{reference}}) was not approved by Al Barakah. {{comment}}',
     'Sent when a withdrawal is rejected, with the reason.'),
    ('transfer.posted', 'email',
     'Al Barakah: transfer {{reference}} completed',
     E'Assalamoualaikoum {{member_name}},\n\nA transfer of Rs {{amount}} from {{from_account}} to {{to_account}} ({{reference}}) has been completed. Your {{account}} now stands at Rs {{balance}}.\n\nAl Barakah MCSL',
     'Sent to each holder when a transfer is posted.'),
    ('transfer.posted', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, a transfer of Rs {{amount}} from {{from_account}} to {{to_account}} ({{reference}}) has been completed at Al Barakah. Your {{account}} balance: Rs {{balance}}.',
     'Sent to each holder when a transfer is posted.'),
    ('balance.near_floor', 'email',
     'Al Barakah: your {{account}} is close to its minimum balance',
     E'Assalamoualaikoum {{member_name}},\n\nAfter {{reference}}, your {{account}} stands at Rs {{balance}}. The minimum balance for this account is Rs {{floor}}.\n\nAl Barakah MCSL',
     'Sent when a debit leaves the account within the configured margin of its floor.'),
    ('balance.near_floor', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, after {{reference}} your {{account}} at Al Barakah stands at Rs {{balance}}. The minimum balance for this account is Rs {{floor}}.',
     'Sent when a debit leaves the account within the configured margin of its floor.'),
    ('transaction.awaiting', 'email',
     'Awaiting you: {{kind}} {{reference}} — {{step}}',
     E'{{recipient_name}},\n\n{{kind}} {{reference}} for {{member_name}} — Rs {{amount}} on {{account}}, captured by {{captured_by}} — is waiting at {{step}}.\n\n{{link}}',
     'Sent to every holder of the step''s role when a transaction arrives at that step.'),
    ('transaction.returned', 'email',
     'Returned to you: {{kind}} {{reference}}',
     E'{{recipient_name}},\n\n{{kind}} {{reference}} for {{member_name}} — Rs {{amount}} on {{account}} — was returned by {{returned_by}}: {{comment}}\n\n{{link}}',
     'Sent to the officer who captured a transaction when a reviewer returns it.'),
    ('receipt.voided', 'email',
     'Receipt {{receipt_no}} voided',
     E'{{recipient_name}},\n\nReceipt {{receipt_no}} ({{kind}} {{reference}}, Rs {{amount}} for {{member_name}}) was voided by {{voided_by}}: {{reason}}\n\n{{link}}',
     'Sent to every holder of receipt.void when a receipt is voided.')
on conflict do nothing;
