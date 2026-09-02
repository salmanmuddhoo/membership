-- A System Administrator's ability to wipe a test environment back to empty.
--
-- audit_event, application_transition, receipt_number, payment, payment_line,
-- receipt_print and financial_event are all deliberately permanent: each
-- refuses UPDATE/DELETE/TRUNCATE unconditionally, by trigger, so that nothing
-- — a bug, a mistake connected as the owner, a caller with the right SQL —
-- can quietly erase them. That is exactly right in production and exactly
-- wrong for a test environment, which exists to be thrown away and started
-- over.
--
-- Rather than removing that protection, this adds one narrow, named escape
-- hatch: a transaction-scoped flag every one of those guards now checks
-- first, set only inside reset_all_test_data() below for the duration of its
-- own transaction. The flag cannot outlive that transaction (set_config's
-- third argument scopes it there) and nothing else sets it, so no other
-- statement on the connection — before or after — is ever affected.
set local albarakah.actor_description = 'migration 0019_test_data_reset';

create or replace function albarakah_reset_in_progress()
returns boolean
language sql
stable
as $$
    select coalesce(current_setting('albarakah.allow_full_reset', true), '')
           = 'true';
$$;

comment on function albarakah_reset_in_progress() is
    'True only inside the transaction reset_all_test_data() is running, for '
    'exactly as long as that function''s own work takes. Every append-only '
    'guard in the schema checks this before refusing a mutation.';

-- ---------------------------------------------------------------------------
-- Relax each append-only guard the same way: check the flag first, and only
-- fall through to the existing refusal when it is not set. What each one
-- refuses in the ordinary case — every case but the one below — is unchanged.
-- ---------------------------------------------------------------------------

create or replace function reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception
        'audit_event is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create or replace function reject_transition_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception
        'application_transition is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create or replace function guard_receipt_number()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    if tg_op in ('DELETE', 'TRUNCATE') then
        raise exception
            'receipt_number is a ledger; % is not permitted', tg_op
            using errcode = 'restrict_violation';
    end if;

    if new.serial_no <> old.serial_no then
        raise exception 'a receipt number cannot be changed once allocated'
            using errcode = 'restrict_violation';
    end if;

    if old.state <> new.state
       and not (old.state = 'allocated'
                and new.state in ('issued', 'abandoned', 'void'))
       and not (old.state = 'issued' and new.state = 'void') then
        raise exception 'receipt % cannot go from % to %',
            old.receipt_no, old.state, new.state
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

create or replace function guard_payment()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    if tg_op in ('DELETE', 'TRUNCATE') then
        raise exception 'payment is append-only; % is not permitted', tg_op
            using errcode = 'restrict_violation';
    end if;

    if old.voided_at is not null then
        raise exception 'receipt already voided; it cannot be changed again'
            using errcode = 'restrict_violation';
    end if;

    if (new.receipt_number_id, new.kind, new.refunds_id, new.application_id,
        new.member_id, new.fee_version_id, new.method, new.method_reference,
        new.currency, new.total_amount, new.variance_reason, new.received_at,
        new.recorded_by, new.created_at)
       is distinct from
       (old.receipt_number_id, old.kind, old.refunds_id, old.application_id,
        old.member_id, old.fee_version_id, old.method, old.method_reference,
        old.currency, old.total_amount, old.variance_reason, old.received_at,
        old.recorded_by, old.created_at) then
        raise exception 'a recorded payment cannot be edited; void it instead'
            using errcode = 'restrict_violation';
    end if;

    return new;
end;
$$;

create or replace function reject_payment_line_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception 'payment_line is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create or replace function reject_receipt_print_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception 'receipt_print is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create or replace function reject_financial_event_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception 'financial_event is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- The reset itself.
-- ---------------------------------------------------------------------------
-- security definer: the application's own role (albarakah_app) deliberately
-- has no truncate privilege anywhere, and has had update/delete on audit_event
-- specifically revoked (0005) so that a mistake fails at the permission
-- check before a trigger is even reached. This function runs as the schema
-- owner instead, which is what a bare TRUNCATE needs — the guard relaxation
-- above is still what makes the append-only tables permit it.
--
-- membership_application, receipt_number, sharepoint_folder and audit_event
-- are the only tables named directly; cascade empties everything that points
-- at them, which is the whole of what a member or an application touches:
-- application_party, application_transition, document, document_version,
-- member, account, payment, payment_line, receipt_print and financial_event.
-- Staff accounts, roles and permissions, and reference configuration
-- (membership types, fee schedules, the document checklist, workflow steps)
-- are untouched — nothing points from them at what this empties, only the
-- other way round.
--
-- Sequences (application/member/account/receipt numbers) are NOT reset:
-- restarting them would hand a fresh application the same reference — and so
-- the same SharePoint folder path — as a deleted one whose files this cannot
-- reach to remove.
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

    perform set_config('albarakah.allow_full_reset', 'true', true);

    truncate table
        membership_application,
        receipt_number,
        sharepoint_folder,
        audit_event
    cascade;

    -- The one thing this must never fail to explain: audit_event is empty
    -- the instant after the truncate above, and this is the first row back in
    -- it, so the log that survives every reset always says who ran the last
    -- one and when.
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

comment on function reset_all_test_data(uuid, text) is
    'Test-environment only. Permanently deletes every member, application, '
    'document, payment and receipt, and their permanent history, in one '
    'transaction. Called only from resetAllTestData() '
    '(src/lib/admin/reset.ts), which refuses outright unless PUBLIC_APP_ENV '
    'marks this deployment as non-production, before this ever runs.';

revoke all on function reset_all_test_data(uuid, text) from public;
grant execute on function reset_all_test_data(uuid, text) to albarakah_app;

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------
insert into permission (code, description) values
    ('system.reset_data',
     'Permanently delete every member, application, document, payment and '
     'receipt in the database, on a test environment only')
on conflict (code) do nothing;

-- The one exception to "the System Administrator gets to look, and nothing
-- more" (0011, 0017): this is not running the Society's business, it is
-- administering the test copy of the system, which is what the role exists
-- for.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'system.reset_data'
 where r.code = 'system_administrator'
on conflict do nothing;
