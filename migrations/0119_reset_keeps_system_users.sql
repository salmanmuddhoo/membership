-- "Reset test data" keeps the system users (officer report, October 2026).
--
-- The reset removes every staff account but the administrator running it
-- (0102). That also removed the accounts that are not staff at all: the
-- system users — 'system:member-app' (0039), which the member app captures
-- applications and transactions as; 'system:retention' (0061), the
-- disposal job; 'system:public-api' and 'system:migration'. After a reset
-- on the test environment, every application started from the phone
-- failed with "Something went wrong" — the system user it needed was
-- gone, and nothing put it back until the next migration run.
--
-- Two changes: the reset leaves any 'system:%' account alone, and the
-- four are re-seeded here, exactly as their own migrations seeded them,
-- so a database already reset gets them back now.
set local albarakah.actor_description = 'migration 0119_reset_keeps_system_users';

insert into app_user (entra_subject, email, display_name)
values
    ('system:member-app', 'member-app@system.albarakah.mu', 'Member app'),
    ('system:retention', 'retention@system.albarakah.mu', 'Retention'),
    ('system:public-api', 'public-api@system.albarakah.mu', 'Public API'),
    ('system:migration', 'migration@system.albarakah.mu', 'Data migration')
on conflict (email) do nothing;

-- The same function as 0110, with the one line changed and the re-seed
-- after it, so a reset can never leave the system without them.
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

    -- Staff go; the administrator running this and the system users stay.
    -- None of those is a person, and the member app cannot capture
    -- anything without its own.
    delete from app_user
     where id <> p_actor_user_id
       and (entra_subject is null or entra_subject not like 'system:%');

    insert into app_user (entra_subject, email, display_name)
    values
        ('system:member-app', 'member-app@system.albarakah.mu', 'Member app'),
        ('system:retention', 'retention@system.albarakah.mu', 'Retention'),
        ('system:public-api', 'public-api@system.albarakah.mu', 'Public API'),
        ('system:migration', 'migration@system.albarakah.mu', 'Data migration')
    on conflict (email) do nothing;

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
