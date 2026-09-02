-- S-602: how many nominees a membership type's application captures.
--
-- FRD 5.3 asks for "one or more Nominees where configured" — the schema has
-- always supported it (application_party.ordinal, S-301), but capture has
-- only ever created and rendered one. This is the count that changes that,
-- per type, without a release. Percentages need no column of their own: a
-- type that wants them adds a mandatory 'percentage' field to the nominee
-- subject the same way it adds any other field, and submission sums
-- whatever ordinals exist against it — see capture.ts.
set local albarakah.actor_description = 'migration 0021_configurable_nominee_count';

alter table membership_type
    add column nominee_count integer not null default 1
        check (nominee_count >= 1);

comment on column membership_type.nominee_count is
    'How many nominee instances this type''s capture form renders and '
    'accepts (application_party.subject = ''nominee'', ordinal 1..N). '
    'Confirmed business default is 1 — see docs/backlog.md M6.';
