-- The roles' default permissions, as the Society set them on Test and
-- exported from Configuration -> Export (officer direction, 13 October
-- 2026). Each of these ten roles holds exactly the permissions listed
-- below — what is missing is taken away, what is new is granted — so a
-- fresh database and a reset one start from the same roles as Test.
-- A role not named here is left as it is. Administrators still change any
-- of it in Configuration -> Roles afterwards.
set local albarakah.actor_description =
    'migration 0129_default_role_permissions';

create temporary table default_role_permission (
    role_code       text not null,
    permission_code text not null
) on commit drop;

insert into default_role_permission (role_code, permission_code)
values
    ('account_officer', 'account.view'),
    ('account_officer', 'cash.session'),
    ('account_officer', 'member.reactivate'),
    ('account_officer', 'member.view'),
    ('account_officer', 'statement.send'),
    ('account_officer', 'transaction.approve'),
    ('account_officer', 'transaction.capture'),
    ('account_officer', 'transaction.record_app_deposit'),
    ('account_officer', 'transaction.view'),
    ('account_officer', 'transaction.view_all'),
    ('auditor', 'account.view'),
    ('auditor', 'audit.view'),
    ('auditor', 'bank_account.view'),
    ('auditor', 'cash.view'),
    ('auditor', 'member.view'),
    ('auditor', 'payment.view'),
    ('auditor', 'transaction.view'),
    ('auditor', 'transaction.view_all'),
    ('clerk', 'account.view'),
    ('clerk', 'cash.session'),
    ('clerk', 'member.view'),
    ('clerk', 'transaction.capture'),
    ('clerk', 'transaction.view'),
    ('clerk', 'transaction.view_all'),
    ('president', 'account.view'),
    ('president', 'application.approve'),
    ('president', 'application.view'),
    ('president', 'bank_account.manage'),
    ('president', 'bank_account.view'),
    ('president', 'cash.view'),
    ('president', 'document.view'),
    ('president', 'member.view'),
    ('president', 'payment.record'),
    ('president', 'payment.view'),
    ('president', 'transaction.approve'),
    ('president', 'transaction.review'),
    ('president', 'transaction.view'),
    ('president', 'transaction.view_all'),
    ('regional_manager', 'account.view'),
    ('regional_manager', 'application.capture'),
    ('regional_manager', 'application.review'),
    ('regional_manager', 'application.submit'),
    ('regional_manager', 'application.submit_online'),
    ('regional_manager', 'application.view'),
    ('regional_manager', 'cash.session'),
    ('regional_manager', 'document.upload'),
    ('regional_manager', 'document.verify'),
    ('regional_manager', 'document.view'),
    ('regional_manager', 'member.convert'),
    ('regional_manager', 'member.details_verify'),
    ('regional_manager', 'member.edit_contact'),
    ('regional_manager', 'member.guardian_approve'),
    ('regional_manager', 'member.guardian_change'),
    ('regional_manager', 'member.reactivate'),
    ('regional_manager', 'member.view'),
    ('regional_manager', 'payment.record'),
    ('regional_manager', 'payment.view'),
    ('regional_manager', 'transaction.capture'),
    ('regional_manager', 'transaction.document_verify'),
    ('regional_manager', 'transaction.post'),
    ('regional_manager', 'transaction.view'),
    ('regional_manager', 'transaction.view_all'),
    ('regional_officer', 'account.view'),
    ('regional_officer', 'application.capture'),
    ('regional_officer', 'application.submit'),
    ('regional_officer', 'application.submit_online'),
    ('regional_officer', 'application.view'),
    ('regional_officer', 'cash.session'),
    ('regional_officer', 'document.upload'),
    ('regional_officer', 'document.view'),
    ('regional_officer', 'member.convert'),
    ('regional_officer', 'member.details_verify'),
    ('regional_officer', 'member.edit_contact'),
    ('regional_officer', 'member.guardian_change'),
    ('regional_officer', 'member.reactivate'),
    ('regional_officer', 'member.view'),
    ('regional_officer', 'payment.record'),
    ('regional_officer', 'payment.view'),
    ('regional_officer', 'statement.send'),
    ('regional_officer', 'transaction.capture'),
    ('regional_officer', 'transaction.post'),
    ('regional_officer', 'transaction.view'),
    ('secretary', 'account.view'),
    ('secretary', 'application.review'),
    ('secretary', 'application.view'),
    ('secretary', 'document.upload'),
    ('secretary', 'document.view'),
    ('secretary', 'member.details_verify'),
    ('secretary', 'member.guardian_approve'),
    ('secretary', 'member.reactivate'),
    ('secretary', 'member.view'),
    ('secretary', 'payment.view'),
    ('secretary', 'transaction.review'),
    ('secretary', 'transaction.view'),
    ('secretary', 'transaction.view_all'),
    ('system_administrator', 'account.view'),
    ('system_administrator', 'api.explore'),
    ('system_administrator', 'api_credential.manage'),
    ('system_administrator', 'application.view'),
    ('system_administrator', 'audit.view'),
    ('system_administrator', 'bank_account.view'),
    ('system_administrator', 'cash.session'),
    ('system_administrator', 'cash.view'),
    ('system_administrator', 'config.manage'),
    ('system_administrator', 'config.view'),
    ('system_administrator', 'document.upload'),
    ('system_administrator', 'document.view'),
    ('system_administrator', 'fee.manage'),
    ('system_administrator', 'fee.view'),
    ('system_administrator', 'member.edit_all_details'),
    ('system_administrator', 'member.reactivate'),
    ('system_administrator', 'member.view'),
    ('system_administrator', 'notification.view'),
    ('system_administrator', 'payment.view'),
    ('system_administrator', 'report.view'),
    ('system_administrator', 'retention.manage'),
    ('system_administrator', 'role.manage'),
    ('system_administrator', 'role.view'),
    ('system_administrator', 'segregation.manage'),
    ('system_administrator', 'segregation.view'),
    ('system_administrator', 'statement.send'),
    ('system_administrator', 'statement.send_all'),
    ('system_administrator', 'system.migrate_members'),
    ('system_administrator', 'system.reset_data'),
    ('system_administrator', 'transaction.view'),
    ('system_administrator', 'user.manage'),
    ('system_administrator', 'user.view'),
    ('treasurer', 'account.view'),
    ('treasurer', 'application.view'),
    ('treasurer', 'bank_account.manage'),
    ('treasurer', 'bank_account.view'),
    ('treasurer', 'cash.view'),
    ('treasurer', 'document.view'),
    ('treasurer', 'fee.manage'),
    ('treasurer', 'fee.view'),
    ('treasurer', 'member.view'),
    ('treasurer', 'payment.refund'),
    ('treasurer', 'payment.view'),
    ('treasurer', 'payment.void'),
    ('treasurer', 'receipt.reconcile'),
    ('treasurer', 'receipt.void'),
    ('treasurer', 'report.view'),
    ('treasurer', 'statement.send'),
    ('treasurer', 'statement.send_all'),
    ('treasurer', 'transaction.disburse'),
    ('treasurer', 'transaction.post'),
    ('treasurer', 'transaction.record_app_deposit'),
    ('treasurer', 'transaction.record_transfer'),
    ('treasurer', 'transaction.view'),
    ('treasurer', 'transaction.view_all')
;

-- A code that does not exist is a typo, not a permission to skip quietly.
do $$
declare
    v_missing text;
begin
    select string_agg(distinct d.permission_code, ', ') into v_missing
      from default_role_permission d
      left join permission p on p.code = d.permission_code
     where p.id is null;
    if v_missing is not null then
        raise exception 'unknown permission(s): %', v_missing;
    end if;
    select string_agg(distinct d.role_code, ', ') into v_missing
      from default_role_permission d
      left join role r on r.code = d.role_code
     where r.id is null;
    if v_missing is not null then
        raise exception 'unknown role(s): %', v_missing;
    end if;
end;
$$;

delete from role_permission rp
 using role r, permission p
 where rp.role_id = r.id
   and rp.permission_id = p.id
   and r.code in ('account_officer', 'auditor', 'clerk', 'member',
                  'president', 'regional_manager', 'regional_officer',
                  'secretary', 'system_administrator', 'treasurer')
   and not exists (
         select 1 from default_role_permission d
          where d.role_code = r.code and d.permission_code = p.code);

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from default_role_permission d
  join role r on r.code = d.role_code
  join permission p on p.code = d.permission_code
on conflict do nothing;
