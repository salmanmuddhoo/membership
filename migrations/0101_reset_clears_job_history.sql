-- "Reset test data" leaves the database as a fresh install would, except
-- for its configuration (officer request: erase all activity and
-- operations, keep the configuration).
--
-- 0094's reset already cleared every member, application, document,
-- payment, transaction, receipt, message, member session and audit row
-- (sign-ins included). It left two traces of activity behind: the history
-- of every scheduled job run (job_run, and its numbering), and when each
-- API credential was last used. Both go now. The credentials themselves,
-- like staff accounts, roles, settings and their change history, stay —
-- they are how the system is set up, not what was done with it.
--
-- reset.test.ts holds the list of which tables are cleared and which are
-- kept, and fails when a table is added without being placed on one.
set local albarakah.actor_description = 'migration 0101_reset_clears_job_history';

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
        cash_session,
        notification,
        rate_limit_window,
        audit_event,
        job_run
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

    update api_credential set last_used_at = null where last_used_at is not null;

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
