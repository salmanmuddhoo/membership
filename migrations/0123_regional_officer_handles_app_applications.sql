-- An application sent from the member app goes to the Regional Officer as
-- well as the Regional Manager (officer direction, October 2026).
--
-- 0044 made application.submit_online the gate on the 'received' queue —
-- an application a person sent from the phone — and 0097 gave it to the
-- Regional Manager alone, so the Regional Officers never saw one: not in
-- the Applications list, not on the badge, not under "Waiting on you". Both
-- roles now hold it, and either may pick an application up, complete it,
-- take the fee and submit it; once submitted it goes on to the next step
-- of the configured chain, as any capture does (workflow.ts). The Regional
-- Officer already holds the rest of that work (application.capture and
-- .submit, document.upload, payment.record, cash.session); the Regional
-- Manager's grant is restated so the pair holds even where an
-- administrator had moved it. Either can still be moved at Configuration
-- -> Roles.
set local albarakah.actor_description = 'migration 0123_regional_officer_handles_app_applications';

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'application.submit_online'
 where r.code in ('regional_officer', 'regional_manager')
on conflict do nothing;
