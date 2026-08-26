-- Make an abandoned draft deletable (M3 follow-up).
set local albarakah.actor_description = 'migration 0014_delete_abandoned_draft';

-- application_transition was declared `on delete cascade`, which could never
-- have worked. The append-only trigger on that table is statement-level, so
-- the cascade's DELETE is refused before it looks at a single row — even for
-- an application that has no transitions at all. The effect was that no
-- membership_application could be deleted by anybody, and the cascade said the
-- opposite.
--
-- `restrict` is what the pair of them actually meant, and it is stricter than
-- the cascade ever was:
--
--   * an application with any history is refused by the database, not by a
--     service that has to remember to look;
--   * a draft has no transitions, so there are no child rows, nothing is
--     cascaded and nothing is refused.
--
-- Referential checks read the child rows (`for key share`); they do not issue
-- a DELETE, so the append-only trigger stays untouched and the history it
-- protects remains impossible to remove.
alter table application_transition
    drop constraint application_transition_application_id_fkey,
    add  constraint application_transition_application_id_fkey
         foreign key (application_id)
         references membership_application(id)
         on delete restrict;
