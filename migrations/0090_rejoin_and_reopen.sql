-- After an exit (M26): a resigned member rejoins and a closed account
-- reopens, through the same approval chains that admitted and opened them,
-- keeping the AB number and the account number.
--
-- Resignation (0078) closed the Shares and MSA and set member.status =
-- 'resigned'; a closure (0077) closed one account. Nothing brought either
-- back: a second membership application would have created a second
-- member with a second number, and a second account application was
-- refused at approval because the closed account still counted as "already
-- held". Now a membership application may name the member it re-admits,
-- and approval reactivates that member and their closed core accounts;
-- an additional-account application whose type the member holds closed
-- reactivates that account. Both dated, so the page can say "rejoined on"
-- and "reopened on".
set local albarakah.actor_description = 'migration 0090_rejoin_and_reopen';

alter table member
    add column rejoined_at timestamptz;

comment on column member.rejoined_at is
    'When a resigned membership was last re-admitted, by a membership '
    'application naming this member (rejoins_member_id). Null for a member '
    'who never left.';

alter table account
    add column reopened_at timestamptz;

comment on column account.reopened_at is
    'When a closed account was last reactivated: by the rejoin that brought '
    'its member back, or by an additional-account application approved for '
    'its type. Null for an account never closed and reopened.';

alter table membership_application
    add column rejoins_member_id uuid references member(id);

create index membership_application_rejoins_idx
    on membership_application (rejoins_member_id)
    where rejoins_member_id is not null;

comment on column membership_application.rejoins_member_id is
    'For a membership application that re-admits a resigned member: which '
    'one. Approval reactivates that member under their existing number '
    'rather than creating another. Null for every other application.';
