-- Least-privilege grants for the application role.
--
-- The application connects as a role that can read and write rows but cannot
-- change the schema. Migrations run as the owner. The separation is what stops
-- an application-level SQL injection from becoming a schema-level one.
--
-- The role name is fixed here rather than parameterised because a migration
-- must produce the same schema everywhere it runs. Create the role before
-- migrating (scripts/dev-db.sh does this locally; docs/database.md gives the
-- Azure statement).

do $$
begin
    if not exists (select from pg_roles where rolname = 'albarakah_app') then
        raise exception
            'Role albarakah_app does not exist. Create it before migrating '
            '(see docs/database.md).';
    end if;
end
$$;

grant usage on schema public to albarakah_app;

-- Existing tables.
grant select, insert, update, delete on all tables in schema public
    to albarakah_app;
grant usage, select on all sequences in schema public to albarakah_app;

-- Tables added by later migrations, which run as the owner.
alter default privileges for role current_user in schema public
    grant select, insert, update, delete on tables to albarakah_app;
alter default privileges for role current_user in schema public
    grant usage, select on sequences to albarakah_app;

-- The audit log is append-only for the application too. The trigger in
-- migration 0004 refuses updates and deletes regardless; revoking the privilege
-- as well means the attempt fails at the permission check, before any row is
-- touched.
revoke update, delete on audit_event from albarakah_app;

-- Configuration history is written by a trigger, never by the application.
revoke insert, update, delete on config_entry_history from albarakah_app;

-- The migration ledger is the runner's, not the application's.
revoke insert, update, delete on schema_migrations from albarakah_app;
