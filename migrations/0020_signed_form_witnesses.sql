-- S-603: two attesting witnesses confirmed present before the signed form
-- can be marked Verified (FRD 5.4).
--
-- The printed form always carries four signature blocks — Applicant,
-- Nominee, Witness 1, Witness 2 (print.astro's own SIGNATURES constant,
-- shared with documents.ts so the two can never disagree) — regardless of
-- membership type, so this is a fixed, universal check rather than
-- something configuration decides.
set local albarakah.actor_description = 'migration 0020_signed_form_witnesses';

alter table document
    add column confirmed_signatures text[] not null default '{}';

comment on column document.confirmed_signatures is
    'Which of the four signatures on the printed form (Applicant, Nominee, '
    'Witness 1, Witness 2) the reviewer confirmed are present on the scan. '
    'Only meaningful for the signed_form document type — every other row '
    'leaves it empty. reviewDocument() (documents.ts) refuses to mark a '
    'signed_form Verified until all four are named here.';
