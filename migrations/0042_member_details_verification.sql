-- The staff side of a member's own details update (docs/member-app.md).
--
-- Migration 0039 gave a member a way to say what has changed from the app,
-- and put it in member_details_request for staff to verify. Nothing could
-- act on one: the request sat there, and the member saw "pending" forever.
-- This is the permission that lets someone act, and the columns that record
-- what they decided.
--
-- Verifying a change is the same judgement as verifying a document — is
-- this new address the one on the utility bill they filed? — so it starts
-- with the Secretary, the role that already holds document.verify. It is
-- its own permission rather than riding on that one: a Society that wants
-- the Registrar or a Regional Manager doing this moves it in
-- Configuration -> Roles without touching document verification.
set local albarakah.actor_description = 'migration 0042_member_details_verification';

insert into permission (code, description) values
    ('member.details_verify',
     'Apply or decline a details update a member sent from the member app')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code = 'member.details_verify'
 where r.code = 'secretary'
on conflict do nothing;

-- What the record held when the request was made.
--
-- Applying writes the member's proposed values over application_party,
-- which is where a member's details actually live (the member row carries
-- none of its own). That write has no history of its own — application_party
-- is updated in place, exactly as capture updates it — so without this the
-- previous values would be gone the moment a request was applied, and the
-- audit entry's own previous_value would be the only copy. Kept on the
-- request as well because this is the row a person reads: the review screen
-- shows was/now per field, and it must still show that a year later, after
-- the member has changed something else twice.
alter table member_details_request
    add column previous_parties jsonb;

comment on column member_details_request.previous_parties is
    'application_party as it stood when the member submitted. Null on rows '
    'created before migration 0042; the review screen falls back to the '
    'record as it is now, which for a pending request is the same thing.';

-- Officer feedback anticipated: a decline has to say why, because the
-- member is told. Enforced in the service, which can word it.
comment on column member_details_request.comment is
    'Why a request was declined, shown to the member. Required on decline.';
