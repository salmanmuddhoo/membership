-- An application's documents are verified by the Regional Manager, not the
-- Secretary; the papers filed against a closure, a resignation or a demised
-- claim stay with the Secretary (officer direction, October 2026).
--
-- The Regional Manager checks an application's papers while it is with
-- them — including one whose fees are still on their way by transfer from
-- a member, which the Secretary does not touch until the Treasurer has
-- disbursed it. Until now one permission, document.verify, covered both
-- kinds of paper, so they could not go to different roles. The exit papers
-- get their own, transaction.document_verify, given to every role that
-- verified documents until now; document.verify then moves from the
-- Secretary to the Regional Manager. Either moves again in
-- Configuration -> Roles.
set local albarakah.actor_description =
    'migration 0127_regional_manager_verifies_documents';

insert into permission (code, description) values
    ('transaction.document_verify',
     'Verify or reject the papers filed against a closure, a resignation or a demised claim')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select rp.role_id, p.id
  from role_permission rp
  join permission held on held.id = rp.permission_id
                      and held.code = 'document.verify'
  join permission p on p.code = 'transaction.document_verify'
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'document.verify'
 where r.code = 'regional_manager'
on conflict do nothing;

delete from role_permission rp
 using role r, permission p
 where rp.role_id = r.id
   and rp.permission_id = p.id
   and r.code = 'secretary'
   and p.code = 'document.verify';
