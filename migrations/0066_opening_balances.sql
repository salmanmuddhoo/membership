-- Phase 1's money becomes Phase 2's opening balances (S-1303, FRD 4.1).
--
-- Phase 1 recorded what an applicant paid — a payment, itemised into fee
-- lines (0017) and account lines (0026) — and never a balance. The ledger
-- (0064) now counts money, so every Shares contribution, MSA deposit and
-- additional-account opening deposit already taken has to become the first
-- entry on the account it paid into, or the first balance an officer sees is
-- zero for a member who has paid five thousand rupees.
--
-- Two things are true of a carried-over entry that are not true of a deposit
-- taken at the counter from now on:
--
--   * It has a receipt already. The transaction references that receipt
--     rather than taking a new one, and one receipt may have paid into two
--     accounts (Shares and the MSA on one membership receipt), so the
--     one-receipt-one-transaction rule 0064 set is narrowed to receipts issued
--     at posting.
--   * It records money that is already there. It posts whatever the account's
--     status says — a dormant member's balance is still their balance — where
--     a new deposit needs an active account.
--
-- A refund of such a line (S-505) is the same story in reverse, and the
-- reversing transaction it becomes is the one S-1505 asks for (decision 13):
-- a `reversal` names what it reverses, posts the opposite direction, and
-- never edits the original. A migrated legacy balance (M7, S-709) is already
-- written as a payment with lines, so it is carried the same way — the two
-- sources cannot both apply to one account because there is only one source.
--
-- One function does the carrying, for one application at a time:
-- post_opening_balances(). The backfill at the bottom calls it for every
-- application that has accounts; the application calls it whenever it opens
-- accounts (members/create.ts), records a migrated balance or a refund
-- (payments.ts), so from here on the live path is the engine and this
-- backfill is one-time. It is idempotent by construction — each line is
-- carried at most once, by a unique constraint — so calling it again is
-- free.
set local albarakah.actor_description = 'migration 0066_opening_balances';

-- ---------------------------------------------------------------------------
-- Who holds the transaction: a member or a customer (0027), exactly one
-- ---------------------------------------------------------------------------
-- 0064 assumed every account has a member. A non-member customer's HSA
-- (S-614) does not, and its opening deposit has to land somewhere.
alter table transaction
    alter column member_id drop not null,
    add column customer_id uuid references customer(id),
    add constraint transaction_has_one_holder
        check (num_nonnulls(member_id, customer_id) = 1);

create index transaction_customer_idx on transaction (customer_id, created_at)
    where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Where a carried-over transaction came from
-- ---------------------------------------------------------------------------
-- Unique: a line is carried once. That is what makes post_opening_balances()
-- safe to call twice and the backfill safe to re-run.
alter table transaction
    add column payment_line_id uuid unique references payment_line(id),
    add column payment_account_line_id uuid unique
        references payment_account_line(id),
    add constraint transaction_carries_at_most_one_line
        check (num_nonnulls(payment_line_id, payment_account_line_id) <= 1);

-- A receipt issued at posting (S-1305) is one transaction's. A receipt
-- carried from Phase 1 covers each of the lines it itemised.
alter table transaction drop constraint transaction_receipt_number_id_key;
create unique index transaction_receipt_number_idx
    on transaction (receipt_number_id)
    where receipt_number_id is not null
      and payment_line_id is null
      and payment_account_line_id is null;

-- ---------------------------------------------------------------------------
-- Reversal
-- ---------------------------------------------------------------------------
alter table transaction
    add column reverses_id uuid references transaction(id),
    drop constraint transaction_kind_check,
    add constraint transaction_kind_check
        check (kind in ('deposit', 'reversal')),
    add constraint transaction_reversal_names_its_original
        check ((kind = 'reversal') = (reverses_id is not null));

create index transaction_reverses_idx on transaction (reverses_id)
    where reverses_id is not null;

