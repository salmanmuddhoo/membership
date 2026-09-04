-- Officer feedback: a printed receipt should carry the role of the officer
-- who issued it, not only their name — the same "who did what" a reader of
-- the receipt already gets from recorded_by's own display_name.
--
-- Snapshotted at the moment of recording, the same reason fee_version_id and
-- payment_line.scheduled_amount already are: a role held today should not
-- silently rewrite what a receipt already printed if that person's roles
-- change later, or if they leave the Society altogether.
set local albarakah.actor_description = 'migration 0033_payment_recorded_by_role';

alter table payment
    add column recorded_by_role text not null default '';

comment on column payment.recorded_by_role is
    'The role name(s) held by recorded_by at the moment this payment (or '
    'refund) was recorded, comma-joined if more than one, snapshotted so a '
    'later change to that person''s roles cannot rewrite what a printed '
    'receipt already said.';
