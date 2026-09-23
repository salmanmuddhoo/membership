-- The Regional Manager handles applications sent from the member app (QA-24,
-- business decision).
--
-- 0044 made application.submit_online the gate on the 'received' queue and
-- left it to the business to give to someone. Nobody had it, so an
-- application sent from the app was invisible to every member of staff —
-- in the list, the badge and by direct link — until an administrator
-- found the permission under Configuration → Roles. The business wants the
-- Regional Manager to see these and to finish them: pick one up, complete
-- its details, file its documents, take the fee (cash included) and submit
-- it. Those are the Regional Officer's own permissions for the same work;
-- an administrator can still move any of them at Configuration → Roles.
set local albarakah.actor_description = 'migration 0097_regional_manager_handles_app_applications';

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code in (
         'application.submit_online',
         'application.capture',
         'application.submit',
         'document.upload',
         'payment.record',
         'cash.session'
       )
 where r.code = 'regional_manager'
on conflict do nothing;
