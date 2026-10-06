-- Where the membership card earns a discount (officer direction: the Cards
-- screen lists partner outlets with their logo, a category tag and the
-- percentage).
--
-- One row per outlet. An administrator writes them on the Member app
-- configuration page; the app reads the active ones through
-- GET /api/v1/member/outlets. The category is whatever tag the
-- administrator gives, kept lower-case so "Food" and "food" are one filter
-- on the phone.
--
-- A configuration table like any other: the audit trigger from 0010 refuses
-- a write that cannot be attributed.
set local albarakah.actor_description = 'migration 0116_card_outlets';

create table card_outlet (
    id               uuid          primary key default gen_random_uuid(),
    name             text          not null check (length(name) between 1 and 80),
    -- The outlet's logo, served from anywhere over https.
    logo_url         text          not null check (length(logo_url) <= 500),
    category         text          not null check (category = lower(category) and length(category) between 1 and 30),
    discount_percent numeric(5,2)  not null check (discount_percent > 0 and discount_percent <= 100),
    description      text          not null default '' check (length(description) <= 200),
    address          text          check (address is null or length(address) <= 120),
    link_url         text          check (link_url is null or length(link_url) <= 500),
    is_active        boolean       not null default true,
    sort_order       integer       not null default 0,
    created_at       timestamptz   not null default now(),
    updated_at       timestamptz   not null default now()
);

create trigger card_outlet_set_updated_at
    before update on card_outlet
    for each row execute function set_updated_at();

create trigger card_outlet_audit
    after insert or update or delete on card_outlet
    for each row execute function record_configuration_change();

comment on table card_outlet is
    'Partner outlets where the membership card earns a discount, as the member app lists them.';
