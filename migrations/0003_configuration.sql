-- Configuration as data (S-104, AD-05).
--
-- Business values the FRD leaves open — the processing fee, the dormancy
-- threshold, nominee limits — must change without a release. Every entry is
-- typed and versioned, and the previous value stays readable.

create table config_entry (
    id          uuid        primary key default gen_random_uuid(),
    -- Dotted key, e.g. 'membership.processing_fee'.
    key         text        not null unique,
    value       jsonb       not null,
    -- Declares how the value should be read, so a caller asking for a number
    -- fails loudly against a string rather than coercing it.
    value_type  text        not null
        check (value_type in ('string', 'number', 'boolean', 'date', 'json')),
    description text        not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid        references app_user(id)
);

create trigger config_entry_set_updated_at
    before update on config_entry
    for each row execute function set_updated_at();

-- Every prior value, retained. Written by the trigger below rather than by the
-- application, so history cannot be skipped by writing directly to the table.
create table config_entry_history (
    id            bigserial   primary key,
    config_key    text        not null,
    value         jsonb       not null,
    value_type    text        not null,
    -- The window during which this value was in force. replaced_at is null for
    -- the row that is currently live.
    effective_at  timestamptz not null,
    replaced_at   timestamptz,
    changed_by    uuid        references app_user(id)
);

create index config_entry_history_key_idx
    on config_entry_history (config_key, effective_at desc);

-- SECURITY DEFINER: the application is deliberately denied INSERT on
-- config_entry_history so that history cannot be forged or skipped by writing
-- to the table directly. A trigger runs as the invoker by default, which would
-- mean this insert hits that same denial — so it runs as the function owner
-- instead. search_path is pinned because a SECURITY DEFINER function that
-- resolves names through the caller's search_path can be hijacked.
create or replace function record_config_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if (tg_op = 'UPDATE') then
        -- Close the outgoing row before opening the new one.
        update config_entry_history
           set replaced_at = now()
         where config_key = old.key and replaced_at is null;
    end if;

    insert into config_entry_history
        (config_key, value, value_type, effective_at, changed_by)
    values (new.key, new.value, new.value_type, now(), new.updated_by);

    return new;
end;
$$;

create trigger config_entry_record_history
    after insert or update on config_entry
    for each row execute function record_config_history();
