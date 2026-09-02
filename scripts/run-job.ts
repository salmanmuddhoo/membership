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
import { expireDocuments } from '../src/lib/documents/documents';
import { transitionMinorsAtMajority } from '../src/lib/members/majority';

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

  // S-410. A document that has passed its expiry is Expired, and the checklist
  // it sits on stops reading complete. Nothing on a request path can do this:
  // expiry happens because a date passed, not because anyone did anything, so
  // there is no request to hang it off. Run daily.
  'document-expiry': () =>
    runJob<{ sweptAt: string }>({
      name: 'document-expiry',
      run: async context => {
        const { expired } = await expireDocuments();
        // Reported through save() rather than returned: that is what makes the
        // run's processedCount the number of documents expired, which is the
        // number an operator looking at the run wants.
        await context.save({ sweptAt: new Date().toISOString() }, expired);
        context.log('documents expired', { expired });
      },
    }),

  // S-610. Finds nothing to do until a type's majority_age and
  // majority_transition_type_id are both configured (migration 0023) — safe
  // to run at any time even before the Society confirms them. Run daily,
  // alongside document-expiry.
  'minor-majority-transition': () =>
    runJob<{ sweptAt: string }>({
      name: 'minor-majority-transition',
      run: async context => {
        const { transitioned } = await transitionMinorsAtMajority();
        await context.save(
          { sweptAt: new Date().toISOString() },
          transitioned.length
        );
        context.log('minors transitioned at majority', {
          transitioned: transitioned.length,
          memberNos: transitioned.map(t => t.memberNo),
        });
      },
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
