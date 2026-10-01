-- The two witnesses to an application form, by name (officer request).
--
-- Witnesses no longer sign the form, and the nominee never needed to; what
-- matters is who witnessed it, and that is kept with the application rather
-- than only in the filed PDF, so the reviewers and the member's page can
-- read it. Null until the officer types them on the form step; an
-- application is not submitted without both (submitApplication).
alter table membership_application
    add column witness_1_name text,
    add column witness_2_name text;
