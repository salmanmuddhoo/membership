-- A details update a member sent from the app, decided (Phase 4 leftover).
--
-- Since 0042 an officer applies or declines the change at Members → Details
-- updates, and the member learned which only by opening the app again. Now
-- they are told, on the address their application recorded, the same way
-- dormancy tells them (0086): src/lib/members/details-requests.ts raises
-- member.details.applied with the fields that changed and
-- member.details.declined with the reason the officer wrote, after the
-- decision has committed and never failing it.
set local albarakah.actor_description = 'migration 0087_member_details_notifications';

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('member.details.applied', 'email',
     'Al Barakah: your details have been updated',
     E'Assalamoualaikoum {{member_name}},\n\nThe change you sent for membership {{member_no}} has been applied: {{fields}}. Open the app to see your details as they now stand.\n\nAl Barakah MCSL',
     'Sent when an officer applies a details update a member sent from the app.'),
    ('member.details.applied', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, the change you sent for your Al Barakah membership {{member_no}} has been applied: {{fields}}.',
     'Sent when an officer applies a details update a member sent from the app.'),
    ('member.details.declined', 'email',
     'Al Barakah: your details update was not applied',
     E'Assalamoualaikoum {{member_name}},\n\nThe change you sent for membership {{member_no}} was not applied: {{reason}}\n\nYou can send it again from the app, or visit your branch with your NIC.\n\nAl Barakah MCSL',
     'Sent when an officer declines a details update a member sent from the app.'),
    ('member.details.declined', 'whatsapp', null,
     'Assalamoualaikoum {{member_name}}, the change you sent for your Al Barakah membership {{member_no}} was not applied: {{reason}} You can send it again from the app, or visit your branch with your NIC.',
     'Sent when an officer declines a details update a member sent from the app.')
on conflict (event_code, channel) do nothing;
