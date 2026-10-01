-- Undo the dormancy a migrated member was given for the old register's
-- quiet (officer feedback).
--
-- The nightly dormancy-detection job (0086) measured a member's quiet from
-- their Joined Date. A member imported from the legacy register (M7)
-- carries the old register's Joined Date, and brought no activity with it;
-- one imported with nothing to carry — 0 balances, as minors and corporate
-- records often are — had no entry and no payment either, so the first
-- night marked them dormant, and the member page offered nothing to do for
-- them. The job now counts from the day a record entered this system as
-- well (LAST_ACTIVITY_SQL, src/lib/members/dormancy.ts). Here, every member
-- marked dormant before they had been in this system for dormancy.months
-- goes back to active, each with its own audit entry.
set local albarakah.actor_description = 'migration 0093_dormancy_from_arrival';

with wrongly as (
    update member m
       set status = 'active', status_changed_at = now()
     where m.status = 'dormant'
       and m.status_changed_at < m.created_at + make_interval(
             months => coalesce(
               (select (value #>> '{}')::int from config_entry
                 where key = 'dormancy.months'), 12))
    returning m.id
)
insert into audit_event
    (actor_user_id, actor_description, action, entity_type, entity_id,
     previous_value, new_value)
select null, 'migration 0093_dormancy_from_arrival', 'member.reactivated',
       'member', w.id::text,
       '{"status": "dormant"}'::jsonb,
       '{"status": "active", "reason": "Marked dormant before any time in this system"}'::jsonb
  from wrongly w;