-- The identity a transaction may never change (0064) now includes the holder
-- either way, what it reverses and what it carries.
create or replace function guard_transaction()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    if tg_op = 'TRUNCATE' then
        raise exception 'transaction is append-only; TRUNCATE is not permitted'
            using errcode = 'restrict_violation';
    end if;

    if tg_op = 'DELETE' then
        if old.status <> 'draft' then
            raise exception
                'only a draft transaction can be deleted; % is %',
                old.reference, old.status
                using errcode = 'restrict_violation';
        end if;
        return old;
    end if;

    if old.status = 'posted' then
        raise exception
            'a posted transaction cannot be edited; reverse it instead (%)',
            old.reference
            using errcode = 'restrict_violation';
    end if;

    if (new.id, new.serial_no, new.kind, new.member_id, new.customer_id,
        new.captured_by, new.created_at, new.reverses_id,
        new.payment_line_id, new.payment_account_line_id)
       is distinct from
       (old.id, old.serial_no, old.kind, old.member_id, old.customer_id,
        old.captured_by, old.created_at, old.reverses_id,
        old.payment_line_id, old.payment_account_line_id) then
        raise exception
            'a transaction''s identity cannot change (%)', old.reference
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The actor a data migration posts as
-- ---------------------------------------------------------------------------
-- post_transaction() records who posted, and a posted transaction must name
-- someone (transaction_posted_is_complete). A migration is nobody, so it is
-- this: a service account in the shape 0039 set — an entra_subject no real
-- sign-in can carry, no role, no permission. Never deleted; nothing recreates
-- it (docs/runbook.md).
insert into app_user (entra_subject, email, display_name)
values ('system:migration', 'migration@system.albarakah.mu', 'Data migration')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- post_transaction(), now with reversals and carried-over entries
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

    -- Carried from a Phase 1 receipt: money that is already there. The
    -- account's status says what its holder may do next, not whether what
    -- already happened may be written down, so a carried entry posts to a
    -- pending or dormant account where a new deposit would be refused.
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
    elsif v_tx.kind = 'reversal' then
        -- The opposite of whatever the original did, on the same account,
        -- for no more than it moved. The original is not touched.
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
    'financial_event and records who did it. A reversal posts the opposite '
    'direction of what it names; an entry carried from a Phase 1 receipt '
    'posts whatever the account''s status. The application role cannot write '
    'account_entry or account_balance any other way.';

