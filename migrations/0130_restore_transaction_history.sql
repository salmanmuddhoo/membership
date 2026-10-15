-- Restoring transaction history from the nightly backup (officer request,
-- 15 October 2026).
--
-- The nightly backup saves two files: every member with their balances
-- (the members import reads it back) and every transaction
-- (src/lib/migration/transactions-backup.ts). After a restore the members
-- import brings each account back with one opening balance — its balance
-- on the night of the backup. This puts the history back behind that
-- figure: every posted transaction, on its original date, under its
-- original TX, TR and RCT numbers, with its approval steps, so a member's
-- page and statement read as they did before.
--
-- It runs over a freshly imported environment and nothing else: the
-- ledger holds only the members import's opening balances (carried from
-- its 'migration' payments), no transfer, and no receipt number but those
-- payments'. Anything else and it refuses — history is never merged into a
-- ledger that has moved on.
--
-- What happens to each account the file names:
--
--   * Where the import carried an opening balance, it becomes the
--     account's original opening: brought to what the history opened
--     with, dated when it was, and numbered as it was (its payment line
--     and payment total follow, as set_opening_balance does, 0111). An
--     account that opened with nothing loses the import's opening.
--   * Every other posted transaction is inserted as it was, entries and
--     all — straight into the ledger, not through post_transaction(),
--     because what is being recorded already happened: its drawer is
--     gone, its approval chain already ran, its account may since have
--     closed.
--   * Each account's balance is rebuilt from its entries and must come out
--     where the import left it. If one does not, nothing stays.
--
-- Numbering: the import took TX and RCT numbers from 1; history used them
-- first. So the import's own numbers move above the highest the history
-- used (only ever numbers nobody has seen — the import just made them),
-- history takes its own, and each sequence carries on after the last. An
-- opening takes back its original TX number, and the import's receipt its
-- original RCT number where the service layer could tell which it was.
--
-- Security definer, under the escape hatch the reset and set_opening_balance
-- use (albarakah.allow_full_reset), for this function's own transaction
-- only. The service layer (src/lib/migration/history.ts) resolves accounts,
-- staff and codes and checks every account's sum before calling it.
set local albarakah.actor_description = 'migration 0130_restore_transaction_history';

