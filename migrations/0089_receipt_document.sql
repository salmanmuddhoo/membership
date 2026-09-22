-- A receipt as a document (S-1602's Should half; Phase 2 open point 6).
--
-- The receipt.issued message has carried a link since 0076. Now the receipt
-- itself can travel with it: a PDF of the sheet, served on the same signed
-- link with .pdf on the end, sent as the WhatsApp template's document
-- header and as an email attachment. Whether it does is the wording's own
-- switch, because a WhatsApp template only takes a document if it was
-- registered with a document header — Meta refuses the message otherwise —
-- so the Society turns it on once its template is. Off by default: what
-- was sent before this migration is what is sent after it.
set local albarakah.actor_description = 'migration 0089_receipt_document';

alter table notification_template
    add column attaches_document boolean not null default false;

comment on column notification_template.attaches_document is
    'Whether this wording carries the event''s document (a receipt''s PDF) '
    'as well as its text: a WhatsApp template registered with a document '
    'header, or an email with an attachment. Off unless the Society says so.';

alter table notification
    -- What was attached, as the address it was fetched from and the name it
    -- was given. The address is a signed, expiring link like the one in the
    -- body, so a retry days later fetches the same document the first
    -- attempt would have. Null where nothing was attached.
    add column attachment_url  text,
    add column attachment_name text,
    add column attachment_type text;

comment on column notification.attachment_url is
    'Where the attached document is fetched from at send time; null where '
    'nothing was attached.';
