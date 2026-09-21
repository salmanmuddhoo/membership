-- S-609: individual sign-offs toward a step's quorum.
--
-- workflow_step.quorum_count (S-209) has existed since M2 with no execution
-- logic behind it — every configured step ships at quorum 1, where a single
-- actor's decision has always transitioned the record immediately. This is
-- what a step above quorum 1 needs: somewhere to record who has signed off
-- so far, distinct from application_transition, which only ever records the
-- ONE transition that actually moves the record — a quorum step accumulates
-- several sign-offs before that transition happens at all, and those earlier
-- ones are never themselves a transition.
--
-- Append-only for the same reason application_transition is: a sign-off is a
-- historical fact about who acted and when, not a value anyone revises.
--
-- `restrict`, not `cascade`, on the foreign key below — migration 0014
-- already found this the hard way for application_transition: the
-- append-only trigger is statement-level, so a CASCADE delete's own DELETE
-- statement is refused before it looks at a single row, even for an
-- application with nothing to cascade. `restrict` is what the pair actually
-- meant: an application with a sign-off is refused by the database, and a
-- draft (which never reaches a step with sign-offs) has none to refuse.
set local albarakah.actor_description = 'migration 0022_board_quorum_signoff';

create table application_step_signoff (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references membership_application(id) on delete restrict,

    -- Which configured step this sign-off counts toward — a step can be
    -- reconfigured (S-209), so this is the code at the time of acting, the
    -- same convention application_transition.step_code already uses.
    step_code       text        not null,

    actor_user_id   uuid        not null references app_user(id),
    outcome         text        not null check (outcome in ('approve', 'reject')),
    comment         text,

    occurred_at     timestamptz not null default now(),

    -- One sign-off per person per step per application: the same person
    -- cannot count toward quorum twice, and re-acting is a conflict for the
    -- service to refuse, not a row to overwrite.
    unique (application_id, step_code, actor_user_id)
);

create index application_step_signoff_idx
    on application_step_signoff (application_id, step_code);

-- Relaxed by the same escape hatch every other append-only guard checks
-- first (migration 0019): reset_all_test_data() needs to TRUNCATE this table
-- too, and without this check that TRUNCATE would be refused, which fails
-- the whole reset — the same class of mistake 0019 exists to describe, just
-- on a table this migration adds after it.
create or replace function reject_signoff_mutation()
returns trigger
language plpgsql
as $$
begin
    if albarakah_reset_in_progress() then
        return coalesce(new, old);
    end if;

    raise exception
        'application_step_signoff is append-only; % is not permitted', tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger application_step_signoff_append_only
    before update or delete or truncate on application_step_signoff
    for each statement execute function reject_signoff_mutation();
