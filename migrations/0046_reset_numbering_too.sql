-- Officer feedback: resetting the test data left every reference number
-- picking up where the deleted rows left off — a fresh test member still
-- came out AB0047, not AB0001, because reset_all_test_data() (migration
-- 0019) deliberately never restarted application_reference_seq,
-- member_number_seq, receipt_number_seq or account_number_counter.
--
-- That caution was about production, where a member's number is on their
-- card and in the legacy register (migration 0018) — reusing one there
-- would be a real collision, which is exactly what M7's import advancing
-- the sequence past the legacy register (FRD 7.5) is for. None of that
-- applies to a test database this function refuses to run against outside
-- PUBLIC_APP_ENV != production in the first place (reset.ts): restarting a
-- sequence in a copy about to be thrown away collides with nothing.
--
-- The one real cost restarting still has — a reused AB0001 landing in the
-- same SharePoint test-site folder as a previous run's, since this only
-- ever touched the database (see 0019's own comment) — is the officer's
-- to accept for a faster reset than to have the function silently avoid.
set local albarakah.actor_description = 'migration 0046_reset_numbering_too';

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

    truncate table account_number_counter;
    alter sequence application_reference_seq restart;
    alter sequence member_number_seq restart;
    alter sequence receipt_number_seq restart;

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
    'document, payment and receipt, and their permanent history, and '
    'restarts every reference-number sequence (application, member, '
    'receipt, customer account), in one transaction. Called only from '
    'resetAllTestData() (src/lib/admin/reset.ts), which refuses outright '
    'unless PUBLIC_APP_ENV marks this deployment as non-production, before '
    'this ever runs.';
