-- "Reset test data" clears everything officers entered or did (officer
-- feedback), not only most of it.
--
-- 0084's reset truncated the application, receipt, folder, cash-drawer and
-- audit roots with cascade — which reaches members, accounts, the ledger,
-- transactions, payments and documents — but left the notification log
-- (every email and WhatsApp sent) standing, and restarted only three of the
-- numbering sequences: after a reset the next transaction was still
-- TXN-…-000045, the next transfer and ledger entry numbered on from before.
-- Configuration (types, fees, checklists, workflows, the matrix, bank
-- accounts, templates), staff accounts, roles and job history stay: this is
-- a test environment emptied, not the system that runs it reinstalled.
set local albarakah.actor_description = 'migration 0094_reset_everything_officers_did';

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
        audit_event
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
