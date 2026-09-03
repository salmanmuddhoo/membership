-- S-614: the non-member's own KYC pack (migration 0028) needs a signed form
-- after all.
--
-- Officer feedback, reversing 0028's own: opening an HSA or Investment
-- account for someone who is not a member still needs a signature on the
-- application — the officer could not find anywhere to print one, and had
-- nothing to hand the applicant a pen for. 0028 left `signed_form` out of
-- `non_member_kyc` on the reasoning that this flow "has no print step of its
-- own"; it does now (print.astro, widened alongside this migration to serve
-- a customer_account application the same way it already serves a
-- membership one) — so the same document type applies, filed and confirmed
-- the same way (checklistFor, documents.ts; the "Signatures confirmed
-- present on the scan" UI in customer.astro was already generic on
-- documentCode === 'signed_form', unreachable only because nothing put one
-- on the checklist).
set local albarakah.actor_description = 'migration 0030_non_member_signed_form';

insert into document_checklist_item
    (checklist_id, document_type_id, subject, requirement, sort_order)
select c.id, d.id, 'applicant', 'required', 3
  from document_checklist c, document_type d
 where c.code = 'non_member_kyc'
   and d.code = 'signed_form';
