-- Descriptions that read like the application, not like the specification.
--
-- Several seeded descriptions carried the requirement reference they came from
-- — "(FRD 7.4.2)", "FRD 7.10.6", and so on. Those citations are useful in the
-- repository, where a reader is checking the build against the document, and
-- out of place on screen, where the reader is a Regional Officer who has never
-- seen the FRD and does not need to.
--
-- The mapping from requirement to behaviour lives in the migrations, the
-- backlog and the code comments, all of which stay. Only what is displayed
-- changes.
set local albarakah.actor_description = 'migration 0012_plain_language_descriptions';

update role set description = 'Meets applicants at regional level, captures the application, prints and uploads the signed form, and records the payment receipt.'
 where code = 'regional_officer';
update role set description = 'Oversees regional office operations, and may review or return applications before they are submitted centrally.'
 where code = 'regional_manager';
update role set description = 'Reviews submitted applications centrally, checking that they are complete before they reach the President.'
 where code = 'secretary';
update role set description = 'Gives the final approval or rejection on a membership application.'
 where code = 'president';

update membership_type set description = 'A natural person applying in their own name.'
 where code = 'individual';
update membership_type set description = 'A registered entity applying through its authorised representatives.'
 where code = 'corporate';
update membership_type set description = 'An applicant under the age of majority, with a parent or guardian.'
 where code = 'minor';

update fee_schedule set description = 'Collected when an individual application is captured.'
 where code = 'individual_membership';
update fee_schedule set description = 'Collected when a minor application is captured. No account deposit is taken at application time.'
 where code = 'minor_membership';

update document_checklist set description = 'Adds the guardian and the Takaful beneficiary alongside the applicant and nominee.'
 where code = 'minor_kyc';

update document_type set description = 'The scanned application form, carrying all four signatures.'
 where code = 'signed_form';

update workflow_status set description = 'Sent back to the originating staff with a comment saying what needs correcting.'
 where code = 'returned' and entity_type = 'membership_application';
