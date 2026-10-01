// The job that watches the jobs (docs/jobs.md).
//
// A job_run row still `running` with an updated_at hours old means a
// container died and no schedule has picked the run up; a job whose latest
// run is `failed` is one nobody has re-run since. Neither raises anything
// on its own — the runner records both faithfully and then nothing reads
// the table — so this reads it, on the same runner, and tells the System
// Administrators through the notification layer (M9), whose delivery log
// is also what stops the same run being reported every time the watcher
// runs: a run already written about is not written about again.
import { query } from '../db/pool';
import { appLink } from '../notifications/links';
import { notify } from '../notifications/notify';
import { staffWithRole } from '../notifications/staff';

export const JOB_STALLED = 'job.stalled';
export const JOB_FAILED = 'job.failed';
export const WATCH_ROLE = 'system_administrator';
// Longer than any scheduled job here runs, shorter than the gap between
// two nights: found the morning after, not a week later.
export const STALE_AFTER_HOURS = 6;

export interface JobConcern {
  kind: 'stalled' | 'failed';
  runId: string;
  jobName: string;
  attempt: number;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

/**
 * What is wrong on the job history right now: every run still open and not
 * touched for STALE_AFTER_HOURS, and every job whose most recent run
 * failed. A job whose failure was followed by a success is not a concern;
 * a run that resumed after stalling is not either, until it stalls again.
 */
export async function findJobConcerns(
  now: Date = new Date()
): Promise<JobConcern[]> {
  const result = await query<{
    kind: 'stalled' | 'failed';
    run_id: string;
    job_name: string;
    attempt: number;
    started_at: Date;
    updated_at: Date;
    finished_at: Date | null;
    error: string | null;
  }>(
    `select 'stalled' as kind, id::text as run_id, job_name, attempt,
            started_at, updated_at, finished_at, error
       from job_run
      where status = 'running'
        and updated_at < $1::timestamptz - make_interval(hours => $2)
     union all
     select 'failed', run_id, job_name, attempt,
            started_at, updated_at, finished_at, error
       from (select distinct on (job_name)
                    id::text as run_id, job_name, status, attempt,
                    started_at, updated_at, finished_at, error
               from job_run
              order by job_name, started_at desc) latest
      where status = 'failed'
      order by job_name, started_at`,
    [now.toISOString(), STALE_AFTER_HOURS]
  );
  return result.rows.map(r => ({
    kind: r.kind,
    runId: r.run_id,
    jobName: r.job_name,
    attempt: r.attempt,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    error: r.error,
  }));
}

const when = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Indian/Mauritius',
});

/**
 * Tell the System Administrators about each concern not already told:
 * one message per person per run, the delivery log (entity `job_run`)
 * being the memory of what was said. Returns every concern found and how
 * many were newly reported, so the run's own count means something.
 */
export async function watchJobs(
  now: Date = new Date()
): Promise<{ concerns: JobConcern[]; reported: number }> {
  const concerns = await findJobConcerns(now);
  if (concerns.length === 0) return { concerns, reported: 0 };

  const recipients = await staffWithRole(WATCH_ROLE);
  let reported = 0;
  for (const concern of concerns) {
    const eventCode = concern.kind === 'stalled' ? JOB_STALLED : JOB_FAILED;
    const already = await query<{ n: string }>(
      `select count(*)::text as n from notification
        where entity_type = 'job_run' and entity_id = $1 and event_code = $2`,
      [concern.runId, eventCode]
    );
    if (Number(already.rows[0].n) > 0) continue;
    reported += 1;

    for (const recipient of recipients) {
      await notify({
        eventCode,
        recipients: { email: recipient.email },
        values: {
          recipient_name: recipient.name,
          job: concern.jobName,
          run_id: concern.runId,
          attempt: String(concern.attempt),
          started_at: when.format(concern.startedAt),
          last_update: when.format(concern.updatedAt),
          finished_at: concern.finishedAt
            ? when.format(concern.finishedAt)
            : '',
          error: concern.error ?? '',
          link: appLink('/reports/jobs'),
        },
        entityType: 'job_run',
        entityId: concern.runId,
      });
    }
  }
  return { concerns, reported };
}
