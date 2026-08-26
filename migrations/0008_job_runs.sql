-- Durable job state (S-113).
--
-- A long task must be able to resume. Azure Container Apps can evict and
-- restart a job instance, and a dormancy sweep or a migration import over the
-- full membership is long enough that restarting from the beginning each time
-- is not merely slow but may never finish. So progress lives here, not in the
-- process.
--
-- The table is also the record of what ran, when, and whether it succeeded,
-- which is what makes a scheduled job auditable rather than something that
-- silently stops working.

create table job_run (
    id              bigserial   primary key,
    job_name        text        not null,

    status          text        not null
        check (status in ('running', 'succeeded', 'failed')),

    -- Increments when an interrupted run is resumed, so a job that keeps dying
    -- shows up as one long struggle rather than many tidy attempts.
    attempt         integer     not null default 1,

    -- Where the job had got to. Shape is the job's own business; the runner
    -- only stores and returns it.
    checkpoint      jsonb,

    -- For the operator: progress that means something without decoding the
    -- checkpoint.
    processed_count integer     not null default 0,

    started_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    finished_at     timestamptz,

    -- Present only on failure. A message, never a stack trace: this table is
    -- read by operators, and the trace belongs in the log.
    error           text,

    constraint job_run_finished_agrees_with_status
        check ((status = 'running' and finished_at is null)
            or (status <> 'running' and finished_at is not null))
);

create index job_run_name_started_idx on job_run (job_name, started_at desc);

-- Finding an interrupted run is the hot path at every job start.
create index job_run_running_idx on job_run (job_name) where status = 'running';

comment on table job_run is
    'One row per job execution. A row still marked running when no process '
    'holds the job advisory lock is an interrupted run, and is resumed rather '
    'than started again.';
