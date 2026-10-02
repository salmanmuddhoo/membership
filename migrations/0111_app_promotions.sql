-- What the member app's home screen promotes (officer direction: the home
-- screen is for promotion and advertising, as sliding cards).
--
-- One row per card. An administrator writes them on the Member app
-- configuration page; the app reads the live ones, in order, through
-- GET /api/v1/member/promotions. "Live" is active and inside the dates, if
-- any are set — a card for an event can be written ahead and retire itself.
--
-- A configuration table like any other: the audit trigger from 0010 refuses
-- a write that cannot be attributed, so every change goes through
-- withConfigurationActor and the trail says who changed which card.
set local albarakah.actor_description = 'migration 0111_app_promotions';

create table app_promotion (
    id          uuid        primary key default gen_random_uuid(),
    title       text        not null check (length(title) between 1 and 80),
    body        text        not null default '' check (length(body) <= 300),
    -- A picture across the top of the card, served from anywhere over
    -- https. Null: the card is its colour and its words.
    image_url   text        check (image_url is null or length(image_url) <= 500),
    -- Where the card goes when tapped, and what the link says.
    link_url    text        check (link_url is null or length(link_url) <= 500),
    link_label  text        check (link_label is null or length(link_label) <= 40),
    -- The card's background, #rrggbb. Null: the app's own dark green.
    accent      text        check (accent is null or accent ~ '^#[0-9a-f]{6}$'),
    is_active   boolean     not null default true,
    starts_on   date,
    ends_on     date,
    sort_order  integer     not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint app_promotion_dates check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

create trigger app_promotion_set_updated_at
    before update on app_promotion
    for each row execute function set_updated_at();

create trigger app_promotion_audit
    after insert or update or delete on app_promotion
    for each row execute function record_configuration_change();

comment on table app_promotion is
    'The cards on the member app''s home screen, in sort order; live when active and inside starts_on..ends_on.';
