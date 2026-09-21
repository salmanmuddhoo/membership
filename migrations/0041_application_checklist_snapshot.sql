-- Officer feedback: a document checklist change (a new required document, one
-- removed, a requirement flipped from optional to required) applied to every
-- application already in flight the moment it was saved — an application
-- someone had been working on for weeks could gain a new mandatory document
-- overnight, or lose one they had already collected and filed against.
--
-- What an application requires is decided once, when it is captured, from
-- whatever document_checklist_item says at that moment — copied here rather
-- than referenced, so a later edit to document_checklist_item cannot reach
-- backwards into an application that already has its own answer. A NEW
-- application, captured after the change, sees it immediately: nothing here
-- is cached beyond the moment of capture, the same as before this existed.
--
-- Not itself reference configuration (S-210's actor-attributed audit trigger
-- does not apply): this is application data, written once by the same code
-- path that captures the application (capture.ts) and never edited
-- afterwards, the same shape application_account_selection already is.
create table application_checklist_item (
    id                uuid    primary key default gen_random_uuid(),
    application_id    uuid    not null references membership_application(id) on delete cascade,
    document_type_id  uuid    not null references document_type(id),

    subject           text    not null
        check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary')),

    requirement       text    not null
        check (requirement in ('required', 'optional')),

    sort_order        integer not null default 0,

    unique (application_id, document_type_id, subject)
);

create index application_checklist_item_application_id_idx
    on application_checklist_item (application_id, subject, sort_order);

comment on table application_checklist_item is
    'The document checklist as it stood when this application was captured '
    '(officer feedback) — a copy of document_checklist_item at that moment, '
    'not a live read of it. A member''s own checklist (documents.ts, '
    'checklistFor) reads this through member.application_id, so the same '
    'freeze covers a membership once it is approved.';

-- ---------------------------------------------------------------------------
-- Backfill: every application already captured gets the checklist it would
-- have read under the old, live behaviour, frozen as of right now. Nothing
-- already in flight loses anything it currently sees, or gains anything it
-- does not — this is the fair cutover point — but from here on a
-- configuration change no longer reaches back into it.
-- ---------------------------------------------------------------------------

-- Plain membership applications: whatever membership_type.checklist_id
-- currently requires (readChecklistForMembershipType's own logic,
-- config/reference.ts).
insert into application_checklist_item
    (application_id, document_type_id, subject, requirement, sort_order)
select a.id, i.document_type_id, i.subject, i.requirement, i.sort_order
  from membership_application a
  join membership_type m on m.id = a.membership_type_id
  join document_checklist_item i on i.checklist_id = m.checklist_id
 where a.application_kind = 'membership'
on conflict do nothing;

-- Additional-account applications: the union of every selected account
-- type's own checklist, required winning over optional where two selected
-- types disagree (readChecklistForAccountTypes' own logic).
insert into application_checklist_item
    (application_id, document_type_id, subject, requirement, sort_order)
select s.application_id, u.document_type_id, u.subject,
       case when bool_or(u.requirement = 'required')
            then 'required' else 'optional' end,
       min(u.sort_order)
  from application_account_selection s
  join membership_application a on a.id = s.application_id
  join account_type t on t.id = s.account_type_id
  join document_checklist_item u on u.checklist_id = t.checklist_id
 where a.application_kind = 'additional_account'
 group by s.application_id, u.document_type_id, u.subject
on conflict do nothing;

-- Customer-account applications: the union of the non-member checklist
-- (membership_type.non_member_checklist_id) and every selected account
-- type's own checklist, required winning over optional the same way
-- (readChecklistForNonMemberAccount's own logic).
insert into application_checklist_item
    (application_id, document_type_id, subject, requirement, sort_order)
select combined.application_id, combined.document_type_id, combined.subject,
       case when bool_or(combined.requirement = 'required')
            then 'required' else 'optional' end,
       min(combined.sort_order)
  from (
    select a.id as application_id, i.document_type_id, i.subject,
           i.requirement, i.sort_order
      from membership_application a
      join membership_type m on m.id = a.membership_type_id
      join document_checklist_item i
        on i.checklist_id = m.non_member_checklist_id
     where a.application_kind = 'customer_account'
    union all
    select s.application_id, u.document_type_id, u.subject,
           u.requirement, u.sort_order
      from application_account_selection s
      join membership_application a on a.id = s.application_id
      join account_type t on t.id = s.account_type_id
      join document_checklist_item u on u.checklist_id = t.checklist_id
     where a.application_kind = 'customer_account'
  ) combined
 group by combined.application_id, combined.document_type_id, combined.subject
on conflict do nothing;
