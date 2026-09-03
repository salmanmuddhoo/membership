-- S-614: the KYC pack a non-member applicant must provide, configurable
-- separately from what a MEMBER of the same type must provide.
--
-- Officer feedback: opening an HSA or Investment account for someone who is
-- not a member does not need everything Individual's own membership
-- checklist (checklist_id, migration 0010) asks for — that pack includes a
-- nominee's own ID card and the signed application form, neither of which
-- means anything to a non-member application (it has no print step of its
-- own, and a nominee document requirement inherited from a form the
-- applicant never fills in was never a deliberate choice, only an accident
-- of reusing Individual's field configuration for capture — S-614 phase 2 —
-- and its document configuration for the same reason, phase 3).
--
-- A second, independent checklist reference fixes that: membership_type
-- keeps checklist_id for what a MEMBER of this type must provide, and gains
-- non_member_checklist_id for what a non-member applicant must provide when
-- this type backs a customer_account application (currently always
-- Individual — capture.ts's own hardcoded choice, a business decision, not
-- something this column makes configurable). Both nullable, both set
-- independently, the same way checklist_id and fee_schedule_id already are.
set local albarakah.actor_description = 'migration 0028_non_member_checklist';

alter table membership_type
    add column non_member_checklist_id uuid references document_checklist(id);

comment on column membership_type.non_member_checklist_id is
    'What a NON-MEMBER applicant must provide to open an account of their '
    'own (S-614) — independent of checklist_id, which is what a MEMBER of '
    'this type must provide. Only meaningful for whichever type '
    'startCustomerAccountApplication captures against (capture.ts); not '
    'itself a choice this column exposes.';

-- A starting pack for Individual specifically, since nothing before this
-- migration could set one at all — leaving it null would mean a non-member
-- applicant's own identity goes entirely unchecked until an administrator
-- notices and configures one. Deliberately smaller than individual_kyc:
-- proof of identity and address, nothing tied to a nominee or to a printed
-- form this flow does not use.
insert into document_checklist (code, name, description) values
    ('non_member_kyc', 'Non-member applicant',
     'What someone who is not a member must provide to open an account of '
     'their own (S-614) — independent of what a MEMBER of the same type '
     'must provide.');

insert into document_checklist_item
    (checklist_id, document_type_id, subject, requirement, sort_order)
select c.id, d.id, v.subject, v.requirement, v.sort_order
  from (values
    ('non_member_kyc', 'id_card',      'applicant', 'required', 1),
    ('non_member_kyc', 'utility_bill', 'applicant', 'required', 2)
  ) as v(checklist_code, document_code, subject, requirement, sort_order)
  join document_checklist c on c.code = v.checklist_code
  join document_type d      on d.code = v.document_code;

update membership_type
   set non_member_checklist_id =
         (select id from document_checklist where code = 'non_member_kyc')
 where code = 'individual';
