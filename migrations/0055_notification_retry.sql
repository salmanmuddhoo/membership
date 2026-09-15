-- Retrying a notification that did not get through (S-904).
--
-- 0053 left the outbox able to say a send failed, and nothing that ever looked
-- again. A failure that is visible only in a `last_error` column nobody reads
-- is the silent failure this story exists to prevent: staff cannot tell a
-- member who is ignoring the Society from a member the Society never actually
-- reached.
--
-- What makes a retry safe is knowing WHEN, not just THAT. A column saying "try
-- again after this moment" is what lets the sender ask one indexed question —
-- what is due now — and lets the backoff be arithmetic rather than a schedule
-- encoded in a job's own memory. Without it a retry job either hammers a relay
-- that is down or has to hold state it would lose on restart.
--
-- Two other things this deliberately does NOT do:
--
--   It does not retry forever. A mistyped address never becomes deliverable,
--   and a row retried nightly for a year is noise that hides the failures
--   worth acting on. After a ceiling the row is 'abandoned' — a status 0053
--   already allowed for — which is still visible, just no longer attempted.
--
--   It does not delete or rewrite anything. The outbox is a record of what the
--   Society tried to send, and a failed attempt is part of that record.

alter table notification
    -- When this becomes due. Set on every failure to now() plus the backoff
    -- for the attempt just made; null on a row that has reached a settled
    -- state ('sent' or 'abandoned') and will never be due again.
    --
    -- A 'pending' row left behind by a process that died mid-send has this
    -- null too — it was never marked failed, because nothing lived long
    -- enough to mark it. Those are picked up on age instead, which is why the
    -- index below carries created_at as well.
    add column next_attempt_at timestamptz;

-- The sender asks exactly one question, often: what is due now? 0053's index
-- covered status and created_at, which answers "what is outstanding" but makes
-- the server sort every failed row to find the few that are actually due.
drop index notification_pending_idx;

create index notification_due_idx
    on notification (next_attempt_at, created_at)
    where status in ('pending', 'failed');

comment on column notification.next_attempt_at is
    'When a failed send becomes due again. Null once settled, and on a '
    'pending row nothing ever got far enough to schedule.';
