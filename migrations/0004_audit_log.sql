-- Append-only audit trail (S-105, FRD Section 10).
--
-- Two rules make this an audit log rather than a table that happens to hold
-- history:
--
--   1. Rows can be inserted but never updated or deleted. This is enforced by a
--      trigger, not only by a GRANT, so that a mistake made while connected as
--      the owner is refused as well.
--   2. Audit rows are written in the same transaction as the change they
--      describe. The application uses withTransaction() for this; the effect is
--      that a rolled-back business change takes its audit row with it, and a
--      committed one cannot lose it.

create table audit_event (
    id            bigserial   primary key,

    -- Who. Null only for actions taken by the system itself (a scheduled job),
    -- which actor_description then names.
    actor_user_id      uuid        references app_user(id),
    actor_description  text        not null,

    -- When.
    occurred_at   timestamptz not null default now(),

    -- What: 'member.approved', 'config.changed', and so on.
    action        text        not null,

    -- Which record. entity_id is text rather than uuid so the log can cover
    -- tables that key on something else.
    entity_type   text        not null,
    entity_id     text        not null,

    -- Before and after. Null previous_value marks a creation; null new_value
    -- marks a deletion.
    previous_value jsonb,
    new_value      jsonb,

    -- Request context, for reconstructing a sequence of actions.
    request_id    text,
    ip_address    inet,

    constraint audit_event_actor_is_named
        check (actor_user_id is not null or actor_description <> '')
);

create index audit_event_entity_idx
    on audit_event (entity_type, entity_id, occurred_at desc);
create index audit_event_actor_idx
    on audit_event (actor_user_id, occurred_at desc);
create index audit_event_occurred_at_idx
    on audit_event (occurred_at desc);

create or replace function reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'audit_event is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger audit_event_no_update
    before update on audit_event
    for each row execute function reject_audit_mutation();

create trigger audit_event_no_delete
    before delete on audit_event
    for each row execute function reject_audit_mutation();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own statement
-- level guard.
create trigger audit_event_no_truncate
    before truncate on audit_event
    for each statement execute function reject_audit_mutation();
