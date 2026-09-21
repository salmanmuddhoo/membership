-- Reversing a posted transaction (S-1505, decision 12, FRD 6.5.1, 12).
--
-- The correction of a posted mistake is a reversing transaction that names
-- it (reverses_id, 0066), posted through the engine on its own receipt —
-- never an edit, never a deletion. The kind and the engine's handling of it
-- have existed since 0066 for refunds; what arrives here is the rule that
-- the officer who captured a transaction may not be the one who reverses
-- it (S-203), alongside 0069's "may not void its receipt".
set local albarakah.actor_description = 'migration 0074_reversals';

insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('transaction',
     'transaction.captured',
     'transaction.reversed',
     'The officer who captured a transaction may not reverse it.')
on conflict do nothing;
