-- Withdrawals (S-1501, S-1502, S-1503, FRD 4.3, 6.3).
--
-- The second kind of transaction, and the first that takes money out. The
-- checks an officer meets at the counter — the type allows it, the holder
-- and the account are active, the available balance covers it, the floor
-- holds, the maximum holds — are the engine's (src/lib/ledger/withdrawals.ts)
-- and run before anything is written. post_transaction() is the last line:
-- it posts a withdrawal as a debit and refuses one that would take the
-- account below its type's minimum_balance (0065), because the balance may
-- have moved between the decision and the disbursement.
--
-- Disbursing an approved withdrawal is the act that moves the money
-- (S-1503): whoever holds transaction.post records how it was paid and only
-- then does it post, dated the disbursement. One more segregation rule
-- (S-203): the person who approved it may not be the one who disburses it.
set local albarakah.actor_description = 'migration 0072_withdrawals';

alter table transaction
    drop constraint transaction_kind_check,
    add constraint transaction_kind_check
        check (kind in ('deposit', 'reversal', 'withdrawal'));

create or replace function post_transaction(
    p_transaction_id    uuid,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tx         transaction%rowtype;
    v_orig       transaction%rowtype;
    v_acc_status text;
    v_carried    boolean;
    v_direction  text;
    v_entry_seq  bigint;
    v_balance    numeric(14, 2);
    v_floor      numeric(14, 2);
    v_current    numeric(14, 2);
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'post_transaction requires a named actor'
            using errcode = 'restrict_violation';
    end if;

    select * into v_tx from transaction where id = p_transaction_id for update;
    if not found then
        raise exception 'no transaction %', p_transaction_id
            using errcode = 'no_data_found';
    end if;

    if v_tx.status not in ('submitted', 'approved') then
        raise exception
            'transaction % is %, and only a submitted or approved one posts',
            v_tx.reference, v_tx.status
            using errcode = 'restrict_violation';
    end if;

    v_carried := v_tx.payment_line_id is not null
              or v_tx.payment_account_line_id is not null;

    select status into v_acc_status from account where id = v_tx.account_id for update;
    if v_acc_status is null then
        raise exception 'account % is missing', v_tx.account_id
            using errcode = 'restrict_violation';
    end if;
    if v_acc_status <> 'active' and not v_carried then
        raise exception
            'account % is %, and money cannot move on it',
            v_tx.account_id, v_acc_status
            using errcode = 'restrict_violation';
    end if;

    if v_tx.kind = 'deposit' then
        v_direction := 'credit';
    elsif v_tx.kind = 'withdrawal' then
        v_direction := 'debit';
        -- The floor is the type's (0065): hard, FRD 4.3. Read now, not at
        -- capture, because the balance may have moved since.
        select at.minimum_balance into v_floor
          from account a join account_type at on at.id = a.account_type_id
         where a.id = v_tx.account_id;
        select coalesce(balance, 0) into v_current
          from account_balance where account_id = v_tx.account_id;
        v_current := coalesce(v_current, 0);
        if v_current - v_tx.amount < v_floor then
            raise exception
                'transaction % would take account % below its floor of % (balance %)',
                v_tx.reference, v_tx.account_id, v_floor, v_current
                using errcode = 'restrict_violation';
        end if;
    elsif v_tx.kind = 'reversal' then
        select * into v_orig from transaction where id = v_tx.reverses_id for update;
        if not found or v_orig.status <> 'posted' then
            raise exception
                'transaction % reverses one that is not posted', v_tx.reference
                using errcode = 'restrict_violation';
        end if;
        if v_orig.account_id <> v_tx.account_id then
            raise exception
                'transaction % must reverse on the account it names', v_tx.reference
                using errcode = 'restrict_violation';
        end if;
        if v_tx.amount > v_orig.amount then
            raise exception
                'transaction % reverses more than % moved', v_tx.reference, v_orig.reference
                using errcode = 'restrict_violation';
        end if;
        select case e.direction when 'credit' then 'debit' else 'credit' end
          into v_direction
          from account_entry e
         where e.transaction_id = v_orig.id
         limit 1;
    else
        raise exception 'post_transaction does not know kind %', v_tx.kind
            using errcode = 'restrict_violation';
    end if;

    insert into account_entry (account_id, transaction_id, direction, amount)
    values (v_tx.account_id, v_tx.id, v_direction, v_tx.amount)
    returning sequence_no into v_entry_seq;

    insert into account_balance (account_id, balance, entry_count, as_of_sequence_no)
    values (
        v_tx.account_id,
        case v_direction when 'credit' then v_tx.amount else -v_tx.amount end,
        1,
        v_entry_seq
    )
    on conflict (account_id) do update set
        balance           = account_balance.balance
                            + case v_direction when 'credit' then v_tx.amount
                                               else -v_tx.amount end,
        entry_count       = account_balance.entry_count + 1,
        as_of_sequence_no = v_entry_seq,
        updated_at        = now()
    returning balance into v_balance;

    update transaction
       set status    = 'posted',
           posted_at = now(),
           posted_by = p_actor_user_id
     where id = v_tx.id;

    insert into financial_event (event_type, transaction_id, receipt_no, payload)
    select 'transaction.posted',
           v_tx.id,
           rn.receipt_no,
           jsonb_strip_nulls(jsonb_build_object(
               'reference',    v_tx.reference,
               'kind',         v_tx.kind,
               'reverses',     v_orig.reference,
               'member_id',    v_tx.member_id,
               'customer_id',  v_tx.customer_id,
               'account_id',   v_tx.account_id,
               'direction',    v_direction,
               'amount',       v_tx.amount,
               'currency',     v_tx.currency,
               'method',       v_tx.method,
               'method_reference', v_tx.method_reference,
               'receipt_no',   rn.receipt_no,
               'carried_from_phase_1', case when v_carried then true end,
               'balance_after', v_balance,
               'entry_sequence_no', v_entry_seq,
               'captured_by',  v_tx.captured_by,
               'posted_by',    p_actor_user_id,
               'posted_at',    now()
           ))
      from (select v_tx.receipt_number_id as id) t
      left join receipt_number rn on rn.id = t.id;

    insert into audit_event (
        actor_user_id, actor_description, action, entity_type, entity_id,
        new_value
    ) values (
        p_actor_user_id, p_actor_description, 'transaction.posted',
        'transaction', v_tx.reference,
        jsonb_strip_nulls(jsonb_build_object(
            'kind',          v_tx.kind,
            'reverses',      v_orig.reference,
            'account_id',    v_tx.account_id,
            'amount',        v_tx.amount,
            'balance_after', v_balance
        ))
    );
end;
$$;

comment on function post_transaction(uuid, uuid, text) is
    'The only road to a balance. Posts a submitted or approved transaction: '
    'writes its account entries, moves the balance cache in the same '
    'database transaction, marks it posted, emits transaction.posted on '
    'financial_event and records who did it. A deposit credits; a withdrawal '
    'debits and is refused below the account type''s floor; a reversal posts '
    'the opposite direction of what it names; an entry carried from a Phase '
    '1 receipt posts whatever the account''s status. The application role '
    'cannot write account_entry or account_balance any other way.';

insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('transaction',
     'transaction.approved',
     'transaction.posted',
     'The person who approved a transaction may not be the one who disburses it.')
on conflict do nothing;
