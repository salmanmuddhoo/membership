-- Notifications (S-901, decision 11).
--
-- The Society will change notification provider at least once — an email
-- relay now, WhatsApp through whichever business API is cheapest later. So
-- nothing here names a provider. A template says what to send and a channel
-- says how; the provider that actually carries it is chosen at runtime and
-- is not recorded in the schema at all.
--
-- Two tables, deliberately different in kind:
--
--   notification_template is configuration. An administrator edits it, it
--   changes rarely, and every change is attributable — so it carries the
--   same history trigger as every other configuration table (migration
--   0010's record_configuration_change), which means a write outside
--   withConfigurationActor fails rather than arriving anonymously.
--
--   notification is operational. One row per intended send, written by the
--   application as things happen, never edited by an administrator. It needs
--   no actor because the event itself is the actor.
--
-- The rendered subject and body are stored on the notification row rather
-- than resolved from the template when sending. Editing a template must not
-- rewrite what was already sent: the outbox is a record of what went out,
-- not a view over current configuration.

create table notification_template (
    id          uuid        primary key default gen_random_uuid(),

    -- What happened, in the same dotted form the audit trail uses, e.g.
    -- 'application.approved'.
    event_code  text        not null,

    channel     text        not null
        check (channel in ('email', 'whatsapp')),

    -- Email needs one; WhatsApp has no such field, and storing an unused
    -- subject on it would invite someone to write one that never appears.
    subject     text,

    -- Both carry {{placeholders}} filled in from the event's own values.
    body        text        not null,

    is_active   boolean     not null default true,
    description text        not null,

    updated_at  timestamptz not null default now(),
    updated_by  uuid        references app_user(id),

    -- One template per event per channel: an event that should reach someone
    -- two ways has two rows, not one row that tries to be both.
    unique (event_code, channel),

    constraint notification_template_email_has_subject
        check (channel <> 'email' or subject is not null)
);

create trigger notification_template_set_updated_at
    before update on notification_template
    for each row execute function set_updated_at();

create trigger notification_template_audit
    after insert or update or delete on notification_template
    for each row execute function record_configuration_change();

-- The outbox. A send is recorded before it is attempted, so a crash between
-- deciding to notify and actually notifying leaves evidence rather than
-- silence.
create table notification (
    id           uuid        primary key default gen_random_uuid(),

    event_code   text        not null,
    channel      text        not null
        check (channel in ('email', 'whatsapp')),

    -- Which template produced the text below. Null once a template is
    -- deleted; the rendered copy survives either way, which is the point.
    template_id  uuid        references notification_template(id)
                             on delete set null,

    -- Email address or international-form number, per channel. Not a foreign
    -- key to member: a notification may go to an applicant who is not yet one.
    recipient    text        not null,

    subject      text,
    body         text        not null,

    status       text        not null default 'pending'
        check (status in ('pending', 'sent', 'failed', 'abandoned')),

    -- Counted so a repeatedly failing send can be told from a new one. The
    -- retry schedule itself is S-904's.
    attempts     integer     not null default 0,
    last_error   text,

    -- What this was about, so a member's page can show what they were told.
    -- Text rather than uuid for the same reason audit_event's is.
    entity_type  text,
    entity_id    text,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    sent_at      timestamptz
);

create trigger notification_set_updated_at
    before update on notification
    for each row execute function set_updated_at();

-- The sender asks one question — what is still waiting — and asks it often.
create index notification_pending_idx
    on notification (status, created_at)
    where status in ('pending', 'failed');

create index notification_entity_idx
    on notification (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- A starter set, so the feature is configuration rather than an empty table.
-- Wording is the Society's to edit; these exist to be edited, not to be the
-- final text. The migration names itself as the actor for the same reason
-- migration 0010 does.
set local albarakah.actor_description = 'migration 0053_notifications';

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('application.submitted', 'email',
     'We have your application, {{applicant_name}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     'We have received your application ({{reference}}) and it is now with '
     E'our team for review. We will write again once a decision is made.\n\n'
     'Al Barakah MCSL',
     'Sent when an application is submitted for central processing.'),

    ('application.returned', 'email',
     'Your application {{reference}} needs a correction',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     E'Your application ({{reference}}) needs one thing corrected:\n\n'
     E'{{comment}}\n\n'
     E'Please contact your regional officer to put it right.\n\n'
     'Al Barakah MCSL',
     'Sent when an application is returned to the originating staff.'),

    ('application.approved', 'email',
     'Welcome to Al Barakah, {{applicant_name}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     'Your membership has been approved. Your member number is '
     E'{{member_no}}.\n\n'
     'Al Barakah MCSL',
     'Sent when a membership application is approved.'),

    ('application.rejected', 'email',
     'About your application {{reference}}',
     E'Assalamoualaikoum {{applicant_name}},\n\n'
     E'Your application ({{reference}}) was not approved on this occasion.\n\n'
     E'{{comment}}\n\n'
     'Al Barakah MCSL',
     'Sent when a membership application is rejected.'),

    -- The one WhatsApp template the Society asked for first. No subject:
    -- the channel has no such field.
    ('application.approved', 'whatsapp', null,
     'Assalamoualaikoum {{applicant_name}}, your Al Barakah membership has '
     'been approved. Your member number is {{member_no}}.',
     'Sent when a membership application is approved.');

comment on table notification_template is
    'What to send for an event, per channel. Configuration: edited by an '
    'administrator, audited by trigger.';

comment on table notification is
    'One row per intended send, with the text as it was rendered at the '
    'time. Operational, not configuration.';