-- ---------------------------------------------------------------------------
-- post_opening_balances(): carry one application's receipts into the ledger
-- ---------------------------------------------------------------------------
-- Every unvoided payment against the application: a `shares` fee line lands
-- on the Shares account the application opened, an `msa_deposit` line on
-- the MSA, and an account line on the account of its type. Entrance,
-- processing and Takaful are the Society's income and open nothing. Then
-- every unvoided refund: each of its lines reverses the deposit its
-- original's line became. Lines already carried are skipped, so this is
-- idempotent; lines whose account is not yet open are skipped too, and
-- carried the next time it is called — which is why opening an account
-- calls it.
--
-- Invoker rights, deliberately: the application role may create transaction
-- rows and may call post_transaction(), and this does nothing it could not
-- do itself. Returns how many transactions it posted.
create or replace function post_opening_balances(
    p_application_id    uuid,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns integer
language plpgsql
set search_path = public
as $$
declare
    v_id     uuid;
    v_ids    uuid[];
    v_posted integer := 0;
begin
    -- Inserted in the order the money arrived, then posted in that order —
    -- gathered into an array first, because a data-modifying WITH cannot be
    -- the query a FOR loop iterates.
    with lines as (
            select l.id            as payment_line_id,
                   null::uuid      as payment_account_line_id,
                   p.id            as payment_id,
                   l.sort_order,
                   l.amount,
                   ty.id           as account_type_id
              from payment p
              join payment_line l on l.payment_id = p.id
              join account_type ty
                on ty.code = case l.component_code
                                 when 'shares'      then 'shares'
                                 when 'msa_deposit' then 'msa'
                             end
             where p.application_id = p_application_id
               and p.kind = 'payment'
               and p.voided_at is null
               and l.amount > 0
            union all
            select null::uuid, al.id, p.id, al.sort_order, al.amount,
                   al.account_type_id
              from payment p
              join payment_account_line al on al.payment_id = p.id
             where p.application_id = p_application_id
               and p.kind = 'payment'
               and p.voided_at is null
               and al.amount > 0
        ),
        inserted as (
            insert into transaction
                (kind, member_id, customer_id, account_id, amount,
                 method, method_reference, status, receipt_number_id,
                 captured_by, created_at,
                 payment_line_id, payment_account_line_id)
            select 'deposit', a.member_id, a.customer_id, a.id, x.amount,
                   p.method, nullif(p.method_reference, ''), 'submitted',
                   p.receipt_number_id, p.recorded_by, p.received_at,
                   x.payment_line_id, x.payment_account_line_id
              from lines x
              join payment p on p.id = x.payment_id
              join account a
                on a.opened_by_application_id = p_application_id
               and a.account_type_id = x.account_type_id
             where not exists (
                       select 1 from transaction t
                        where t.payment_line_id = x.payment_line_id
                           or t.payment_account_line_id = x.payment_account_line_id)
             order by p.received_at, x.sort_order
            returning id, created_at, serial_no
        )
        select array_agg(id order by created_at, serial_no) into v_ids from inserted;

    foreach v_id in array coalesce(v_ids, '{}'::uuid[]) loop
        perform post_transaction(v_id, p_actor_user_id, p_actor_description);
        v_posted := v_posted + 1;
    end loop;

    with inserted as (
            insert into transaction
                (kind, reverses_id, member_id, customer_id, account_id, amount,
                 method, method_reference, status, receipt_number_id,
                 captured_by, created_at, payment_line_id)
            select 'reversal', t.id, t.member_id, t.customer_id, t.account_id,
                   rl.amount, r.method, nullif(r.method_reference, ''),
                   'submitted', r.receipt_number_id, r.recorded_by,
                   r.received_at, rl.id
              from payment r
              join payment_line rl on rl.payment_id = r.id
              join payment_line ol
                on ol.payment_id = r.refunds_id
               and ol.component_code = rl.component_code
              join transaction t
                on t.payment_line_id = ol.id and t.status = 'posted'
             where r.application_id = p_application_id
               and r.kind = 'refund'
               and r.voided_at is null
               and rl.amount > 0
               and not exists (
                       select 1 from transaction x where x.payment_line_id = rl.id)
             order by r.received_at, rl.sort_order
            returning id, created_at, serial_no
        )
        select array_agg(id order by created_at, serial_no) into v_ids from inserted;

    foreach v_id in array coalesce(v_ids, '{}'::uuid[]) loop
        perform post_transaction(v_id, p_actor_user_id, p_actor_description);
        v_posted := v_posted + 1;
    end loop;

    return v_posted;
end;
$$;

comment on function post_opening_balances(uuid, uuid, text) is
    'Carries every unvoided receipt against an application into the ledger: '
    'shares and msa_deposit fee lines and account lines become deposits on '
    'the accounts the application opened, refund lines become reversals. '
    'Each line is carried at most once, so calling it again is free.';

revoke all on function post_opening_balances(uuid, uuid, text) from public;
grant execute on function post_opening_balances(uuid, uuid, text) to albarakah_app;

-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
-- Every application with an account, in the order its first receipt was
-- taken, so the ledger's posting order is the order the money arrived. The
-- system account above posts; each receipt's own recorded_by stays on the
-- transaction as who captured it.
do $$
declare
    v_actor uuid;
    v_app   uuid;
    v_total integer := 0;
begin
    select id into v_actor from app_user where entra_subject = 'system:migration';

    for v_app in
        select p.application_id
          from payment p
         where p.voided_at is null
           and p.application_id is not null
           and exists (select 1 from account a
                        where a.opened_by_application_id = p.application_id)
         group by p.application_id
         order by min(p.received_at)
    loop
        v_total := v_total
                 + post_opening_balances(v_app, v_actor,
                                         'migration 0066_opening_balances');
    end loop;

    raise notice 'opening balances: % transaction(s) posted', v_total;
end;
$$;
