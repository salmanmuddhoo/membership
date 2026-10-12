-- The Society's own roles cannot be deleted (officer direction, October
-- 2026): Regional Officer, Regional Manager, Secretary, President,
-- Treasurer, System Administrator, Member, Clerk and Auditor. The workflow,
-- the matrix and the defaults of every migration name them by code, so
-- deleting one would leave steps nobody can act on. They become system
-- roles, which deleteRole refuses and Configuration -> Roles offers no
-- Delete for; their permissions can still be changed. A role an
-- administrator adds stays deletable.
set local albarakah.actor_description =
    'migration 0128_core_roles_cannot_be_deleted';

update role
   set is_system = true
 where code in (
         'regional_officer', 'regional_manager', 'secretary', 'president',
         'treasurer', 'system_administrator', 'member', 'clerk', 'auditor'
       )
   and not is_system;
