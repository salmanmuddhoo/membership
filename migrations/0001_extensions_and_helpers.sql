-- Extensions and shared helpers.
--
-- Kept as the first migration so later migrations can rely on them. Both are
-- available on Azure Database for PostgreSQL Flexible Server, but must be
-- allow-listed on the server first (azure.extensions), which is why they are
-- created here rather than assumed.

-- gen_random_uuid() for primary keys.
create extension if not exists "pgcrypto";

-- Case-insensitive text, used for email addresses so that two users cannot be
-- created whose addresses differ only in case.
create extension if not exists "citext";

-- Keeps updated_at honest without the application having to remember.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
