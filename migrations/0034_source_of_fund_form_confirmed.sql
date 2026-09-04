-- Officer feedback: the free-text source-of-fund note (0032) was not enough
-- on its own — the officer must also affirmatively confirm, at the point of
-- taking the payment, that the paper Source of Fund form has actually been
-- completed. A checkbox they have to tick is a stronger record of that than
-- inferring it from the text note being non-empty.
set local albarakah.actor_description = 'migration 0034_source_of_fund_form_confirmed';

alter table payment
    add column source_of_fund_form_confirmed boolean not null default false;

comment on column payment.source_of_fund_form_confirmed is
    'Required (must be true) only when method is cash and total_amount is '
    'strictly above payment.cash_source_of_fund_threshold (config_entry) — '
    'the officer''s confirmation that the paper Source of Fund form, which '
    'lives outside this application, has been completed.';
