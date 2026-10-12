-- A new member's fees paid by transfer from an existing member (officer
-- request, October 2026).
--
-- Another member pays the entrance fee, Takaful and Shares for an applicant
-- from any of their own accounts, Shares included. The money leaves by a
-- transfer's debit leg with no credit leg — the applicant has no account
-- yet — and goes through the transfer approval chain like any other
-- transfer. Only once it posts is the fee receipt issued against the
-- application, under the method below; from there it is an ordinary
-- payment, and its Shares line carries into the new member's Shares account
-- on approval as a cash payment's would (post_opening_balances, 0066).
--
-- fee_transfer ties the two together: which application, which debit leg,
-- the amounts asked for (held until the transfer posts), and the payment it
-- became. Whether a request is still live is read from its transaction's
-- status and payment_id, not stored twice.
set local albarakah.actor_description = 'migration 0126_fee_transfers';

-- The system's own mark, like internal_transfer: never offered on a form,
-- written only when a fee transfer settles.
insert into payment_method
    (code, name, is_cash, requires_reference, touches_bank, is_system,
     sort_order, for_deposit, for_withdrawal, for_closure, for_resignation,
     for_demise)
values
    ('member_transfer', 'Transfer from a member', false, false, false, true,
     997, false, false, false, false, false)
on conflict (code) do nothing;

create table fee_transfer (
    id                uuid        primary key default gen_random_uuid(),
    application_id    uuid        not null references membership_application(id),
    -- The debit leg on the paying member's account.
    transaction_id    uuid        not null unique references transaction(id),
    fee_version_id    uuid        not null references fee_schedule_version(id),
    -- [{code, scheduled, amount, sortOrder}], as checked at request.
    lines             jsonb       not null,
    total_amount      numeric(14, 2) not null check (total_amount > 0),
    variance_reason   text        not null default '',
    -- Set when the transfer posts and the fee receipt is issued.
    payment_id        uuid        unique references payment(id),
    requested_by      uuid        not null references app_user(id),
    requested_by_role text        not null default '',
    created_at        timestamptz not null default now()
);

create index fee_transfer_application_idx on fee_transfer (application_id);

comment on table fee_transfer is
    'An applicant''s fees paid from an existing member''s account: the '
    'application, the transfer''s debit leg, the amounts asked for, and the '
    'payment issued once the transfer posted.';
