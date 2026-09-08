-- Officer feedback: a new application for someone who already had one — an
-- existing member opening another account (S-613), or a non-member customer
-- applying to become a member (S-614) — got its own SharePoint folder, named
-- after its own reference. In the drive itself that reads as several
-- separate people, one per application, rather than the one person they
-- actually are. The idea is one folder per member or non-member customer,
-- for as long as they keep applying for things.
--
-- folder_application_id records which application's own folder this
-- application's documents actually belong in — set once, at capture
-- (capture.ts), and never touched again. Null means this application owns
-- its own folder (a founding membership application, or a non-member's
-- first customer_account application); set means "use that application's
-- folder instead" (applicationFolderPath, documents.ts, resolves through
-- it). Always points directly at the ultimate root, never at another
-- redirected application — resolved through any existing chain at the
-- moment a new application is captured, so a read here is always one hop.
set local albarakah.actor_description = 'migration 0042_application_folder';

alter table membership_application
    add column folder_application_id uuid references membership_application(id);

comment on column membership_application.folder_application_id is
    'Which application''s own SharePoint folder this application''s '
    'documents belong in (officer feedback: one folder per person, not one '
    'per application) — set once at capture, always the ultimate root '
    'rather than a chain. Null means this application owns its own folder.';

-- Backfilled for every application already captured, the same fair cutover
-- application_checklist_item (migration 0041) used: nothing already filed
-- moves in SharePoint — a document's own path was set once, at upload, and
-- this column only changes where a NEW upload against these applications
-- goes from here on — but an application that was pointing at the wrong
-- folder starts pointing at the right one for anything filed from now on.

-- 1. A membership application started from an existing customer (S-614) —
--    the customer's own customer_account application. Run before (2) below,
--    so a member whose OWN founding application came from a customer this
--    way already has its true root by the time (2) reads it.
update membership_application a
   set folder_application_id = c.application_id
  from customer c
 where a.source_customer_id = c.id
   and a.folder_application_id is null;

-- 2. An additional_account application (S-613) — the member's own founding
--    application, resolved through whatever (1) just set on it, so this
--    always lands on the ultimate root rather than a two-hop chain. Null
--    for a legacy M7 member with no founding application at all: nothing
--    to redirect to, so this application keeps its own folder.
update membership_application a
   set folder_application_id = coalesce(root.folder_application_id, root.id)
  from member m
  join membership_application root on root.id = m.application_id
 where a.existing_member_id = m.id
   and a.application_kind = 'additional_account'
   and a.folder_application_id is null;
