-- A membership fee receipt to the person who paid (officer request).
--
-- When an application's fees are recorded, the receipt the officer prints is
-- now also sent to the applicant — or to the guardian's or contact person's
-- address where the applicant has none — as its PDF: an email attachment and
-- the WhatsApp template's document header, never a link (0124 made the same
-- choice for a transaction's receipt). The wording is the Society's to edit
-- at Configuration → Notification wording.
--
-- WhatsApp: register a template in the Meta console with a document header
-- and these body variables in order — member_name, amount, items,
-- receipt_no — and enter its name against this wording, or Meta refuses the
-- message. Email needs nothing further.
set local albarakah.actor_description =
    'migration 0125_fee_receipt_notifications';

insert into notification_template
    (event_code, channel, subject, body, description, attaches_document)
values
    ('fee_receipt.issued', 'email',
     'Your receipt {{receipt_no}} from Al Barakah',
     E'Assalamoualaikoum {{member_name}},\n\n'
     || E'Thank you for your payment of Rs {{amount}} ({{items}}) for '
     || E'application {{reference}} — receipt {{receipt_no}}.\n\n'
     || E'Your receipt is attached.\n\n'
     || 'Al Barakah MCSL',
     'Sent when an application''s fees are recorded, with the receipt as a PDF.',
     true),

    ('fee_receipt.issued', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, thank you for your payment of '
     'Rs {{amount}} to Al Barakah ({{items}}). Your receipt {{receipt_no}} '
     'is attached.',
     'Sent when an application''s fees are recorded, with the receipt as a PDF.',
     true)
on conflict (event_code, channel) do nothing;
