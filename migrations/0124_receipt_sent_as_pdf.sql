-- A receipt goes out as its PDF, never as a link (officer request).
--
-- Since 0076 the receipt.issued message carried {{link}}, a signed address
-- that opened the receipt in a browser, and since 0089 it could also carry
-- the PDF where the wording's switch said so. The Society wants the
-- document itself and no address: the PDF as an email attachment and as the
-- WhatsApp template's document header, every time.
--
-- The wording no longer has a {{link}} to fill (event-codes.ts), so any
-- receipt wording still using it is replaced with the new default, and the
-- switch is set on for both channels (the code attaches the receipt
-- whatever it says; this keeps the stored wording honest).
--
-- WhatsApp: the template approved in the Meta console must now have a
-- document header and no variable for the link, or Meta refuses the
-- message. Its body variables follow the placeholders below in order:
-- member_name, receipt_no, kind, amount, account.
set local albarakah.actor_description = 'migration 0124_receipt_sent_as_pdf';

update notification_template
   set body = E'Assalamoualaikoum {{member_name}},\n\n'
           || E'{{kind}} of Rs {{amount}} on account {{account}} — receipt '
           || E'{{receipt_no}} ({{reference}}).\n\n'
           || E'Your receipt is attached.\n\n'
           || 'Al Barakah MCSL'
 where event_code = 'receipt.issued'
   and channel = 'email'
   and body like '%{{link}}%';

update notification_template
   set body = 'Assalamoualaikoum {{member_name}}, your Al Barakah receipt '
           || '{{receipt_no}}: {{kind}} of Rs {{amount}} on account '
           || '{{account}}. Your receipt is attached.'
 where event_code = 'receipt.issued'
   and channel = 'whatsapp'
   and body like '%{{link}}%';

update notification_template
   set attaches_document = true
 where event_code = 'receipt.issued'
   and attaches_document = false;
