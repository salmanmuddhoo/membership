-- S-614: Corporate and Minor non-member applicants have no KYC pack of
-- their own.
--
-- Functional test round: 0028 gave Individual a non_member_checklist_id
-- (non_member_kyc) but left Corporate and Minor's own column null —
-- capture.ts is not actually restricted to Individual, it captures against
-- whichever membership type is selected, so a Corporate or Minor
-- customer_account application asks for no documents at all, and because
-- neither checklist has a signed_form item, the signed application form
-- never counts and the application's timeline never marks the signature
-- step done.
--
-- Two more checklists, following 0028's own reasoning: each is smaller than
-- the matching MEMBER checklist (checklist_id) — the pieces that only mean
-- something to a member of this type left out, nothing else changed.
set local albarakah.actor_description = 'migration 0108_non_member_checklists';

-- Corporate: corporate_kyc (migration 0010) without the nominee's own ID
-- card, as non_member_kyc leaves the nominee's out of individual_kyc.
insert into document_checklist (code, name, description) values
    ('non_member_corporate_kyc', 'Non-member corporate applicant',
     'What a corporate applicant who is not a member must provide to open '
     'an account of their own (S-614) — independent of what a MEMBER '
     'corporate applicant must provide.')
on conflict (code) do nothing;

insert into document_checklist_item
    (checklist_id, document_type_id, subject, requirement, sort_order)
select c.id, d.id, v.subject, v.requirement, v.sort_order
  from (values
    ('non_member_corporate_kyc', 'signed_form',        'applicant', 'required', 1),
    ('non_member_corporate_kyc', 'cert_registration',   'applicant', 'required', 2),
    ('non_member_corporate_kyc', 'memorandum',          'applicant', 'required', 3),
    ('non_member_corporate_kyc', 'written_resolution',  'applicant', 'required', 4),
    ('non_member_corporate_kyc', 'utility_bill',        'applicant', 'required', 5)
  ) as v(checklist_code, document_code, subject, requirement, sort_order)
  join document_checklist c on c.code = v.checklist_code
  join document_type d      on d.code = v.document_code
on conflict (checklist_id, document_type_id, subject) do nothing;

-- Minor: birth certificate and signature from the applicant, identity and
-- address from the guardian standing in for them — minor_kyc's own shape
-- (migration 0010) without the nominee's and beneficiary's own ID cards.
insert into document_checklist (code, name, description) values
    ('non_member_minor_kyc', 'Non-member minor applicant',
     'What a minor applicant who is not a member must provide to open an '
     'account of their own (S-614) — independent of what a MEMBER minor '
     'applicant must provide.')
on conflict (code) do nothing;

insert into document_checklist_item
    (checklist_id, document_type_id, subject, requirement, sort_order)
select c.id, d.id, v.subject, v.requirement, v.sort_order
  from (values
    ('non_member_minor_kyc', 'signed_form',       'applicant', 'required', 1),
    ('non_member_minor_kyc', 'birth_certificate', 'applicant', 'required', 2),
    ('non_member_minor_kyc', 'id_card',           'guardian',  'required', 3),
    ('non_member_minor_kyc', 'utility_bill',      'guardian',  'required', 4)
  ) as v(checklist_code, document_code, subject, requirement, sort_order)
  join document_checklist c on c.code = v.checklist_code
  join document_type d      on d.code = v.document_code
on conflict (checklist_id, document_type_id, subject) do nothing;

-- Only where still null: an administrator may already have set one by hand
-- from Configuration -> Membership types, the same reasoning 0030 applied
-- to non_member_kyc's own signed_form row.
update membership_type
   set non_member_checklist_id =
         (select id from document_checklist where code = 'non_member_corporate_kyc')
 where code = 'corporate'
   and non_member_checklist_id is null;

update membership_type
   set non_member_checklist_id =
         (select id from document_checklist where code = 'non_member_minor_kyc')
 where code = 'minor'
   and non_member_checklist_id is null;
