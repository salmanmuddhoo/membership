-- Sign-in codes by WhatsApp or by email, the member's choice (member
-- direction, October 2026; docs/member-app.md, "Where the code goes").
--
-- Until now a code went to a mobile number and nothing else, so a
-- challenge, a session and an applicant's application were all keyed on
-- one. A person now picks where the code goes each time they ask for one:
--
--   * an existing member, to the mobile or to the email address on their
--     record, never to one they type, so a NIC + AB Number pair alone still
--     opens nothing;
--   * a new applicant, to the WhatsApp number or the email address they
--     type, which the code then proves is theirs.
--
-- So each of the three now holds the mobile or the email that was proven,
-- exactly one of the two.
set local albarakah.actor_description = 'migration 0124_member_codes_by_email';

-- Where this challenge's code went. Existing rows were all by phone.
alter table member_login_challenge
    add column channel text not null default 'phone'
        check (channel in ('phone', 'email')),
    add column email citext,
    alter column mobile drop not null,
    add constraint member_login_challenge_one_destination
        check ((channel = 'phone' and mobile is not null and email is null)
            or (channel = 'email' and email is not null and mobile is null));

comment on column member_login_challenge.channel is
    'Where the code went: phone (WhatsApp or SMS, as the site is set up) '
    'or email. mobile or email holds the address, the other is null.';

-- What the session proved. A member who signed in by email has no mobile
-- on it, and the reverse.
alter table member_session
    add column email citext,
    alter column mobile drop not null,
    add constraint member_session_one_proof
        check ((mobile is null) <> (email is null));

create index member_session_email_idx
    on member_session (email) where revoked_at is null;

-- An applicant who signed up by email owns their application by it, as
-- one who signed up by phone does by applicant_mobile (0039).
alter table membership_application
    add column applicant_email citext;

create index membership_application_applicant_email_idx
    on membership_application (applicant_email)
    where applicant_email is not null;

comment on column membership_application.applicant_email is
    'The email address verified by the member app session that started '
    'this application, for an applicant who signed up by email.';
