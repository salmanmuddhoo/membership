-- A receipt by email or WhatsApp (S-1602, RCT-US-002, NOTIF-US-005, FRD 6.8,
-- open point 6).
--
-- The wording the member receives when a transaction's receipt is issued:
-- one template per channel, the Society's to edit at Configuration →
-- Notification wording, and {{link}} is a signed, expiring address that
-- opens the receipt without a sign-in (src/lib/ledger/receipt-links.ts).
-- The event is raised by the ledger whenever a receipt is issued, and again
-- when an officer re-sends it from the receipt.
set local albarakah.actor_description =
    'migration 0076_receipt_notifications';

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('receipt.issued', 'email',
     'Your receipt {{receipt_no}} from Al Barakah',
     E'Assalamoualaikoum {{member_name}},\n\n'
     || E'{{kind}} of Rs {{amount}} on account {{account}} — receipt '
     || E'{{receipt_no}} ({{reference}}).\n\n'
     || E'You can open your receipt here:\n{{link}}\n\n'
     || 'Al Barakah MCSL',
     'Sent when a transaction''s receipt is issued, and when an officer re-sends it.'),

    ('receipt.issued', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your Al Barakah receipt '
     '{{receipt_no}}: {{kind}} of Rs {{amount}} on account {{account}}. '
     'Open it here: {{link}}',
     'Sent when a transaction''s receipt is issued, and when an officer re-sends it.')
on conflict (event_code, channel) do nothing;
