-- Account types learn their limits (S-1304, FRD 4.3, 9).
--
-- Phase 2 moves money, and the rules for moving it are per account type: what
-- an account may not fall below, which operations it accepts at all, and how
-- much one transaction may carry. FRD 4.3 is explicit that there is one floor,
-- read identically by a withdrawal and by a transfer out — not two — so there
-- is one column. All of it is configuration: the engine reads these columns
-- when it evaluates a transaction (M14, M15), and an administrator changes
-- them on Configuration → Account types, audited through the trigger every
-- configuration table already carries (0010), with no release.
set local albarakah.actor_description = 'migration 0065_account_type_limits';

alter table account_type
    add column minimum_balance numeric(14, 2) not null default 0
        constraint account_type_minimum_balance_check
        check (minimum_balance >= 0),
    add column allows_deposit boolean not null default true,
    add column allows_withdrawal boolean not null default true,
    add column allows_transfer boolean not null default true,
    -- Null is no limit. Zero would be a type nothing can move on, which is
    -- what the allows_* flags are for, so it is refused rather than read as
    -- "unlimited" by one caller and "nothing" by another.
    add column maximum_transaction_amount numeric(14, 2)
        constraint account_type_maximum_transaction_amount_check
        check (maximum_transaction_amount > 0);

-- Nothing is blank on day one (FRD 9). The defaults above give every type a
-- floor of 0 with every operation allowed and no cap, which is right for the
-- MSA, HSA and Investment. Shares is the exception: the 5000 that opens it
-- (0018) is a holding minimum too — a member below it is no longer a member —
-- so its floor is set from whatever its opening minimum stands at, which is
-- the 5000 unless an administrator has already changed that.
update account_type
   set minimum_balance = minimum_opening_amount
 where code = 'shares';
