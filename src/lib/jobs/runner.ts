// Running a job that can be interrupted (S-113).
//
// Azure Container Apps Jobs is the platform: a scheduled job runs on a cron
// expression, a manual job runs on demand, and either can be evicted and
// restarted. Vercel is not an option for this work — its functions have an
// execution ceiling that a sweep over the full membership will exceed, which is
// what this spike set out to establish.
//
// Three properties make a job safe to run against member data:
//
//   1. ONE AT A TIME. Two dormancy sweeps running together would each read the
//      same members and each write the same changes. A Postgres advisory lock
//      held for the life of the connection prevents it, and releases by itself
//      if the container dies — no stale lock to clear by hand.
//
//   2. RESUMES, NOT RESTARTS. Progress is checkpointed to the database. A job
//      killed at 80% continues from 80%, which matters because a job that
//      always restarts from zero may never finish at all.
//
//   3. STOPS WHEN ASKED. Container Apps sends SIGTERM before eviction. The job
//      finishes its current chunk, saves, and exits — rather than being killed
//      mid-write.
import pg from 'pg';
import { getDatabaseConfig } from '../config';

// Distinct from the migration runner's lock. Two different jobs may run at the
// same time; two copies of the SAME job may not, so the job name is hashed into
// the second key.
const JOB_LOCK_NAMESPACE = 4471922;

function lockKeyFor(jobName: string): number {
  // Small deterministic hash; collisions between two different job names would
  // merely serialise them, never corrupt anything.
  let hash = 0;
  for (let i = 0; i < jobName.length; i += 1) {
    hash = (hash * 31 + jobName.charCodeAt(i)) | 0;
  }
  return hash;
}

export interface JobContext<TCheckpoint> {
  // Where the previous attempt had got to, or undefined on a fresh run.
  checkpoint: TCheckpoint | undefined;
  // Total processed across all attempts of this run.
  processedCount: number;
  // Save progress. Call at the end of each chunk, not each item: a write per
  // item would make the checkpoint more expensive than the work.
  save(checkpoint: TCheckpoint, processedDelta: number): Promise<void>;
  // True once the platform has asked the job to stop. Check between chunks.
  shouldStop(): boolean;
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface JobResult {
  runId: string;
  jobName: string;
  status: 'succeeded' | 'failed' | 'stopped';
  attempt: number;
  processedCount: number;
  error?: string;
}

export interface JobDefinition<TCheckpoint> {
  name: string;
  run(context: JobContext<TCheckpoint>): Promise<void>;
}

// A job holds one dedicated connection for its whole life — it is not a request
// handler, and the advisory lock is only meaningful while that session lives.
async function connect(): Promise<pg.Client> {
  const config = getDatabaseConfig();
  const client = new pg.Client({
    connectionString: config.connectionString,
    ssl: config.sslMode === 'verify' ? { rejectUnauthorized: true } : false,
  });
  await client.connect();
  return client;
}

export class JobAlreadyRunning extends Error {
  constructor(jobName: string) {
    super(`Job ${jobName} is already running elsewhere.`);
    this.name = 'JobAlreadyRunning';
  }
}

export async function runJob<TCheckpoint = unknown>(
  definition: JobDefinition<TCheckpoint>,
  options: { signal?: AbortSignal } = {}
): Promise<JobResult> {
  const client = await connect();
  let stopping = false;

  // Container Apps sends SIGTERM before it takes the instance away. Rather than
  // being killed mid-chunk, the job notices and stops cleanly at the next
  // boundary with its progress saved.
  const onSignal = () => {
    stopping = true;
    console.warn(`[job] ${definition.name}: stop requested, finishing chunk`);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  options.signal?.addEventListener('abort', onSignal);

  try {
    // Non-blocking: if another instance holds it, this one exits rather than
    // queueing behind a job that may run for an hour.
    const lock = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1, $2) as acquired',
      [JOB_LOCK_NAMESPACE, lockKeyFor(definition.name)]
    );

    if (!lock.rows[0].acquired) {
      throw new JobAlreadyRunning(definition.name);
    }

    // Holding the lock, any row still marked running belongs to a process that
    // died — nobody else can be running this job right now. So it is an
    // interrupted run to resume, not a competitor.
    const existing = await client.query<{
      id: string;
      attempt: number;
      checkpoint: TCheckpoint | null;
      processed_count: number;
    }>(
      `select id::text, attempt, checkpoint, processed_count
         from job_run
        where job_name = $1 and status = 'running'
        order by started_at desc
        limit 1`,
      [definition.name]
    );

    let runId: string;
    let attempt: number;
    let checkpoint: TCheckpoint | undefined;
    let processedCount: number;

    if (existing.rows[0]) {
      const row = existing.rows[0];
      runId = row.id;
      attempt = row.attempt + 1;
      checkpoint = row.checkpoint ?? undefined;
      processedCount = row.processed_count;

      await client.query(
        'update job_run set attempt = $2, updated_at = now() where id = $1',
        [runId, attempt]
      );
      console.warn(
        `[job] ${definition.name}: resuming interrupted run ${runId} ` +
          `(attempt ${attempt}, ${processedCount} already processed)`
      );
    } else {
      const created = await client.query<{ id: string }>(
        `insert into job_run (job_name, status) values ($1, 'running')
         returning id::text`,
        [definition.name]
      );
      runId = created.rows[0].id;
      attempt = 1;
      checkpoint = undefined;
      processedCount = 0;
    }

    const context: JobContext<TCheckpoint> = {
      checkpoint,
      processedCount,
      shouldStop: () => stopping,
      log: (message, fields) =>
        console.info(
          JSON.stringify({
            kind: 'job',
            job: definition.name,
            runId,
            message,
            ...fields,
          })
        ),
      save: async (next, processedDelta) => {
        processedCount += processedDelta;
        context.checkpoint = next;
        context.processedCount = processedCount;
        await client.query(
          `update job_run
              set checkpoint = $2, processed_count = $3, updated_at = now()
            where id = $1`,
          [runId, JSON.stringify(next), processedCount]
        );
      },
    };

    try {
      await definition.run(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query(
        `update job_run
            set status = 'failed', finished_at = now(), updated_at = now(),
                error = $2
          where id = $1`,
        [runId, message.slice(0, 2000)]
      );
      // The full error goes to the log; job_run holds the message an operator
      // needs to see.
      console.error(`[job] ${definition.name} failed:`, error);
      return {
        runId,
        jobName: definition.name,
        status: 'failed',
        attempt,
        processedCount,
        error: message,
      };
    }

    if (stopping) {
      // Left as 'running' deliberately: the work is not finished, and the next
      // start must find it and resume rather than beginning again.
      console.warn(
        `[job] ${definition.name}: stopped at ${processedCount} processed; ` +
          'run stays open for the next instance to resume'
      );
      return {
        runId,
        jobName: definition.name,
        status: 'stopped',
        attempt,
        processedCount,
      };
    }

    await client.query(
      `update job_run
          set status = 'succeeded', finished_at = now(), updated_at = now()
        where id = $1`,
      [runId]
    );

    return {
      runId,
      jobName: definition.name,
      status: 'succeeded',
      attempt,
      processedCount,
    };
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    // Ending the connection releases the advisory lock, whatever happened.
    await client.end().catch(() => {});
  }
}
