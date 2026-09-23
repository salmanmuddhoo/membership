-- A deceased non-member's accounts close together (business decision,
-- after 0098).
--
-- 0098 let a closure pay a deceased non-member's balance to their nominee,
-- one account at a time. Officers asked for one request instead: when the
-- holder has died, the closure covers every account they still hold and
-- pays the sum to the claimant, as a member's demised claim does (0079) —
-- without the Takaful benefit, which is the membership's.
--
-- Submitting such a closure puts all of the holder's open accounts into
-- 'closing'; posting it writes one debit per account under the one
-- transaction and closes each. A closure with no claimant is unchanged:
-- the one account it names. The financial_event carries the claimant for
-- it as it does for a claim.
--
-- Otherwise the function is 0083's, repeated whole because a function
-- is replaced whole.
set local albarakah.actor_description = 'migration 0099_closure_on_death_covers_every_account';

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
    v_other      uuid;
    v_leg        record;
    v_total      numeric(14, 2);
    v_touches_bank boolean;
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

    -- Through a bank, so which account and under what reference (S-1902).
    -- A Phase 1 fee line carried onto the ledger predates the rule.
    if not v_carried then
        select touches_bank into v_touches_bank
          from payment_method where code = v_tx.method;
        if coalesce(v_touches_bank, false)
           and (v_tx.bank_account_id is null
                or btrim(coalesce(v_tx.method_reference, '')) = '') then
            raise exception
                'transaction % moves money through a bank and must name the bank account and the reference',
                v_tx.reference
                using errcode = 'restrict_violation';
        end if;
    end if;

    select status into v_acc_status from account where id = v_tx.account_id for update;
    if v_acc_status is null then
        raise exception 'account % is missing', v_tx.account_id
            using errcode = 'restrict_violation';
    end if;
    -- A closure, a resignation or a demised claim is the one transaction
    -- that posts on a closing account: it is what the account is closing
    -- for (S-1702, S-1703, S-1704).
    if v_acc_status <> 'active' and not v_carried
       and not (v_tx.kind in ('closure', 'resignation', 'demise')
                and v_acc_status = 'closing') then
        raise exception
            'account % is %, and money cannot move on it',
            v_tx.account_id, v_acc_status
            using errcode = 'restrict_violation';
    end if;

    if v_tx.kind = 'deposit' then
        v_direction := 'credit';
    elsif v_tx.kind = 'withdrawal' then
        v_direction := 'debit';
    elsif v_tx.kind = 'closure' and v_tx.claimant_kind is not null then
        -- A deceased non-member's accounts, all of them (0099): every one
        -- of the holder's accounts that submitting the closure put into
        -- 'closing', paid out together. Written below as one entry per
        -- account under this one transaction, as a claim is.
        v_direction := 'debit';
        select coalesce(sum(coalesce(b.balance, 0)), 0) into v_total
          from account a
          left join account_balance b on b.account_id = a.id
         where (a.member_id = v_tx.member_id or a.customer_id = v_tx.customer_id)
           and a.status = 'closing';
        if v_tx.amount <> v_total then
            raise exception
                'transaction % closes the holder''s accounts for % but they hold %',
                v_tx.reference, v_tx.amount, v_total
                using errcode = 'restrict_violation';
        end if;
    elsif v_tx.kind = 'closure' then
        -- Everything the account holds, exactly (S-1702). The amount was
        -- refreshed from the balance when it was submitted and again just
        -- before this call; a mismatch means money moved in between, and
        -- closing an account with a rupee left on it is what this refuses.
        v_direction := 'debit';
        select coalesce(balance, 0) into v_current
          from account_balance where account_id = v_tx.account_id;
        v_current := coalesce(v_current, 0);
        if v_tx.amount <> v_current then
            raise exception
                'transaction % closes account % for % but its balance is %',
                v_tx.reference, v_tx.account_id, v_tx.amount, v_current
                using errcode = 'restrict_violation';
        end if;
    elsif v_tx.kind = 'resignation' then
        -- Everything every core account holds, exactly (S-1703): the
        -- member's accounts of a membership-default type, which are the
        -- ones submitting the resignation put into 'closing'. Written
        -- below as one entry per account under this one transaction.
        v_direction := 'debit';
        if v_tx.member_id is null then
            raise exception
                'transaction % resigns nobody: it names no member', v_tx.reference
                using errcode = 'restrict_violation';
        end if;
        select coalesce(sum(coalesce(b.balance, 0)), 0) into v_total
          from account a
          join account_type at on at.id = a.account_type_id
          left join account_balance b on b.account_id = a.id
         where a.member_id = v_tx.member_id
           and at.is_membership_default
           and a.status = 'closing';
        if v_tx.amount <> v_total then
            raise exception
                'transaction % resigns % for % but the core accounts hold %',
                v_tx.reference, v_tx.member_id, v_tx.amount, v_total
                using errcode = 'restrict_violation';
        end if;
    elsif v_tx.kind = 'demise' then
        -- Everything every account holds, plus the Takaful benefit the
        -- claim carries (S-1704): the deceased member's accounts of every
        -- type, which are the ones submitting the claim put into 'closing'.
        -- The benefit is the Society's own money, not an account's, so it
        -- is on the transaction and in the total and nowhere in the ledger.
        v_direction := 'debit';
        if v_tx.member_id is null then
            raise exception
                'transaction % settles nobody: it names no member', v_tx.reference
                using errcode = 'restrict_violation';
        end if;
        select coalesce(sum(coalesce(b.balance, 0)), 0) into v_total
          from account a
          left join account_balance b on b.account_id = a.id
         where a.member_id = v_tx.member_id
           and a.status = 'closing';
        if v_tx.amount <> v_total + v_tx.takaful_benefit then
            raise exception
                'transaction % settles % for % but the accounts hold % and the benefit is %',
                v_tx.reference, v_tx.member_id, v_tx.amount, v_total, v_tx.takaful_benefit
                using errcode = 'restrict_violation';
        end if;
    elsif v_tx.kind = 'transfer_leg' then
        -- One leg of a transfer (S-1504): its own direction. The debit leg
        -- is the one the chain and the receipt belong to; the credit leg
        -- is posted by the debit leg, below, in the same call.
        v_direction := v_tx.leg_direction;
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

    -- Money leaving on a withdrawal or a transfer holds the type's floor
    -- (0065): hard, FRD 4.3. Read now, not at capture, because the balance
    -- may have moved since. A reversal is exempt: it undoes, it does not
    -- draw. A closure, a resignation and a claim are exempt: the floor is
    -- what an open account keeps, and these are not staying open.
    if v_direction = 'debit' and v_tx.kind in ('withdrawal', 'transfer_leg') then
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
    end if;

    if v_tx.kind in ('resignation', 'demise')
       or (v_tx.kind = 'closure' and v_tx.claimant_kind is not null) then
        -- One debit per account for what it holds, and each closes as it
        -- empties: the core accounts for a resignation, every account for
        -- a claim or a deceased non-member's closure. The balance after is
        -- what the holder is left with: nothing.
        v_entry_seq := null;
        v_balance := 0;
        for v_leg in
            select a.id, coalesce(b.balance, 0) as balance
              from account a
              join account_type at on at.id = a.account_type_id
              left join account_balance b on b.account_id = a.id
             where (a.member_id = v_tx.member_id or a.customer_id = v_tx.customer_id)
               and a.status = 'closing'
               and (v_tx.kind <> 'resignation' or at.is_membership_default)
             order by at.sort_order, a.opened_at
             for update of a
        loop
            if v_leg.balance > 0 then
                insert into account_entry (account_id, transaction_id, direction, amount)
                values (v_leg.id, v_tx.id, 'debit', v_leg.balance)
                returning sequence_no into v_entry_seq;

                update account_balance
                   set balance           = balance - v_leg.balance,
                       entry_count       = entry_count + 1,
                       as_of_sequence_no = v_entry_seq,
                       updated_at        = now()
                 where account_id = v_leg.id;
            end if;
            update account
               set status = 'closed', closed_at = now(), updated_at = now()
             where id = v_leg.id;
        end loop;

        -- A deceased non-member's record is marked by the application, with
        -- its own audit line, once nothing of theirs is left open.
        if v_tx.kind in ('resignation', 'demise') then
            update member
               set status = case v_tx.kind when 'demise' then 'demised'
                                            else 'resigned' end,
                   status_changed_at = now()
             where id = v_tx.member_id;
        end if;
    elsif v_tx.amount > 0 then
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
    else
        -- A closure of an empty account (the only zero that gets here):
        -- nothing to enter, the balance stays what it is.
        v_entry_seq := null;
        v_balance := v_current;
    end if;

    update transaction
       set status    = 'posted',
           posted_at = now(),
           posted_by = p_actor_user_id
     where id = v_tx.id;

    -- The account closes in the same statement as the entry that empties
    -- it (S-1702): never closed with money on it, never emptied and left
    -- open.
    if v_tx.kind = 'closure' then
        update account
           set status = 'closed', closed_at = now(), updated_at = now()
         where id = v_tx.account_id;
    end if;

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
               'bank_account_id', v_tx.bank_account_id,
               'receipt_no',   rn.receipt_no,
               'carried_from_phase_1', case when v_carried then true end,
               'account_closed', case when v_tx.kind in ('closure', 'resignation', 'demise') then true end,
               'membership_ended', case when v_tx.kind in ('resignation', 'demise') then true end,
               'takaful_benefit', case when v_tx.kind = 'demise' then v_tx.takaful_benefit end,
               'claimant', case when v_tx.claimant_kind is not null then v_tx.payee_name end,
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
            'balance_after', v_balance,
            'account_closed', case when v_tx.kind in ('closure', 'resignation', 'demise') then true end,
            'membership_ended', case when v_tx.kind in ('resignation', 'demise') then true end,
            'takaful_benefit', case when v_tx.kind = 'demise' then v_tx.takaful_benefit end
        ))
    );

    -- A transfer posts both legs or neither (S-1504): the debit leg,
    -- having posted, posts its credit leg in this same call and marks the
    -- transfer posted. A leg posted on its own is never left half done.
    if v_tx.kind = 'transfer_leg' and v_direction = 'debit' then
        select id into v_other
          from transaction
         where transfer_id = v_tx.transfer_id
           and leg_direction = 'credit'
           and status in ('submitted', 'approved')
         for update;
        if v_other is not null then
            perform post_transaction(v_other, p_actor_user_id, p_actor_description);
        end if;
        update transfer set status = 'posted', updated_at = now()
         where id = v_tx.transfer_id;
    end if;
end;
$$;
