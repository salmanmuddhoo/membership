-- A partner outlet (officer direction): one that pays the Society a premium
-- fee, and in return appears on the member app's home screen as well as on
-- the Cards screen. Set on the Member app configuration page.
set local albarakah.actor_description = 'migration 0117_card_outlet_partners';

alter table card_outlet
    add column is_partner boolean not null default false;

comment on column card_outlet.is_partner is
    'Pays the premium fee: shown on the app''s home screen as well as under Cards.';
