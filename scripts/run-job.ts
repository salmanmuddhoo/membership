// Entrypoint for Azure Container Apps Jobs (S-113).
//
// The container runs `node scripts/run-job.js <job-name>`. Container Apps
// decides WHEN — a cron schedule for the dormancy sweep, a manual start for the
// migration import — and this decides WHAT.
//
// The exit code is the contract: 0 tells Container Apps the run succeeded,
// non-zero marks it failed and lets the retry policy do its work.
import process from 'node:process';
import {
  runChunkedSweep,
  type SweepCheckpoint,
} from '../src/lib/jobs/chunked-sweep';
import { runJob, JobAlreadyRunning } from '../src/lib/jobs/runner';

// Jobs are named here rather than passed as arbitrary strings: the container's
// arguments are configuration, and configuration should not be able to name a
// job that does not exist and have it silently do nothing.
const JOBS: Record<string, () => Promise<unknown>> = {
  // Proves the mechanism end to end. Walks every user in chunks, checkpointing
  // after each. Safe to run at any time — it reads and records progress only.
  'chunked-sweep-demo': () =>
    runJob<SweepCheckpoint>({
      name: 'chunked-sweep-demo',
      run: context => runChunkedSweep(context, { chunkSize: 100 }),
    }),
};

async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || !(name in JOBS)) {
    console.error(
      `Usage: run-job <name>\nKnown jobs: ${Object.keys(JOBS).join(', ')}`
    );
    process.exit(2);
  }

  const started = Date.now();

  try {
    const result = (await JOBS[name]()) as {
      status: string;
      processedCount: number;
      runId: string;
      error?: string;
    };

    console.info(
      JSON.stringify({
        kind: 'job-finished',
        job: name,
        ...result,
        durationMs: Date.now() - started,
      })
    );

    // 'stopped' is not a failure: the platform asked the job to stop and it
    // did so cleanly with its progress saved. Exiting non-zero would make
    // Container Apps report a failed run for an orderly shutdown.
    process.exit(result.status === 'failed' ? 1 : 0);
  } catch (error) {
    if (error instanceof JobAlreadyRunning) {
      // Not an error: a schedule fired while the previous run was still going.
      // Exiting 0 keeps the job's history clean and lets the running one finish.
      console.warn(`[job] ${name} already running; exiting without starting`);
      process.exit(0);
    }
    console.error(`[job] ${name} could not start:`, error);
    process.exit(1);
  }
}

main();
