-- "Reset test data" also removes the staff accounts and the history of
-- setting changes (officer request).
--
-- Every staff account goes except the System Administrator running the
-- reset: a staff member signs in only if their account is on file
-- (resolvePrincipal), so removing the last one would leave nobody able to
-- sign in and add the others back. Their roles go with them (user_role
-- cascades); the roles themselves, like every other setting, stay.
--
-- A kept setting can name the staff member who last changed it
-- (config_entry.updated_by, fee_schedule_version.created_by,
-- notification_template.updated_by, api_credential.created_by/revoked_by,
-- user_role.granted_by). Those are cleared before the accounts go, with the
-- tables' own triggers paused, so clearing them neither rewrites the
-- setting's "last changed" time nor writes a new history or audit row.
-- The history of setting changes (config_entry_history) is then emptied.
set local albarakah.actor_description = 'migration 0102_reset_removes_staff_and_setting_history';

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
        config_entry_history
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
