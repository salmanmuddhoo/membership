-- Dormancy (S-804, S-805, S-806; DOR-US-001, FRD 7.11; Phase 2 open point 3).
--
-- The status has existed since 0077 and blocked since S-1501; nothing set
-- it. Now something does: the nightly dormancy-detection job marks an
-- active member dormant once nothing has moved on any of their accounts —
-- no posted entry, no fee payment — for dormancy.months, and tells them.
-- Reactivation is the backlog's default until the Society confirms a rule:
-- an officer holding member.reactivate does it on the member's page, with a
-- reason, and the member is told. dormancy.reactivation names that rule so
-- a different one later is a value, not a release.
set local albarakah.actor_description = 'migration 0086_dormancy';

insert into config_entry (key, value, value_type, description)
values
    ('dormancy.months', '12'::jsonb, 'number',
     'An active member with no posted transaction and no fee payment on ' ||
     'any of their accounts for this many months is marked dormant by the ' ||
     'nightly dormancy-detection job. 0 turns detection off.'),
    ('dormancy.reactivation', '"staff"'::jsonb, 'string',
     'How a dormant member becomes active again. "staff": an officer ' ||
     'holding member.reactivate does it on the member''s page, with a reason.')
on conflict (key) do nothing;

insert into permission (code, description) values
    ('member.reactivate', 'Reactivate a dormant member, with a reason')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  cross join permission p
 where r.code in ('account_officer', 'regional_officer', 'regional_manager',
                  'secretary', 'system_administrator')
   and p.code = 'member.reactivate'
on conflict do nothing;

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('member.dormant', 'email',
     'Al Barakah: your membership {{member_no}} is now dormant',
     E'Assalamoualaikoum {{member_name}},\n\nNothing has moved on your accounts since {{last_activity}}, so after {{months}} months your membership {{member_no}} has been marked dormant. No transactions can be made until it is reactivated. Please visit your branch with your NIC to reactivate it.\n\nAl Barakah MCSL',
     'Sent when the nightly job marks a member dormant.'),
    ('member.dormant', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your Al Barakah membership {{member_no}} is now dormant: nothing has moved on your accounts since {{last_activity}}. Please visit your branch with your NIC to reactivate it.',
     'Sent when the nightly job marks a member dormant.'),
    ('member.reactivated', 'email',
     'Al Barakah: your membership {{member_no}} is active again',
     E'Assalamoualaikoum {{member_name}},\n\nYour membership {{member_no}} has been reactivated and your accounts can be used again.\n\nAl Barakah MCSL',
     'Sent when an officer reactivates a dormant member.'),
    ('member.reactivated', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, your Al Barakah membership {{member_no}} is active again and your accounts can be used.',
     'Sent when an officer reactivates a dormant member.')
on conflict (event_code, channel) do nothing;
