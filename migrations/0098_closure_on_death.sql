-- A closure paid to a deceased non-member's nominee (business decision,
-- after the lifecycle test).
--
-- A demised claim is for members only. A non-member — a customer, or a
-- member who resigned and kept an HSA or Investment — who dies has their
-- balances paid to their nominee, or to another person the officer
-- records, one account at a time: a closure with a death certificate
-- instead of the holder's signature. The claimant is carried the way a
-- claim carries it (0079): claimant_kind, claimant and payee_name.
--
-- 0079 tied a claimant to a claim and a claim to a claimant. The second
-- half stands; the first now admits a closure too.
set local albarakah.actor_description = 'migration 0098_closure_on_death';

alter table transaction
    drop constraint transaction_claim_is_complete,
    add constraint transaction_claim_is_complete check (
        (claimant_kind is null) = (claimant is null)
        and (kind <> 'demise' or claimant_kind is not null)
        and (claimant_kind is null or kind in ('demise', 'closure'))
    );

comment on column transaction.claimant is
    'Who is paid on a death: a demised claim''s claimant (S-1704), or the '
    'person a deceased non-member''s account is closed to. name, nic, '
    'address, relation — the nominee''s details as captured on the '
    'application, or another person''s as the officer recorded them.';
