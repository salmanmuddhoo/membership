-- What WhatsApp actually requires to deliver a message (S-903).
--
-- 0053 modelled a WhatsApp notification as free text, the same as an email
-- body without a subject. That is not how the WhatsApp Business Platform
-- works, and a Society that configured a real provider would have found every
-- approval message rejected.
--
-- WhatsApp distinguishes two kinds of message:
--
--   Inside a 24-hour window opened by the member writing to the Society
--   first, free text is allowed.
--
--   Outside it — a business-initiated message, which every notification here
--   is, since nobody writes to us to ask whether their application was
--   approved — only a PRE-APPROVED TEMPLATE may be sent. Meta reviews the
--   wording in advance; the API then takes the template's name and the values
--   for its positional {{1}}, {{2}} slots, not a finished sentence.
--
-- So a WhatsApp template row needs to name the template Meta approved, and
-- the send needs the values rather than the rendered text. Two additions:
--
--   notification_template.provider_template_name — what the same wording is
--   called in the provider's own console. Nullable: the generic HTTP gateway
--   (a reseller that wraps this, or an internal relay) takes finished text and
--   needs no such name, and email never does.
--
--   notification.provider_parameters — the values that filled the body, in
--   the order their placeholders first appear in it. Stored per notification
--   rather than recomputed at send time for the same reason the rendered body
--   is: a retry must send what the first attempt would have sent, even if an
--   administrator has edited the wording since.
--
-- The rendered body stays exactly as it was. It remains the record of what
-- the member was told, and its placeholder order is what defines the
-- parameter order — so the Nth placeholder an administrator writes here is
-- {{N}} in the provider's template, which is the correspondence the editing
-- screen shows them.

alter table notification_template
    add column provider_template_name text,
    -- The language Meta registered the template under. Templates are approved
    -- per language, so this is part of naming one, not a display preference.
    add column provider_template_language text not null default 'en';

alter table notification
    -- jsonb array of strings. Null for a channel that sends finished text,
    -- which is every email and every gateway send.
    add column provider_parameters jsonb;

comment on column notification_template.provider_template_name is
    'The name this wording is registered under with the provider, for a '
    'channel that sends approved templates rather than finished text.';

comment on column notification.provider_parameters is
    'The values that filled the body, in placeholder order — what was sent '
    'as the provider template''s {{1}}, {{2}}, ... Null where not applicable.';

-- Name the two WhatsApp templates the Society has to register with Meta. These
-- are a starting point an administrator edits to match whatever the templates
-- ended up being called on approval, not a claim that they already exist —
-- the channel refuses to send, visibly, until the name matches something real.
set local albarakah.actor_description =
    'migration 0057_whatsapp_provider_templates';

update notification_template
   set provider_template_name = 'membership_approved'
 where event_code = 'application.approved' and channel = 'whatsapp';

update notification_template
   set provider_template_name = 'account_approved'
 where event_code = 'account.approved' and channel = 'whatsapp';
