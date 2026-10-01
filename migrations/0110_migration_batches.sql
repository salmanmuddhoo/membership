-- The legacy migration, run a chunk at a time and cancellable (officer
-- direction: over 4,000 members to bring in, with a progress bar while it
-- runs and a way to stop it that leaves nothing behind).
--
-- migration_batch is one upload: checked and reconciled in full before it is
-- stored, then imported a few rows per request (src/lib/migration/
-- batches.ts), so no request runs for minutes and the page can show how far
-- it has got. migration_batch_row is each row of it, the validated row as
-- it will be written, and — once imported — the member or customer it wrote
-- to and whether it created it.
--
-- cancel_migration_batch() removes what a running batch has written: every
-- member and customer it created, with their applications, accounts,
-- opening-balance payments and the ledger postings of those, and the
-- accounts and opening balances it added to records already on file. The
-- ledger, payments and receipts are append-only, so it uses the one escape
-- hatch those guards honour (0019), for its own transaction only, and only
-- over rows this batch names. Receipt numbers the batch used are kept, void,
-- so the sequence still accounts for every number. The audit log keeps what
-- happened. Details the batch changed on a record already on file stay as
-- they are: there is nothing to put back. It refuses once money has moved
-- on an imported account other than its opening balance.
set local albarakah.actor_description = 'migration 0110_migration_batches';

create table migration_batch (
    id              uuid        primary key default gen_random_uuid(),
    checksum        text        not null,
    status          text        not null default 'running'
                    check (status in ('running', 'completed', 'cancelled')),
    total_rows      integer     not null check (total_rows > 0),
    -- The migration summary (summary.ts) before the first row, so the
    -- finished batch can say what it added.
    summary_before  jsonb       not null,
    started_by      uuid        not null references app_user(id),
    started_at      timestamptz not null default now(),
    finished_by     uuid        references app_user(id),
    finished_at     timestamptz
);

-- One upload at a time.
create unique index migration_batch_one_running
    on migration_batch ((true)) where status = 'running';

create table migration_batch_row (
    batch_id        uuid        not null
                    references migration_batch(id) on delete cascade,
    ordinal         integer     not null,
    legacy_code     text        not null,
    data            jsonb       not null,
    status          text        not null default 'pending'
                    check (status in ('pending', 'importing', 'imported', 'failed')),
    message         text,
    member_no       text,
    holder_kind     text        check (holder_kind in ('member', 'customer')),
    holder_id       uuid,
    created         boolean,
    -- An application a failed row inserted before it failed.
    application_id  uuid,
    started_at      timestamptz,
    finished_at     timestamptz,
    primary key (batch_id, ordinal)
);

create index migration_batch_row_pending_idx
    on migration_batch_row (batch_id, ordinal) where status = 'pending';

comment on table migration_batch is
    'One legacy-register upload, imported a chunk at a time; cancellable '
    'while it runs (cancel_migration_batch).';
comment on table migration_batch_row is
    'Each row of a migration batch, and what importing it wrote to.';

