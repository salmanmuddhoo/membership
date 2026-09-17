-- The Source of Fund checklist the Society actually uses.
--
-- Migration 0062 seeded a placeholder because the wording had not been given
-- yet; it has now — it is the list on the Society's own paper Cash Deposit
-- Form. Replacing the placeholder rather than adding beside it, and only
-- where the placeholder is still what is stored: a Society that has already
-- written its own list on Configuration -> Fee schedules keeps theirs.
set local albarakah.actor_description = 'migration 0063_cash_deposit_form_checklist';

update config_entry
   set value = '["Trade / Business", "Sale of Property: Car / Land / Others", "Cash Gift", "Other"]',
       description =
           'The source of funds the depositor certifies on the Cash Deposit ' ||
           'Form, for a cash payment above ' ||
           'payment.cash_source_of_fund_threshold. Every item prints on the ' ||
           'signed form, ticked or not. One item per line on Configuration ' ||
           '-> Fee schedules.'
 where key = 'payment.cash_source_of_fund_checklist'
   and value::text like '%Placeholder%';
