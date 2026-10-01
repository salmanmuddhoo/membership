-- Setting an account's balance from a migration file (officer direction: an
-- upload of account number and balance that overrides the balance on file).
--
-- The ledger is append-only, so a balance is never set by editing a
-- figure. What this replaces is the account's migrated opening balance —
-- the one deposit the legacy import carried onto the ledger from its
-- 'migration' payment (0066, payments.ts recordMigrationOpeningBalances) —
-- and only while that is all the account holds. The payment line, the
-- deposit, its entry, the balance cache and both financial events are
-- brought to the new amount together, so the receipt, the statement and
-- the migration summary all read the same figure. A balance set to zero
-- takes the deposit off the ledger and leaves its line at zero; a balance
-- set on an account with no opening balance yet records one, on a receipt
-- of its own, the way the import does.
--
-- An account with any other transaction — money that moved since, or an
-- opening payment taken in the ordinary way — is refused: its balance is
-- the sum of real transactions, and is corrected with a transaction.
--
-- Guarded by the same escape hatch as the migration cancel (0110), for this
-- function's own transaction only. Every account set is audited, with the
-- balance before and after.
set local albarakah.actor_description = 'migration 0111_set_opening_balance';

create or replace function set_opening_balance(
    p_account_id        uuid,
    p_amount            numeric,
    p_fee_version_id    uuid,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_acc       record;
    v_label     text;
    v_previous  numeric(14, 2);
    v_amount    numeric(14, 2);
    v_count     integer;
    v_tx        record;
    v_payment   uuid;
    v_line      uuid;
    v_is_fee    boolean;
    v_component text;
    v_receipt   record;
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'set_opening_balance requires a named actor'
            using errcode = 'restrict_violation';
    end if;
    if p_actor_user_id is null
       or not exists (select 1 from app_user where id = p_actor_user_id) then
        raise exception 'set_opening_balance requires the staff account running it'
            using errcode = 'restrict_violation';
    end if;
    if p_amount is null or p_amount < 0 then
        raise exception 'A balance cannot be negative.'
            using errcode = 'check_violation';
    end if;
    v_amount := round(p_amount, 2);

    select a.id, a.member_id, a.customer_id, a.opened_by_application_id,
           a.account_type_id, ty.code as type_code, ty.name as type_name,
           coalesce(a.account_no, m.member_no) as label
      into v_acc
      from account a
      join account_type ty on ty.id = a.account_type_id
      left join member m on m.id = a.member_id
     where a.id = p_account_id
       for update of a;
    if not found then
        raise exception 'no account %', p_account_id
            using errcode = 'no_data_found';
    end if;
    v_label := v_acc.label;
    if v_acc.opened_by_application_id is null then
        raise exception '% has no application to record an opening balance against.',
            v_label
            using errcode = 'restrict_violation';
    end if;

    -- Anything on the account other than a migrated opening balance.
    if exists (
        select 1
          from transaction t
          left join payment_line pl on pl.id = t.payment_line_id
          left join payment_account_line pal on pal.id = t.payment_account_line_id
          left join payment p on p.id = coalesce(pl.payment_id, pal.payment_id)
         where t.account_id = v_acc.id
           and (p.id is null or p.method <> 'migration' or p.voided_at is not null)
    ) then
        raise exception '% has transactions of its own, so its balance cannot be set here.',
            v_label
            using errcode = 'restrict_violation';
    end if;

    select count(*) into v_count from transaction where account_id = v_acc.id;
    if v_count > 1 then
        raise exception '% has more than one opening balance, so its balance cannot be set here.',
            v_label
            using errcode = 'restrict_violation';
    end if;

    select coalesce(balance, 0) into v_previous
      from account_balance where account_id = v_acc.id;
    v_previous := coalesce(v_previous, 0);
    if v_previous = v_amount then
        return jsonb_build_object('changed', false,
                                  'previous', v_previous, 'balance', v_amount);
    end if;

    v_is_fee := v_acc.type_code in ('shares', 'msa');
    v_component := case v_acc.type_code
                       when 'shares' then 'shares'
                       when 'msa' then 'msa_deposit'
                   end;

    perform set_config('albarakah.allow_full_reset', 'true', true);

    select t.id, t.payment_line_id, t.payment_account_line_id
      into v_tx
      from transaction t where t.account_id = v_acc.id;

    if found then
        -- The migrated opening balance, brought to the new amount.
        if v_tx.payment_line_id is not null then
            update payment_line set amount = v_amount
             where id = v_tx.payment_line_id
            returning payment_id into v_payment;
        else
            update payment_account_line set amount = v_amount
             where id = v_tx.payment_account_line_id
            returning payment_id into v_payment;
        end if;

        if v_amount > 0 then
            update transaction set amount = v_amount where id = v_tx.id;
            update account_entry set amount = v_amount
             where transaction_id = v_tx.id;
            update financial_event
               set payload = payload || jsonb_build_object(
                       'amount', v_amount, 'balance_after', v_amount)
             where transaction_id = v_tx.id
               and event_type = 'transaction.posted';
        else
            delete from financial_event where transaction_id = v_tx.id;
            delete from receipt_print where transaction_id = v_tx.id;
            delete from account_entry where transaction_id = v_tx.id;
            delete from transaction where id = v_tx.id;
        end if;
        perform rebuild_account_balance(v_acc.id);
    else
        -- No opening balance on the ledger yet: a zero line left by an
        -- earlier setting, or a new receipt of its own.
        if v_is_fee then
            select l.id, l.payment_id into v_line, v_payment
              from payment_line l
              join payment p on p.id = l.payment_id
             where p.application_id = v_acc.opened_by_application_id
               and p.method = 'migration' and p.voided_at is null
               and l.component_code = v_component and l.amount = 0
             limit 1;
            if found then
                update payment_line set amount = v_amount where id = v_line;
            end if;
        else
            select l.id, l.payment_id into v_line, v_payment
              from payment_account_line l
              join payment p on p.id = l.payment_id
             where p.application_id = v_acc.opened_by_application_id
               and p.method = 'migration' and p.voided_at is null
               and l.account_type_id = v_acc.account_type_id and l.amount = 0
             limit 1;
            if found then
                update payment_account_line set amount = v_amount where id = v_line;
            end if;
        end if;

        if v_line is null then
            insert into receipt_number (allocated_by)
            values (p_actor_user_id)
            returning id, receipt_no into v_receipt;

            insert into payment
                (receipt_number_id, kind, application_id, fee_version_id,
                 method, method_reference, total_amount, variance_reason,
                 source_of_fund, source_of_fund_form_confirmed, received_at,
                 recorded_by, recorded_by_role)
            values (v_receipt.id, 'payment', v_acc.opened_by_application_id,
                    p_fee_version_id, 'migration', '', v_amount, '', '', false,
                    now(), p_actor_user_id, 'System Administrator')
            returning id into v_payment;

            if v_is_fee then
                insert into payment_line
                    (payment_id, component_code, scheduled_amount, amount, sort_order)
                values (v_payment, v_component, null, v_amount, 0);
            else
                insert into payment_account_line
                    (payment_id, account_type_id, account_type_code,
                     account_type_name, amount, sort_order)
                values (v_payment, v_acc.account_type_id, v_acc.type_code,
                        v_acc.type_name, v_amount, 0);
            end if;

            update receipt_number set state = 'issued', settled_at = now()
             where id = v_receipt.id and state = 'allocated';

            insert into financial_event (event_type, payment_id, receipt_no, payload)
            values ('payment.recorded', v_payment, v_receipt.receipt_no,
                    jsonb_build_object(
                        'kind', 'payment',
                        'applicationId', v_acc.opened_by_application_id,
                        'currency', 'MUR',
                        'method', 'migration',
                        'recordedBy', p_actor_description));
        end if;

        perform post_opening_balances(v_acc.opened_by_application_id,
                                      p_actor_user_id, p_actor_description);
    end if;

    -- The payment the line belongs to, and its recorded event, carry the
    -- new total and lines.
    update payment
       set total_amount = (
               select coalesce(sum(amount), 0) from payment_line
                where payment_id = v_payment)
             + (select coalesce(sum(amount), 0) from payment_account_line
                 where payment_id = v_payment)
     where id = v_payment;

    update financial_event fe
       set payload = fe.payload || jsonb_build_object(
               'totalAmount', p.total_amount::text,
               'components', coalesce((
                   select jsonb_agg(jsonb_build_object(
                              'code', l.component_code,
                              'amount', l.amount::text) order by l.sort_order)
                     from payment_line l where l.payment_id = p.id), '[]'::jsonb),
               'accountTypes', coalesce((
                   select jsonb_agg(jsonb_build_object(
                              'accountTypeId', l.account_type_id,
                              'code', l.account_type_code,
                              'amount', l.amount::text) order by l.sort_order)
                     from payment_account_line l where l.payment_id = p.id), '[]'::jsonb))
      from payment p
     where p.id = v_payment
       and fe.payment_id = p.id
       and fe.event_type = 'payment.recorded';

    insert into audit_event
        (actor_user_id, actor_description, action, entity_type, entity_id,
         previous_value, new_value)
    values (p_actor_user_id, p_actor_description, 'migration.balance.set',
            'account', v_acc.id::text,
            jsonb_build_object('account', v_label, 'balance', v_previous),
            jsonb_build_object('account', v_label, 'balance', v_amount));

    return jsonb_build_object('changed', true,
                              'previous', v_previous, 'balance', v_amount);
end;
$$;

comment on function set_opening_balance(uuid, numeric, uuid, uuid, text) is
    'Sets an account''s migrated opening balance to a new amount, or records '
    'one. Refuses an account holding any other transaction.';

revoke execute on function set_opening_balance(uuid, numeric, uuid, uuid, text) from public;
grant execute on function set_opening_balance(uuid, numeric, uuid, uuid, text) to albarakah_app;

-- A whole file in one call: [{account_id, amount, fee_version_id}], in
-- order. Any refusal stops it, and nothing it did stays.
create or replace function set_opening_balances(
    p_rows              jsonb,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row     jsonb;
    v_result  jsonb;
    v_changed integer := 0;
begin
    for v_row in select value from jsonb_array_elements(p_rows) loop
        v_result := set_opening_balance(
            (v_row->>'account_id')::uuid,
            (v_row->>'amount')::numeric,
            nullif(v_row->>'fee_version_id', '')::uuid,
            p_actor_user_id,
            p_actor_description);
        if (v_result->>'changed')::boolean then
            v_changed := v_changed + 1;
        end if;
    end loop;
    return v_changed;
end;
$$;

comment on function set_opening_balances(jsonb, uuid, text) is
    'set_opening_balance for every row of a balance file, all or nothing.';

revoke execute on function set_opening_balances(jsonb, uuid, text) from public;
grant execute on function set_opening_balances(jsonb, uuid, text) to albarakah_app;
