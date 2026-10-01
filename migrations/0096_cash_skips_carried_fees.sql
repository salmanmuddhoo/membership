-- The opening deposits a new member's fee receipt becomes are not cash
-- through anyone's drawer (QA-02).
--
-- post_opening_balances (0066) carries the shares and msa_deposit lines of
-- an application's fee receipt onto the accounts approval opens: a deposit
-- per line, method copied from the receipt, posted by whoever approved.
-- The cash was counted once already, when the receipt was taken, on the
-- drawer of the officer who took it (attribute_payment_cash_session). The
-- trigger below then counted it a second time, on the drawer of the
-- President who approved, if they had one open — and the reconciliation
-- report listed it as cash the President moved with no drawer if not.
--
-- A transaction carried from a receipt line — payment_line_id or
-- payment_account_line_id set, a deposit from a fee line or a reversal
-- from a refund line — is the same money as that receipt, and is left
-- out of every drawer. The drawer and report queries leave it out too, so
-- a row this trigger attributed before now stops counting as well.
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
        end if;
    end if;
    return new;
end;
$$;
