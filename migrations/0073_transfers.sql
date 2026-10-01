-- Transfers (S-1504, FRD 6.4, open point 5).
--
-- A transfer is two legs under one id, never two transactions that happen
-- to match: a `transfer` row for the whole, and `transaction` rows of kind
-- transfer_leg — a debit leg on the source and, when the destination is an
-- account on the system, a credit leg on it. The debit leg is the one the
-- matrix routes, the chain reviews and the receipt belongs to; the credit
-- leg follows it, and post_transaction() posts both or neither.
--
-- A destination that is not on the system — a non-member, "Other" — has no
-- credit leg (open point 5's default): the debit leg names the payee and
-- is paid out through the same disbursement step as a withdrawal (S-1503).
--
-- `internal_transfer` is the method a leg between two accounts carries:
-- no money changes hands outside the Society, so it is a system method,
-- never offered on a form.
set local albarakah.actor_description = 'migration 0073_transfers';

create sequence transfer_reference_seq;

create table transfer (
    id            uuid        primary key default gen_random_uuid(),
    serial_no     bigint      not null unique
                  default nextval('transfer_reference_seq'),
    reference     text        not null unique
                  generated always as ('TR-' || lpad(serial_no::text, 6, '0'))
                  stored,

    -- The source's holder: whose money it is.
    member_id     uuid        references member(id),
    customer_id   uuid        references customer(id),
    constraint transfer_has_one_holder
        check (num_nonnulls(member_id, customer_id) = 1),

    reason        text,
    -- Mirrors the debit leg's status; posted by post_transaction() itself.
    status        text        not null default 'submitted',
    constraint transfer_status_check check (status in (
        'draft', 'submitted', 'under_review', 'approved', 'posted',
        'returned', 'rejected', 'cancelled'
    )),

    captured_by   uuid        not null references app_user(id),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create trigger transfer_set_updated_at
    before update on transfer
    for each row execute function set_updated_at();

alter table transaction
    add column transfer_id   uuid references transfer(id),
    add column leg_direction text
        constraint transaction_leg_direction_check
        check (leg_direction in ('credit', 'debit')),
    -- Who the money went to when there is no account to credit.
    add column payee_name    text,
    drop constraint transaction_kind_check,
    add constraint transaction_kind_check
        check (kind in ('deposit', 'reversal', 'withdrawal', 'transfer_leg')),
    add constraint transaction_transfer_leg_is_complete check (
        (kind = 'transfer_leg')
        = (transfer_id is not null and leg_direction is not null)
    );

create index transaction_transfer_idx on transaction (transfer_id)
    where transfer_id is not null;

insert into payment_method
    (code, name, is_cash, requires_reference, touches_bank, is_system, sort_order)
values
    ('internal_transfer', 'Internal transfer', false, false, false, true, 998)
on conflict (code) do nothing;

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
    -- draw.
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

comment on function post_transaction(uuid, uuid, text) is
    'The only road to a balance. Posts a submitted or approved transaction: '
    'writes its account entries, moves the balance cache in the same '
    'database transaction, marks it posted, emits transaction.posted on '
    'financial_event and records who did it. A deposit credits; a withdrawal '
    'debits and is refused below the account type''s floor; a transfer''s '
    'debit leg posts its credit leg in the same call, so both post or '
    'neither; a reversal posts the opposite direction of what it names; an '
    'entry carried from a Phase 1 receipt posts whatever the account''s '
    'status. The application role cannot write account_entry or '
    'account_balance any other way.';
