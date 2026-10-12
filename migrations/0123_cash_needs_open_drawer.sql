-- Cash moves only through an open drawer (officer direction, after S-2002).
--
-- 0084 attributed a cash movement to the open drawer of whoever posted it
-- or recorded it, and let one with no open drawer through as "nobody's
-- drawer", for the daily reconciliation to list. The Society wants no such
-- movement at all: an officer takes or pays out cash only while their own
-- drawer is open, so every rupee of cash is in some drawer's count.
--
-- The two attribution triggers are where that is decided, once, for every
-- path that moves cash — deposits, disbursements, reversals, fee receipts
-- and refunds — so they now refuse instead of leaving the column empty. The
-- refusal is restrict_violation, which post_transaction's callers already
-- read as the ledger's answer and show in their own words (ledger.ts).
--
-- What is not cash through anyone's hands is untouched: a transaction
-- carried from a receipt line (0096) was counted when the receipt was
-- taken, and a method that is not cash is not a drawer's business.

create or replace function attribute_transaction_cash_session()
returns trigger
language plpgsql
as $$
declare
    v_is_cash boolean;
begin
    if new.status = 'posted' and old.status <> 'posted'
       and new.cash_session_id is null and new.posted_by is not null
       and new.payment_line_id is null
       and new.payment_account_line_id is null then
        select is_cash into v_is_cash from payment_method where code = new.method;
        if coalesce(v_is_cash, false) then
            new.cash_session_id := open_cash_session_for(new.posted_by);
            if new.cash_session_id is null then
                raise exception
                    'Open your cash drawer before taking or paying out cash.'
                    using errcode = 'restrict_violation';
            end if;
        end if;
    end if;
    return new;
end;
$$;

create or replace function attribute_payment_cash_session()
returns trigger
language plpgsql
as $$
declare
    v_is_cash boolean;
begin
    if new.cash_session_id is null then
        select is_cash into v_is_cash from payment_method where code = new.method;
        if coalesce(v_is_cash, false) then
            new.cash_session_id := open_cash_session_for(new.recorded_by);
            if new.cash_session_id is null then
                raise exception
                    'Open your cash drawer before taking or paying out cash.'
                    using errcode = 'restrict_violation';
            end if;
        end if;
    end if;
    return new;
end;
$$;
