-- Seed the roles the access control layer itself depends on.
--
-- Only system_administrator is seeded. It is the role that may reach a route
-- which declares no permission of its own (see src/lib/access/authorise.ts), so
-- without it a freshly deployed system has nobody who can reach a newly added
-- page. Business roles — Officer, Secretary, President, Director — belong with
-- the modules that define what they may do, not here.

insert into role (code, name, description, is_system)
values (
    'system_administrator',
    'System Administrator',
    'May reach routes that declare no permission of their own. Intended for a '
    'small number of holders; it does NOT bypass a permission a route does '
    'declare.',
    true
)
on conflict (code) do nothing;
