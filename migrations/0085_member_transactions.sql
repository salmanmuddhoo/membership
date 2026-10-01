-- Transactions a member starts from the app (S-2102, API-US-005,
-- API-US-006, FRD 10).
--
-- Two things, both configuration:
--
-- The Member role. It is assigned to nobody and holds no permission; it
-- exists so the approval matrix (0070) can name it as an initiating role.
-- A deposit, withdrawal or transfer the app starts is captured by the
-- member-app system user (0039) acting in this role, so a rule "by Member"
-- can route it to a chain of the Society's choosing. Without such a rule the
-- fallback applies as it does for any officer — the most demanding chain
-- for the kind — and a rule that would post at once is refused for the app,
-- which holds transaction.capture but never transaction.post: a member's
-- transaction goes to a chain or it goes nowhere.
--
-- The switch. member_api.enabled_operations lists which of the three the
-- app may start; empty, the default, and the endpoints exist but refuse.
set local albarakah.actor_description = 'migration 0085_member_transactions';

insert into role (code, name, description, is_system) values
    ('member', 'Member',
     'The member app acting for a member. Holds no permission and is ' ||
     'assigned to nobody; named by the approval matrix so a member''s own ' ||
     'transaction can be routed differently from an officer''s.',
     true)
on conflict (code) do nothing;

insert into config_entry (key, value, value_type, description)
values
    ('member_api.enabled_operations', '[]'::jsonb, 'json',
     'Which transactions a member may start from the app: any of ' ||
     '"deposit", "withdrawal" and "transfer". Empty: none.')
on conflict (key) do nothing;
