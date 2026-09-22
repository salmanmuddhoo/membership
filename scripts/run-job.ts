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
import { detectDormancy } from '../src/lib/members/dormancy';
import { verifyLedger } from '../src/lib/ledger/ledger';
import { retryDueNotifications } from '../src/lib/notifications/retry';
import {
  disposeDueRecords,
  disposedAnything,
} from '../src/lib/retention/disposal';
import { watchJobs } from '../src/lib/jobs/watch';

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

  // S-804. Marks dormant every active member with nothing moving on their
  // accounts for dormancy.months (Configuration -> Fee schedules; 0 turns
  // it off), audited and told. Run nightly; a second run finds nothing.
  'dormancy-detection': () =>
    runJob<{ sweptAt: string }>({
      name: 'dormancy-detection',
      run: async context => {
        const { marked, months } = await detectDormancy();
        await context.save(
          { sweptAt: new Date().toISOString() },
          marked.length
        );
        context.log('members marked dormant', {
          months,
          marked: marked.length,
          memberNos: marked.map(m => m.memberNo),
        });
      },
    }),

  // S-904. Attempts every notification whose backoff has elapsed, and gives
  // up on one that has exhausted its attempts. Run often — every fifteen
  // minutes or so — since the first retry is only five minutes behind the
  // failure and a member waiting on an approval notices the difference.
  //
  // Safe at any time and on any environment: a run with nothing due does
  // nothing at all, and a channel that is still unconfigured fails the same
  // way it did the first time, visibly, without sending anything.
  'notification-retry': () =>
    runJob<{ sweptAt: string }>({
      name: 'notification-retry',
      run: async context => {
        const outcome = await retryDueNotifications();
        // processedCount is what was attempted, not what succeeded: a run
        // that tried fifty and sent none is the one an operator most needs
        // to see in the job's own history.
        await context.save(
          { sweptAt: new Date().toISOString() },
          outcome.attempted
        );
        context.log('notifications retried', { ...outcome });
      },
    }),

  // S-1003. Disposes of what is past the period the Society has set for it.
  //
  // Safe to schedule before the Society has stated anything: every period
  // starts unset, unset means retain indefinitely, and a class with no period
  // is not queried at all. On a database where nothing has been set this run
  // reads three rows and stops.
  //
  // Run daily, alongside document-expiry. Nothing here is time-critical — a
  // record disposed of tomorrow instead of tonight is a record one day past
  // its period — and a daily run keeps each one small once the first sweep is
  // behind it.
  'retention-disposal': () =>
    runJob<{ passes: number }>({
      name: 'retention-disposal',
      run: async context => {
        // Passes rather than one large statement: each is its own bounded
        // transaction, so the first sweep of a years-deep log does not hold
        // one open across the whole table, and SIGTERM between passes stops
        // the job cleanly with everything so far committed.
        let passes = context.checkpoint?.passes ?? 0;

        for (;;) {
          if (context.shouldStop()) {
            context.log('stop requested between passes', { passes });
            return;
          }

          const outcome = await disposeDueRecords();
          passes += 1;

          const disposed =
            outcome.notificationsDeleted +
            outcome.applicationsRedacted +
            outcome.draftsDeleted;

          await context.save({ passes }, disposed);

          if (outcome.draftsRefused > 0) {
            // Not a failure: a draft with a receipt against it is not
            // disposable, and it will be counted again every run. Logged so
            // that is visible rather than looking like a pass that stalled.
            context.log('drafts refused disposal', {
              refused: outcome.draftsRefused,
            });
          }

          if (outcome.filesFailed > 0) {
            // This one IS a problem: an applicant's identity papers are still
            // in SharePoint past the period the Society set. The application
            // is deliberately left undisposed so the next run tries again,
            // and this says so rather than letting it look like nothing due.
            context.log('files not removed; applications left undisposed', {
              applications: outcome.filesFailed,
            });
          }

          if (!disposedAnything(outcome)) {
            context.log('nothing further due', { passes });
            return;
          }

          context.log('disposed', { ...outcome });
        }
      },
    }),

  // S-1301. The balance cache is maintained in the same database transaction
  // as the entries it summarises, so on a healthy database this finds
  // nothing. If it ever finds something, the entries win: each account is
  // rebuilt from them and the disagreement is written to the audit trail,
  // because a cache that drifted once is a bug somewhere and the row is how
  // it gets found. Run nightly.
  'ledger-verify': () =>
    runJob<{ checkedAt: string }>({
      name: 'ledger-verify',
      run: async context => {
        const outcome = await verifyLedger({
          userId: null,
          description: 'ledger-verify job',
        });
        await context.save(
          { checkedAt: new Date().toISOString() },
          outcome.repaired
        );
        if (outcome.drifted.length === 0) {
          context.log('cache agrees with the entries');
          return;
        }
        // Loud on purpose: this should never happen, and a quiet repair
        // would let whatever caused it keep happening.
        console.error(
          `[ledger-verify] ${outcome.drifted.length} account(s) drifted and were rebuilt from their entries`,
          outcome.drifted
        );
        context.log('repaired', {
          accounts: outcome.drifted.map(d => d.accountId),
        });
      },
    }),

  // The job that watches the jobs (docs/jobs.md). A run still open and not
  // touched for hours means a container died and nothing resumed it; a job
  // whose latest run failed is one nobody has re-run. Both are told to the
  // System Administrators, once per run — the delivery log remembers what
  // was said. Run every few hours; a run with nothing wrong writes nothing.
  'job-watch': () =>
    runJob<{ sweptAt: string }>({
      name: 'job-watch',
      run: async context => {
        const { concerns, reported } = await watchJobs();
        // processedCount is what was newly reported, not what is wrong: a
        // stalled run found again tonight is not news.
        await context.save({ sweptAt: new Date().toISOString() }, reported);
        context.log('job history checked', {
          concerns: concerns.length,
          reported,
          runs: concerns.map(c => `${c.jobName}#${c.runId} ${c.kind}`),
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
