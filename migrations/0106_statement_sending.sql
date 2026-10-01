-- A member's statement as a PDF, by email or WhatsApp, to one member or to
-- everyone at once (officer request).
--
-- One statement covers every account the holder has for a period: the
-- same figures as each account's own statement (/accounts/{id}/statement),
-- typeset one account after another (src/lib/ledger/member-statement.ts).
-- It travels the way a receipt does: a signed, expiring link in the
-- wording, and the PDF itself attached where the wording says so.
--
-- Sending to everyone is too long for a web request, so a request to do
-- it is recorded here (statement_run) and the statement-send job works
-- through the holders, recording each one it has dealt with
-- (statement_run_item) so a run that is stopped and resumed never sends
-- anyone their statement twice.
set local albarakah.actor_description = 'migration 0106_statement_sending';

insert into permission (code, description) values
    ('statement.send',
     'Send one member or non-member their statement by email or WhatsApp'),
    ('statement.send_all',
     'Send every member and non-member their statement at once')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('account_officer',      'statement.send'),
    ('regional_officer',     'statement.send'),
    ('treasurer',            'statement.send'),
    ('treasurer',            'statement.send_all'),
    ('system_administrator', 'statement.send'),
    ('system_administrator', 'statement.send_all')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

-- The wording. The email carries the PDF; the WhatsApp message carries
-- the link, and the PDF too once the Society has registered a template
-- with a document header and switched it on (as for receipts, 0089).
insert into notification_template
    (event_code, channel, subject, body, description, attaches_document)
values
    ('statement.issued', 'email',
     'Your Al Barakah statement, {{period}}',
     E'Assalamoualaikoum {{member_name}},\n\n'
     || E'Your statement for {{period}} is attached. It covers '
     || E'{{accounts}}.\n\n'
     || E'You can also open it here:\n{{link}}\n\n'
     || 'Al Barakah MCSL',
     'Sent with a member''s statement, one at a time or to everyone at once.',
     true),

    ('statement.issued', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your Al Barakah statement for '
     '{{period}} ({{accounts}}): {{link}}',
     'Sent with a member''s statement, one at a time or to everyone at once.',
     false)
on conflict (event_code, channel) do nothing;

create table statement_run (
    id           uuid        primary key default gen_random_uuid(),
    period_from  date        not null,
    period_to    date        not null,
    requested_by uuid        references app_user(id) on delete set null,
    requested_at timestamptz not null default now(),
    -- queued until the job picks it up, sending while it works through the
    -- holders, done once every one has been dealt with.
    status       text        not null default 'queued'
                 check (status in ('queued', 'sending', 'done')),
    finished_at  timestamptz,
    constraint statement_run_period check (period_from <= period_to),
    constraint statement_run_done_is_dated
        check ((status = 'done') = (finished_at is not null))
);

-- One run at a time waiting or going: a second press of the button, or two
-- officers at once, would otherwise send everyone two statements.
create unique index statement_run_one_open_idx
    on statement_run ((true))
 where status in ('queued', 'sending');

create table statement_run_item (
    run_id      uuid        not null
                references statement_run(id) on delete cascade,
    holder_kind text        not null check (holder_kind in ('member', 'customer')),
    holder_id   uuid        not null,
    -- sent: at least one message went; no_contact: no email or mobile on
    -- file; no_accounts: no account open in the period (opened after it);
    -- failed: nothing could be sent (the delivery log says why).
    outcome     text        not null
                check (outcome in ('sent', 'no_contact', 'no_accounts',
                                   'failed')),
    sent_at     timestamptz not null default now(),
    primary key (run_id, holder_id)
);

comment on table statement_run is
    'A request to send every holder their statement for a period, worked '
    'through by the statement-send job.';
comment on table statement_run_item is
    'Each holder a statement run has dealt with, so a resumed run never '
    'sends twice.';

-- "Reset test data" clears runs with everything else that was done
-- (0101, 0102): the same function, with the two new tables in its list.
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
        statement_run_item
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
