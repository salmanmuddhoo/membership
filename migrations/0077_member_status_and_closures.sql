-- Member status gets a vocabulary, and an account can be closed (S-1701,
-- S-1702, FRD 7.1, RES-US-006, DEM-US-007, open point 2).
--
-- member.status has been free text since 0011, with 'active' the only value
-- the code ever wrote. M17 gives it the states a member can actually be in
-- and refuses any other, so 'resigned' and 'demised' mean one thing each
-- and a report can tell them apart. A member in the last three cannot
-- transact or open an account; the capture paths already read the holder's
-- status and refuse anything but 'active' (deposits.ts, withdrawals.ts).
--
-- A closure (S-1702) is a transaction of kind 'closure': the matrix has
-- routed the kind since 0070 (always Secretary -> President), so the
-- request rides the same chain, queue, trail and chevron as a withdrawal.
-- Submitting it puts the account in 'closing', which refuses every other
-- transaction; posting it — the Treasurer's disbursement of the balance
-- (S-1503) — writes the debit entry and closes the account in the same
-- statement, so an account is never closed with money on it nor emptied
-- without being closed. A rejection reopens it (review.ts).
--
-- The signed closure request is a document filed against the transaction
-- itself, not the member: a member may close several accounts over the
-- years, and "the closure form" has to name one request each time. A third
-- owner for `document`, alongside the application and the member.
set local albarakah.actor_description =
    'migration 0077_member_status_and_closures';

-- ---------------------------------------------------------------------------
-- S-1701 · Member status
-- ---------------------------------------------------------------------------
alter table member
    add column status_changed_at timestamptz,
    add constraint member_status_check check (status in (
        'pending', 'active', 'inactive', 'dormant', 'resigned', 'demised'
    ));

comment on column member.status is
    'active: a member in good standing. inactive and dormant: kept from '
    'legacy records and S-804; no transactions. resigned (S-1703) and '
    'demised (S-1704): the membership has ended; both core accounts are '
    'closed, nothing can be opened or moved. pending: named for M17''s '
    'request flows; nothing writes it yet.';
comment on column member.status_changed_at is
    'When the status last changed, so the member page can say "resigned on". '
    'Null for a member whose status never moved off active.';

-- ---------------------------------------------------------------------------
-- S-1702 · An account can be closing, then closed
-- ---------------------------------------------------------------------------
alter table account
    add column closed_at timestamptz,
    add constraint account_status_check check (status in (
        'pending', 'active', 'inactive', 'dormant', 'frozen', 'closing',
        'closed'
    )),
    add constraint account_closed_is_dated check (
        (status = 'closed') = (closed_at is not null)
    );

-- One account of each type per holder (0018, 0027) is a rule about the
-- accounts they hold: a closed one is history, and a member who closed
-- their Hajj Savings can open another. The two indexes gain the same WHERE.
drop index account_one_per_type_per_member_idx;
create unique index account_one_per_type_per_member_idx
    on account (member_id, account_type_id)
    where status <> 'closed';
drop index account_one_per_type_per_customer_idx;
create unique index account_one_per_type_per_customer_idx
    on account (customer_id, account_type_id)
    where status <> 'closed';

comment on column account.status is
    'active: money moves. pending, inactive and dormant: an account type''s '
    'default_status (0010) — opened but not yet usable, or gone quiet. '
    'closing: a closure request is on its chain (S-1702); nothing else '
    'posts until it is decided. closed: the closure posted, the balance was '
    'paid out, and no transaction will ever post again. frozen is named for '
    'the Treasurer''s controls; nothing writes it yet.';

-- ---------------------------------------------------------------------------
-- A closure is a transaction
-- ---------------------------------------------------------------------------
-- The amount is the balance the account holds when it posts, which may be
-- nothing: an emptied account still has to be closed, and a closure of
-- zero writes no entry but does close it (post_transaction below).
alter table transaction
    drop constraint transaction_kind_check,
    add constraint transaction_kind_check
        check (kind in ('deposit', 'reversal', 'withdrawal', 'transfer_leg',
                        'closure')),
    drop constraint transaction_amount_check,
    add constraint transaction_amount_check
        check (amount > 0 or (kind = 'closure' and amount = 0));

-- The signed request, filed against the request itself.
alter table document
    add column transaction_id uuid references transaction(id),
    drop constraint document_belongs_to_exactly_one,
    add constraint document_belongs_to_exactly_one
        check (num_nonnulls(application_id, member_id, transaction_id) = 1);

create unique index document_unique_for_transaction_idx
    on document (transaction_id, document_type_id, subject)
    where transaction_id is not null;

comment on column document.transaction_id is
    'A document about one transaction (S-1702): the signed closure request, '
    'and from S-1703 a resignation form, a death certificate, an affidavit. '
    'Filed in the holder''s own SharePoint folder, named by the transaction '
    'reference.';

insert into document_type (code, name, description, tracks_expiry) values
    ('closure_request', 'Account closure request',
     'The request to close an account, signed by the member (S-1702).', false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- post_transaction: a closure debits the whole balance and closes the account
-- ---------------------------------------------------------------------------
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
    -- A closure is the one transaction that posts on a closing account: it
    -- is what the account is closing for (S-1702).
    if v_acc_status <> 'active' and not v_carried
       and not (v_tx.kind = 'closure' and v_acc_status = 'closing') then
        raise exception
            'account % is %, and money cannot move on it',
            v_tx.account_id, v_acc_status
            using errcode = 'restrict_violation';
    end if;

    if v_tx.kind = 'deposit' then
        v_direction := 'credit';
    elsif v_tx.kind = 'withdrawal' then
        v_direction := 'debit';
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
    -- draw. A closure is exempt: the floor is what an open account keeps,
    -- and this one is not staying open.
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

    if v_tx.amount > 0 then
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
               'receipt_no',   rn.receipt_no,
               'carried_from_phase_1', case when v_carried then true end,
               'account_closed', case when v_tx.kind = 'closure' then true end,
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
            'account_closed', case when v_tx.kind = 'closure' then true end
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