create or replace function cancel_migration_batch(
    p_batch_id          uuid,
    p_actor_user_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_status   text;
    v_moved    text;
    v_holders  integer;
    v_accounts integer;
    v_payments integer;
begin
    select status into v_status
      from migration_batch where id = p_batch_id for update;
    if not found then
        raise exception 'That import no longer exists.'
            using errcode = 'no_data_found';
    end if;
    if p_actor_user_id is null
       or not exists (select 1 from app_user where id = p_actor_user_id) then
        raise exception 'cancel_migration_batch requires the staff account running it'
            using errcode = 'restrict_violation';
    end if;
    if v_status <> 'running' then
        raise exception 'This import is already %.', v_status
            using errcode = 'restrict_violation';
    end if;
    if exists (select 1 from migration_batch_row
                where batch_id = p_batch_id and status = 'importing') then
        raise exception 'Rows are still being imported. Try again in a moment.'
            using errcode = 'lock_not_available';
    end if;

    -- What the batch wrote to.
    create temp table cmb_holder on commit drop as
        select r.holder_kind, r.holder_id, r.created, r.started_at,
               coalesce(m.application_id, c.application_id) as application_id
          from migration_batch_row r
          left join member m
            on r.holder_kind = 'member' and m.id = r.holder_id
          left join customer c
            on r.holder_kind = 'customer' and c.id = r.holder_id
         where r.batch_id = p_batch_id and r.status = 'imported';

    -- Applications it created: those of the holders it created, and those a
    -- failed row left behind.
    create temp table cmb_application on commit drop as
        select application_id as id from cmb_holder
         where created and application_id is not null
        union
        select application_id from migration_batch_row
         where batch_id = p_batch_id and status = 'failed'
           and application_id is not null;

    -- Accounts it opened: every one of a holder it created, and on a
    -- record already on file those opened since its row began.
    create temp table cmb_account on commit drop as
        select a.id, a.account_no
          from account a
          join cmb_holder h
            on (h.holder_kind = 'member' and a.member_id = h.holder_id)
            or (h.holder_kind = 'customer' and a.customer_id = h.holder_id)
         where h.created or a.created_at >= h.started_at
        union
        select a.id, a.account_no
          from account a
         where a.opened_by_application_id in (select id from cmb_application);

    -- Opening-balance payments it recorded, the same way.
    create temp table cmb_payment on commit drop as
        select p.id, p.receipt_number_id
          from payment p
         where p.method = 'migration'
           and (p.application_id in (select id from cmb_application)
             or exists (select 1 from cmb_holder h
                         where not h.created
                           and h.application_id = p.application_id
                           and p.created_at >= h.started_at));

    -- Money that moved on those accounts since, other than the opening
    -- balances themselves, stops it: that is someone's real transaction.
    select coalesce(a.account_no, t.reference) into v_moved
      from transaction t
      join cmb_account a on a.id = t.account_id
     where t.payment_line_id is null and t.payment_account_line_id is null
     limit 1;
    if v_moved is not null then
        raise exception 'Money has moved on % since it was imported, so the import cannot be cancelled.',
            v_moved
            using errcode = 'restrict_violation';
    end if;

    create temp table cmb_transaction on commit drop as
        select t.id, t.receipt_number_id
          from transaction t
         where t.account_id in (select id from cmb_account);

    select count(*) into v_holders from cmb_holder where created;
    select count(*) into v_accounts from cmb_account;
    select count(*) into v_payments from cmb_payment;

    perform set_config('albarakah.allow_full_reset', 'true', true);

    delete from financial_event
     where transaction_id in (select id from cmb_transaction)
        or payment_id in (select id from cmb_payment);
    delete from receipt_print
     where transaction_id in (select id from cmb_transaction)
        or payment_id in (select id from cmb_payment);
    delete from account_entry
     where transaction_id in (select id from cmb_transaction);
    delete from transaction where id in (select id from cmb_transaction);
    delete from account_balance where account_id in (select id from cmb_account);
    delete from payment_account_line
     where payment_id in (select id from cmb_payment);
    delete from payment_line where payment_id in (select id from cmb_payment);
    delete from payment where id in (select id from cmb_payment);

    update receipt_number
       set state = 'void', reason = 'Migration cancelled'
     where id in (select receipt_number_id from cmb_payment
                  union select receipt_number_id from cmb_transaction)
       and state <> 'void';

    delete from account where id in (select id from cmb_account);

    delete from guardian_change
     where member_id in (select holder_id from cmb_holder
                          where created and holder_kind = 'member')
        or customer_id in (select holder_id from cmb_holder
                            where created and holder_kind = 'customer');
    delete from member
     where id in (select holder_id from cmb_holder
                   where created and holder_kind = 'member');
    delete from customer
     where id in (select holder_id from cmb_holder
                   where created and holder_kind = 'customer');

    delete from application_transition
     where application_id in (select id from cmb_application);
    delete from application_step_signoff
     where application_id in (select id from cmb_application);
    delete from membership_application
     where id in (select id from cmb_application);

    update migration_batch
       set status = 'cancelled', finished_by = p_actor_user_id,
           finished_at = now()
     where id = p_batch_id;

    return jsonb_build_object(
        'holders', v_holders, 'accounts', v_accounts, 'payments', v_payments);
end;
$$;

comment on function cancel_migration_batch(uuid, uuid) is
    'Removes what a running migration batch has written and marks it '
    'cancelled. Refuses once money has moved on an imported account.';

revoke execute on function cancel_migration_batch(uuid, uuid) from public;
grant execute on function cancel_migration_batch(uuid, uuid) to albarakah_app;

-- "Reset test data" clears batches with everything else (0106): the same
-- function, with the two new tables in its list.
create or replace function reset_all_test_data(
    p_actor_user_id     uuid,
    p_actor_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_actor_description is null or btrim(p_actor_description) = '' then
        raise exception 'reset_all_test_data requires a named actor'
            using errcode = 'restrict_violation';
    end if;
    if p_actor_user_id is null
       or not exists (select 1 from app_user where id = p_actor_user_id) then
        raise exception 'reset_all_test_data requires the staff account running it'
            using errcode = 'restrict_violation';
    end if;

    perform set_config('albarakah.allow_full_reset', 'true', true);

    truncate table
        membership_application,
        receipt_number,
        sharepoint_folder,
        cash_session,
        notification,
        rate_limit_window,
        audit_event,
        job_run,
        config_entry_history,
        statement_run,
        statement_run_item,
        migration_batch,
        migration_batch_row
    cascade;

    truncate table account_number_counter;
    alter sequence application_reference_seq restart;
    alter sequence member_number_seq restart;
    alter sequence receipt_number_seq restart;
    alter sequence transaction_reference_seq restart;
    alter sequence transfer_reference_seq restart;
    alter sequence account_entry_sequence_no_seq restart;
    alter sequence financial_event_sequence_no_seq restart;
    alter sequence transaction_transition_id_seq restart;
    alter sequence application_transition_id_seq restart;
    alter sequence audit_event_id_seq restart;
    alter sequence job_run_id_seq restart;
    alter sequence config_entry_history_id_seq restart;

    update api_credential set last_used_at = null where last_used_at is not null;

    -- Settings that name a staff member about to be removed.
    alter table config_entry disable trigger user;
    alter table fee_schedule_version disable trigger user;
    alter table notification_template disable trigger user;

    update config_entry set updated_by = null
     where updated_by is distinct from p_actor_user_id and updated_by is not null;
    update fee_schedule_version set created_by = null
     where created_by is distinct from p_actor_user_id and created_by is not null;
    update notification_template set updated_by = null
     where updated_by is distinct from p_actor_user_id and updated_by is not null;

    alter table config_entry enable trigger user;
    alter table fee_schedule_version enable trigger user;
    alter table notification_template enable trigger user;

    update api_credential set created_by = null
     where created_by is distinct from p_actor_user_id and created_by is not null;
    update api_credential set revoked_by = null
     where revoked_by is distinct from p_actor_user_id and revoked_by is not null;
    update user_role set granted_by = null
     where granted_by is distinct from p_actor_user_id and granted_by is not null;

    delete from app_user where id <> p_actor_user_id;

    insert into audit_event (
        actor_user_id, actor_description, action, entity_type, entity_id,
        new_value
    ) values (
        p_actor_user_id, p_actor_description, 'system.data_reset',
        'database', 'all',
        jsonb_build_object('reset_at', now())
    );
end;
$$;