create or replace function restore_transaction_history(
    p_history           jsonb,
    p_actor_user_id     uuid,
    p_actor_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_max_tx    bigint := coalesce((p_history->'max'->>'transaction')::bigint, 0);
    v_max_rct   bigint := coalesce((p_history->'max'->>'receipt')::bigint, 0);
    v_max_tr    bigint := coalesce((p_history->'max'->>'transfer')::bigint, 0);
    v_row       jsonb;
    v_t0        record;
    v_rev       record;
    v_payment   uuid;
    v_payments  uuid[] := '{}';
    v_amount    numeric(14, 2);
    v_at        timestamptz;
    v_original  uuid;
    v_balance   numeric(14, 2);
    v_count     integer;
    v_tx_count  integer := 0;
    v_entries   integer := 0;
    v_transfers integer := 0;
    v_steps     integer := 0;
    v_openings  integer := 0;
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'restore_transaction_history requires a named actor'
            using errcode = 'restrict_violation';
    end if;
    if p_actor_user_id is null
       or not exists (select 1 from app_user where id = p_actor_user_id) then
        raise exception 'restore_transaction_history requires the staff account running it'
            using errcode = 'restrict_violation';
    end if;

    -- Nothing here but the members import.
    if exists (
           select 1
             from transaction t
             left join payment_line pl on pl.id = t.payment_line_id
             left join payment_account_line pal on pal.id = t.payment_account_line_id
             left join payment p on p.id = coalesce(pl.payment_id, pal.payment_id)
            where p.id is null or p.method <> 'migration' or p.voided_at is not null)
       or exists (select 1 from transfer)
       or exists (
           select 1 from receipt_number r
            where not exists (
                select 1 from payment p
                 where p.receipt_number_id = r.id and p.method = 'migration')) then
        raise exception
            'Transactions have been recorded here since the members were imported, so history cannot be restored over them.'
            using errcode = 'restrict_violation';
    end if;

    perform set_config('albarakah.allow_full_reset', 'true', true);

    -- ---------------------------------------------------------------------
    -- 1. The import's opening balances become each account's original one.
    -- ---------------------------------------------------------------------
    create temp table restore_opening (
        transaction_id uuid primary key,
        serial_no      bigint
    ) on commit drop;

    for v_row in select value from jsonb_array_elements(p_history->'openings') loop
        select count(*) into v_count
          from transaction where account_id = (v_row->>'account_id')::uuid;
        if v_count <> 1 then
            raise exception '% has no single opening balance to restore its history over.',
                v_row->>'label'
                using errcode = 'restrict_violation';
        end if;
        select t.id, t.payment_line_id, t.payment_account_line_id,
               coalesce(pl.payment_id, pal.payment_id) as payment_id
          into v_t0
          from transaction t
          left join payment_line pl on pl.id = t.payment_line_id
          left join payment_account_line pal on pal.id = t.payment_account_line_id
         where t.account_id = (v_row->>'account_id')::uuid;

        v_payments := v_payments || v_t0.payment_id;
        v_amount := round((v_row->>'amount')::numeric, 2);
        v_at := (v_row->>'at')::timestamptz;

        if v_t0.payment_line_id is not null then
            update payment_line set amount = v_amount where id = v_t0.payment_line_id;
        else
            update payment_account_line set amount = v_amount
             where id = v_t0.payment_account_line_id;
        end if;

        if v_amount > 0 then
            update transaction
               set amount = v_amount, created_at = v_at, posted_at = v_at
             where id = v_t0.id;
            update account_entry set amount = v_amount, posted_at = v_at
             where transaction_id = v_t0.id;
            update financial_event
               set payload = payload || jsonb_build_object(
                       'amount', v_amount, 'balance_after', v_amount,
                       'posted_at', v_at),
                   occurred_at = v_at
             where transaction_id = v_t0.id
               and event_type = 'transaction.posted';
            insert into restore_opening values (v_t0.id, (v_row->>'serial')::bigint);
            v_openings := v_openings + 1;
        else
            delete from financial_event where transaction_id = v_t0.id;
            delete from receipt_print where transaction_id = v_t0.id;
            delete from account_entry where transaction_id = v_t0.id;
            delete from transaction where id = v_t0.id;
        end if;
    end loop;

    -- Each payment those lines belong to, and its recorded event, carry the
    -- new total and lines (as 0111 does).
    foreach v_payment in array coalesce(
        (select array_agg(distinct x) from unnest(v_payments) x), '{}'::uuid[])
    loop
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
    end loop;

    -- ---------------------------------------------------------------------
    -- 2. The import's numbers move above the history's. Through negatives
    --    first: a generated reference pads to six digits, so a large
    --    temporary offset would collide where a negative cannot.
    -- ---------------------------------------------------------------------
    update receipt_number set serial_no = -serial_no;
    update receipt_number r
       set serial_no = x.serial
      from jsonb_to_recordset(coalesce(p_history->'receipt_numbers', '[]'::jsonb))
           as x(receipt_id uuid, serial bigint)
     where x.receipt_id = r.id;
    with ordered as (
        select id, row_number() over (order by serial_no desc) as n
          from receipt_number where serial_no < 0)
    update receipt_number r
       set serial_no = v_max_rct + o.n
      from ordered o
     where o.id = r.id;

    update transaction set serial_no = -serial_no;
    update transaction t
       set serial_no = o.serial_no
      from restore_opening o
     where o.transaction_id = t.id and o.serial_no is not null;
    with ordered as (
        select id, row_number() over (order by serial_no desc) as n
          from transaction where serial_no < 0)
    update transaction t
       set serial_no = v_max_tx + o.n
      from ordered o
     where o.id = t.id;

    update financial_event fe
       set receipt_no = rn.receipt_no
      from payment p
      join receipt_number rn on rn.id = p.receipt_number_id
     where fe.payment_id = p.id;
    update financial_event fe
       set receipt_no = rn.receipt_no,
           payload = fe.payload || jsonb_build_object(
               'reference', t.reference, 'receipt_no', rn.receipt_no)
      from transaction t
      left join receipt_number rn on rn.id = t.receipt_number_id
     where fe.transaction_id = t.id;

    -- ---------------------------------------------------------------------
    -- 3. The history itself.
    -- ---------------------------------------------------------------------
    insert into transfer
        (serial_no, member_id, customer_id, reason, status, captured_by,
         created_at, updated_at)
    select x.serial, x.member_id, x.customer_id, x.reason, 'posted',
           x.captured_by, x.created_at, x.created_at
      from jsonb_to_recordset(p_history->'transfers') as x(
               serial bigint, member_id uuid, customer_id uuid, reason text,
               captured_by uuid, created_at timestamptz);
    get diagnostics v_transfers = row_count;

    insert into receipt_number
        (serial_no, state, reason, allocated_by, allocated_at, settled_at)
    select x.serial, x.state, x.reason, x.allocated_by, x.allocated_at,
           x.settled_at
      from jsonb_to_recordset(p_history->'receipts') as x(
               serial bigint, state text, reason text, allocated_by uuid,
               allocated_at timestamptz, settled_at timestamptz);

    create temp table restore_tx on commit drop as
    select *
      from jsonb_to_recordset(p_history->'transactions') as x(
               serial bigint, kind text, member_id uuid, customer_id uuid,
               account_id uuid, amount numeric, method text,
               method_reference text, reason text, receipt_serial bigint,
               transfer_serial bigint, leg_direction text,
               reverses_serial bigint, payee_name text, claimant_kind text,
               claimant jsonb, takaful_benefit numeric, bank_account_id uuid,
               captured_by uuid, posted_by uuid, created_at timestamptz,
               submitted_at timestamptz, posted_at timestamptz,
               direction text);

    insert into transaction
        (serial_no, kind, member_id, customer_id, account_id, amount, method,
         method_reference, reason, status, receipt_number_id, captured_by,
         posted_at, posted_by, created_at, updated_at, submitted_at,
         transfer_id, leg_direction, payee_name, claimant_kind, claimant,
         takaful_benefit, bank_account_id)
    select x.serial, x.kind, x.member_id, x.customer_id, x.account_id,
           x.amount, x.method, x.method_reference, x.reason, 'posted', rn.id,
           x.captured_by, x.posted_at, x.posted_by,
           coalesce(x.created_at, x.posted_at), x.posted_at, x.submitted_at,
           tr.id, x.leg_direction, x.payee_name, x.claimant_kind, x.claimant,
           coalesce(x.takaful_benefit, 0), x.bank_account_id
      from restore_tx x
      left join receipt_number rn on rn.serial_no = x.receipt_serial
      left join transfer tr on tr.serial_no = x.transfer_serial
     where x.reverses_serial is null
     order by x.serial;
    get diagnostics v_tx_count = row_count;

    -- A reversal names its original, which is in by now: it came earlier.
    for v_rev in
        select * from restore_tx where reverses_serial is not null order by serial
    loop
        select id into v_original from transaction where serial_no = v_rev.reverses_serial;
        if v_original is null then
            raise exception 'TX-% reverses TX-%, which is not in the file.',
                lpad(v_rev.serial::text, 6, '0'),
                lpad(v_rev.reverses_serial::text, 6, '0')
                using errcode = 'restrict_violation';
        end if;
        insert into transaction
            (serial_no, kind, reverses_id, member_id, customer_id, account_id,
             amount, method, method_reference, reason, status,
             receipt_number_id, captured_by, posted_at, posted_by, created_at,
             updated_at, submitted_at, payee_name, takaful_benefit,
             bank_account_id)
        select v_rev.serial, v_rev.kind, v_original, v_rev.member_id,
               v_rev.customer_id, v_rev.account_id, v_rev.amount, v_rev.method,
               v_rev.method_reference, v_rev.reason, 'posted', rn.id,
               v_rev.captured_by, v_rev.posted_at, v_rev.posted_by,
               coalesce(v_rev.created_at, v_rev.posted_at), v_rev.posted_at,
               v_rev.submitted_at, v_rev.payee_name,
               coalesce(v_rev.takaful_benefit, 0), v_rev.bank_account_id
          from (select 1) one
          left join receipt_number rn on rn.serial_no = v_rev.receipt_serial;
        v_tx_count := v_tx_count + 1;
    end loop;

    insert into account_entry
        (account_id, transaction_id, direction, amount, posted_at)
    select e.account_id, t.id, e.direction, e.amount, e.posted_at
      from jsonb_array_elements(p_history->'entries') with ordinality as r(value, n)
     cross join lateral jsonb_to_record(r.value) as e(
               serial bigint, account_id uuid, direction text, amount numeric,
               posted_at timestamptz)
      join transaction t on t.serial_no = e.serial
     order by r.n;
    get diagnostics v_entries = row_count;
    if v_entries <> jsonb_array_length(coalesce(p_history->'entries', '[]'::jsonb)) then
        raise exception 'Some entries in the file name a transaction that is not in it.'
            using errcode = 'restrict_violation';
    end if;

    insert into financial_event
        (event_type, transaction_id, receipt_no, payload, occurred_at)
    select 'transaction.posted', t.id, rn.receipt_no,
           jsonb_strip_nulls(jsonb_build_object(
               'reference',        t.reference,
               'kind',             t.kind,
               'reverses',         o.reference,
               'member_id',        t.member_id,
               'customer_id',      t.customer_id,
               'account_id',       t.account_id,
               'direction',        x.direction,
               'amount',           t.amount,
               'currency',         t.currency,
               'method',           t.method,
               'method_reference', t.method_reference,
               'bank_account_id',  t.bank_account_id,
               'receipt_no',       rn.receipt_no,
               'account_closed',   case when t.kind in ('closure', 'resignation', 'demise') then true end,
               'membership_ended', case when t.kind in ('resignation', 'demise') then true end,
               'takaful_benefit',  case when t.kind = 'demise' then t.takaful_benefit end,
               'claimant',         case when t.claimant_kind is not null then t.payee_name end,
               'captured_by',      t.captured_by,
               'posted_by',        t.posted_by,
               'posted_at',        t.posted_at,
               'restored',         true)),
           t.posted_at
      from restore_tx x
      join transaction t on t.serial_no = x.serial
      left join transaction o on o.id = t.reverses_id
      left join receipt_number rn on rn.id = t.receipt_number_id
     order by x.serial;

    insert into financial_event
        (event_type, transaction_id, receipt_no, payload, occurred_at)
    select 'transaction.voided', t.id, rn.receipt_no,
           jsonb_build_object(
               'reference',  t.reference,
               'kind',       t.kind,
               'account_id', t.account_id,
               'amount',     t.amount,
               'currency',   t.currency,
               'receipt_no', rn.receipt_no,
               'reason',     rn.reason,
               'restored',   true),
           coalesce(rn.settled_at, t.posted_at)
      from restore_tx x
      join transaction t on t.serial_no = x.serial
      join receipt_number rn on rn.id = t.receipt_number_id
     where rn.state = 'void'
     order by x.serial;

    insert into transaction_transition
        (transaction_id, from_status, to_status, step_code, actor_user_id,
         actor_role, comment, occurred_at)
    select t.id, x.from_status, x.to_status, x.step_code, x.actor_user_id,
           x.actor_role, x.comment, x.occurred_at
      from jsonb_array_elements(p_history->'transitions') with ordinality as r(value, n)
     cross join lateral jsonb_to_record(r.value) as x(
               serial bigint, from_status text, to_status text,
               step_code text, actor_user_id uuid, actor_role text,
               comment text, occurred_at timestamptz)
      join transaction t on t.serial_no = x.serial
     order by r.n;
    get diagnostics v_steps = row_count;

    -- Each sequence carries on after the last number either side used.
    perform setval('transaction_reference_seq',
                   greatest(v_max_tx, coalesce((select max(serial_no) from transaction), 0), 1),
                   greatest(v_max_tx, coalesce((select max(serial_no) from transaction), 0)) > 0);
    perform setval('receipt_number_seq',
                   greatest(v_max_rct, coalesce((select max(serial_no) from receipt_number), 0), 1),
                   greatest(v_max_rct, coalesce((select max(serial_no) from receipt_number), 0)) > 0);
    perform setval('transfer_reference_seq',
                   greatest(v_max_tr, coalesce((select max(serial_no) from transfer), 0), 1),
                   greatest(v_max_tr, coalesce((select max(serial_no) from transfer), 0)) > 0);

    -- ---------------------------------------------------------------------
    -- 4. Every account comes out where the import left it.
    -- ---------------------------------------------------------------------
    for v_row in select value from jsonb_array_elements(p_history->'balances') loop
        v_balance := rebuild_account_balance((v_row->>'account_id')::uuid);
        if v_balance <> round((v_row->>'balance')::numeric, 2) then
            raise exception '% would hold % after the restore, not %.',
                v_row->>'label', v_balance, round((v_row->>'balance')::numeric, 2)
                using errcode = 'restrict_violation';
        end if;
    end loop;

    insert into audit_event
        (actor_user_id, actor_description, action, entity_type, entity_id,
         new_value)
    values (p_actor_user_id, p_actor_description, 'migration.history.restored',
            'migration', coalesce(p_history->>'checksum', ''),
            jsonb_build_object(
                'transactions', v_tx_count,
                'entries',      v_entries,
                'transfers',    v_transfers,
                'approvals',    v_steps,
                'openings',     v_openings,
                'accounts',     jsonb_array_length(coalesce(p_history->'balances', '[]'::jsonb))));

    return jsonb_build_object(
        'transactions', v_tx_count,
        'entries',      v_entries,
        'transfers',    v_transfers,
        'approvals',    v_steps,
        'openings',     v_openings);
end;
$$;

comment on function restore_transaction_history(jsonb, uuid, text) is
    'Puts the transaction history from a backup behind the opening balances '
    'the members import made: original dates and TX/TR/RCT numbers, every '
    'account ending at the balance it started with. Refuses a ledger holding '
    'anything but the import.';

revoke execute on function restore_transaction_history(jsonb, uuid, text) from public;
grant execute on function restore_transaction_history(jsonb, uuid, text) to albarakah_app;
