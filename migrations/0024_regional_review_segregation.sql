-- S-611: Regional oversight (S-209's `regional_review` gate) needed its own
-- segregation rules once it became a step someone can actually act on.
--
-- `regional_review` and `secretary_review` share the `application.review`
-- permission (migration 0011) — deliberately, since both are a review in the
-- everyday sense. That sharing is exactly why the same-person conflicts
-- already seeded for `reviewed` (captured -> reviewed, reviewed -> approved)
-- would silently miss a person who holds both the Regional Manager and
-- Secretary roles: nothing stopped them signing off on the same application
-- at both stages. Audited under its own action name, `regional_reviewed`
-- (workflow.ts's ACTION_REGIONAL_REVIEWED), so the pair below can name it —
-- `earlier_action <> later_action` on this table forbids reusing `reviewed`
-- for both.
--
-- Migration 0009 already established the pattern this mirrors; nothing here
-- changes the rules seeded there.
set local albarakah.actor_description = 'migration 0024_regional_review_segregation';

insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('membership_application',
     'membership.application.captured',
     'membership.application.regional_reviewed',
     'The officer who captured an application may not give it regional oversight.'),
    ('membership_application',
     'membership.application.regional_reviewed',
     'membership.application.reviewed',
     'Whoever gave an application regional oversight may not also review it centrally.'),
    ('membership_application',
     'membership.application.regional_reviewed',
     'membership.application.approved',
     'Whoever gave an application regional oversight may not also approve it.')
on conflict do nothing;
