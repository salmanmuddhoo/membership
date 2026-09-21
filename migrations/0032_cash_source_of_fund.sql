-- Officer feedback: a large cash payment needs a source of fund on record,
-- and a reminder that the paper Source of Fund form (outside this
-- application) still has to be filled in. "Large" is a configurable
-- threshold, not a fixed one, so it reuses config_entry (0003) rather than
-- adding a purpose-built settings table for a single number — that is
-- exactly what config_entry exists for, and it already carries its own
-- history.
set local albarakah.actor_description = 'migration 0032_cash_source_of_fund';

alter table payment
    add column source_of_fund text not null default '';

comment on column payment.source_of_fund is
    'Required only when method is cash and total_amount is strictly above '
    'payment.cash_source_of_fund_threshold (config_entry). Free text: what '
    'the payer said the money came from.';

insert into config_entry (key, value, value_type, description)
values (
    'payment.cash_source_of_fund_threshold',
    '45000',
    'number',
    'A cash payment strictly above this amount (MUR) requires a source of '
    'fund note before a receipt can be issued, and reminds the officer to '
    'also complete the paper Source of Fund form.'
)
on conflict (key) do nothing;
