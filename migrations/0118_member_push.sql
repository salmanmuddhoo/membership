-- Push notifications to the member app (docs/notifications.md, "Push").
--
-- A third channel beside email and WhatsApp: the same templates, the same
-- outbox, the same retry — delivered to the phones a member has signed in
-- on, through Firebase Cloud Messaging. What a member is told about their
-- money (deposit.posted, withdrawal.disbursed, transfer.posted) reaches the
-- phone the moment it posts; a new partner outlet or a new promotion on
-- the home screen is announced to everyone signed in.
--
-- The recipient of a push row is not an address but who it is for:
-- 'member:<id>', 'customer:<id>' or 'everyone'. The phones behind that are
-- member_device rows, resolved at send time, so a phone registered after
-- the row was written still hears a retry.
set local albarakah.actor_description = 'migration 0118_member_push';

-- ---------------------------------------------------------------------------
-- The channel
-- ---------------------------------------------------------------------------
alter table notification_template
    drop constraint notification_template_channel_check;
alter table notification_template
    add constraint notification_template_channel_check
        check (channel in ('email', 'whatsapp', 'push'));

alter table notification
    drop constraint notification_channel_check;
alter table notification
    add constraint notification_channel_check
        check (channel in ('email', 'whatsapp', 'push'));

-- ---------------------------------------------------------------------------
-- The phones
-- ---------------------------------------------------------------------------
-- One row per push token. A token is Firebase's name for one app install
-- on one phone; it can only receive, and it is tied to the session that
-- registered it, so revoking the session (sign-out, a branch revoking a
-- lost phone, a member who has left) silences the phone with it. The
-- holder is copied from the session so the fan-out for a member's own
-- events is one indexed read.
create table member_device (
    id              uuid        primary key default gen_random_uuid(),
    session_id      uuid        not null references member_session(id),
    member_id       uuid        references member(id),
    customer_id     uuid        references customer(id),
    platform        text        not null check (platform in ('android', 'ios')),
    token           text        not null unique check (length(token) between 1 and 4096),
    -- The app version that registered, free text, never trusted for anything.
    app_build       text,
    registered_at   timestamptz not null default now(),
    last_seen_at    timestamptz not null default now(),
    -- Set when the provider says the token is dead, or the member withdrew
    -- it. Kept rather than deleted so the delivery log can explain a phone
    -- that stopped hearing.
    disabled_at     timestamptz,
    disabled_reason text
);

create index member_device_member_idx
    on member_device (member_id) where disabled_at is null;
create index member_device_customer_idx
    on member_device (customer_id) where disabled_at is null;
create index member_device_session_idx
    on member_device (session_id);

comment on table member_device is
    'A phone the member app is signed in on, by its push token (docs/notifications.md, Push). Disabled, never deleted, when the provider refuses the token or the session is revoked.';

-- ---------------------------------------------------------------------------
-- The wording
-- ---------------------------------------------------------------------------
-- For push the subject is the notification's title and the body its text;
-- a phone shows a line or two, so both are short. Amounts are bare
-- figures, as on the other channels. Edited at Configuration ->
-- Notification wording like every other.
insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('deposit.posted', 'push',
     'Deposit received',
     'Rs {{amount}} has been deposited to {{account}}. Balance: Rs {{balance}}.',
     'Sent to the member''s phone when a deposit is posted to the account.'),
    ('withdrawal.disbursed', 'push',
     'Withdrawal paid out',
     'Your withdrawal of Rs {{amount}} from {{account}} has been paid out by {{method}}. Balance: Rs {{balance}}.',
     'Sent to the member''s phone when a withdrawal is approved and paid out.'),
    ('transfer.posted', 'push',
     'Transfer completed',
     'Rs {{amount}} has been transferred from {{from_account}} to {{to_account}}. Balance: Rs {{balance}}.',
     'Sent to the member''s phone when a transfer posts.'),
    ('partner.added', 'push',
     'New partner: {{outlet_name}}',
     'Show your Al Barakah card at {{outlet_name}} for {{discount}} off. See it on your home screen.',
     'Sent to every phone signed in when an outlet becomes a partner (Configuration -> Member app).'),
    ('promotion.published', 'push',
     '{{title}}',
     '{{body}}',
     'Sent to every phone signed in when a promotion card goes live on the home screen (Configuration -> Member app).')
on conflict (event_code, channel) do nothing;
