-- Two officer-feedback controls on a cash payment (S-501 follow-up).
--
-- 1. A hard ceiling. Above it, a receipt cannot be issued for cash at all —
--    not a reminder, a refusal. Configurable, the same reasoning migration
--    0032 already gave the source-of-fund threshold below it: this is a
--    business value the Society may need to move without a release, so it
--    reuses config_entry (0003) rather than a column that would need a
--    migration every time the number changes.
--
-- 2. What the paper Source of Fund form (0032, 0034) becomes: a checklist an
--    officer works through on screen, signs, and that gets filed to
--    SharePoint the moment they do — the same mechanism S-401's signed
--    application form already uses, applied to a second form. The checklist
--    ITSELF is the Society's own wording, not this migration's to write, so
--    it seeds one placeholder item rather than inventing compliance language
--    nobody has approved. Configuration -> Fee schedules replaces it before
--    go-live.
--
-- Nothing here changes payment.source_of_fund_form_confirmed's own meaning
-- (0034): it is still "the officer's confirmation that the form has been
-- completed", true only once earned. What earns it changes from a checkbox
-- taken on trust to a signature actually captured and filed — the column
-- does not need to know which.
set local albarakah.actor_description = 'migration 0062_cash_payment_controls';

insert into config_entry (key, value, value_type, description)
values (
    'payment.cash_maximum',
    '500000',
    'number',
    'A cash payment strictly above this amount (MUR) is refused outright — ' ||
    'the officer is not authorised to take it, and no override exists on ' ||
    'this screen. Pay by another method, or split the payment.'
)
on conflict (key) do nothing;

insert into config_entry (key, value, value_type, description)
values (
    'payment.cash_source_of_fund_checklist',
    '["Placeholder — replace with the Society''s own Source of Fund checklist items before go-live."]',
    'json',
    'What the officer confirms, item by item, before signing the on-screen ' ||
    'Source of Fund form for a cash payment above ' ||
    'payment.cash_source_of_fund_threshold. One item per line on ' ||
    'Configuration -> Fee schedules.'
)
on conflict (key) do nothing;

insert into document_type (code, name, description, tracks_expiry)
values (
    'source_of_fund_form',
    'Source of Fund Form',
    'Signed on screen when a cash payment needs one (FRD 7.9 follow-up); ' ||
    'not part of any applicant''s KYC checklist, so it is filed and shown ' ||
    'from the Payments step itself rather than Documents.',
    false
)
on conflict (code) do nothing;
