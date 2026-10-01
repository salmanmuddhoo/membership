-- The job that watches the jobs (docs/jobs.md).
--
-- job_run has recorded every run since 0008 and nothing read it back: a
-- run left open by a container that died, or a job whose last run failed,
-- sat there until somebody looked. The job-watch job (src/lib/jobs/watch.ts)
-- now reads it and tells the System Administrators, by email — app_user
-- has an email and nothing else — once per run, the delivery log being what
-- remembers that a run was already written about.
set local albarakah.actor_description = 'migration 0088_job_watch';

insert into notification_template
    (event_code, channel, subject, body, description)
values
    ('job.stalled', 'email',
     'Job {{job}} has stalled',
     E'{{recipient_name}},\n\nRun {{run_id}} of {{job}} (attempt {{attempt}}) started {{started_at}} and has not written anything since {{last_update}}. The next scheduled run will resume it; if none is due, start one.\n\n{{link}}',
     'Sent to every System Administrator when a job run has been left open for hours.'),
    ('job.failed', 'email',
     'Job {{job}} failed',
     E'{{recipient_name}},\n\nRun {{run_id}} of {{job}} (attempt {{attempt}}) started {{started_at}} and failed at {{finished_at}}: {{error}}\n\nNothing has run for it since.\n\n{{link}}',
     'Sent to every System Administrator when a job''s most recent run failed.')
on conflict (event_code, channel) do nothing;
