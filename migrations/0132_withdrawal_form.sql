-- The Withdrawal Form (officer request, 26 November 2026).
--
-- A withdrawal recorded at the counter starts as a draft, and the client
-- signs that they are withdrawing that amount before it goes further —
-- before the Secretary reviews one that goes for approval, and before one
-- paid out at once is paid (src/lib/ledger/withdrawal-requests.ts). The
-- signed sheet is filed against the transaction, as a closure request's is
-- (migration 0077).
set local albarakah.actor_description = 'migration 0132_withdrawal_form';

insert into document_type (code, name, description, tracks_expiry) values
    ('withdrawal_form', 'Withdrawal Form',
     'The client''s signed request to withdraw an amount from an account.',
     false)
on conflict (code) do nothing;
