# Scheduled and long-running jobs

Jobs run on **Azure Container Apps Jobs**, not on Vercel.

## Why not Vercel

A Vercel function has an execution ceiling. A dormancy sweep over the full
membership, or the migration import of the legacy extract, will exceed it — and
a job that is killed partway and restarts from the beginning each time may never
finish at all. That is what S-113 set out to establish, and it is settled: the
scheduling and the long work belong on Azure compute.

This is also the first Azure compute in the system, which bears on the open
networking question in `docs/database.md`: a Container App **can** be
VNet-integrated and reach PostgreSQL over a private endpoint. Jobs therefore
need no firewall opening at all. The web tier's route to the database is still
the open question; the jobs' route need not be.

## What makes a job safe against member data

Three properties, all enforced by `src/lib/jobs/runner.ts` rather than left to
each job:

**1. One at a time.** Two dormancy sweeps running together would each read the
same members and each write the same changes. A Postgres advisory lock, held for
the life of the job's connection, prevents it — and releases by itself if the
container dies, so there is no stale lock to clear by hand. A second instance
finding the lock taken **exits 0**, not 1: a schedule firing while the previous
run is still going is normal, not a failure.

**2. Resumes, not restarts.** Progress is checkpointed to `job_run` after each
chunk. A job killed at 80% continues from 80%. Verified: a run stopped after 200
of 250 rows resumed and processed exactly the remaining 50 — no row repeated, no
row missed.

**3. Stops when asked.** Container Apps sends `SIGTERM` before eviction. The job
finishes its current chunk, saves, and exits — rather than being killed
mid-write. The run stays marked `running` so the next start resumes it.

## Chunking

Use **keyset pagination**, never `OFFSET`:

```sql
select id from app_user where id > $lastId order by id limit $chunkSize
```

`OFFSET` re-reads and re-skips every earlier row on each chunk, so a sweep gets
slower the further it goes; worse, if rows are inserted while it runs, `OFFSET`
silently skips or repeats members. Keyset pagination is stable under concurrent
inserts — a row inserted behind the cursor is simply not in this sweep, which is
predictable and correct.

**Checkpoint after the work, not before.** A crash between the work and the save
then repeats a chunk rather than skipping it. Repeating is recoverable when the
work is idempotent; silently skipping a member is not. **Job bodies must
therefore be idempotent.**

## Running one

```bash
pnpm job chunked-sweep-demo          # locally
```

In the container:

```
node --import tsx scripts/run-job.ts <job-name>
```

Exit codes are the contract with Container Apps: `0` succeeded (or stopped
cleanly, or another instance holds the lock), `1` failed, `2` the job name is
unknown.

## Deploying

Built from `Dockerfile.jobs`. The image runs TypeScript directly with `tsx`
rather than a compiled bundle, so the container runs exactly the code that is
tested with no build output to drift from source. That costs image size, which
for a scheduled job matters far less than the two staying identical.

```bash
# Build and push
az acr build --registry <registry> --image albarakah-jobs:$(git rev-parse --short HEAD) \
  --file Dockerfile.jobs .

# A scheduled job — the dormancy sweep, nightly
az containerapp job create \
  --name albarakah-dormancy-sweep \
  --resource-group <rg> \
  --environment <container-apps-env> \
  --trigger-type Schedule \
  --cron-expression "0 2 * * *" \
  --replica-timeout 3600 \
  --replica-retry-limit 1 \
  --image <registry>.azurecr.io/albarakah-jobs:<tag> \
  --args "dormancy-sweep" \
  --secrets "database-url=<connection-string>" \
  --env-vars "DATABASE_URL=secretref:database-url" "PUBLIC_APP_ENV=production"

# A manual job — the migration import, started on demand
az containerapp job create \
  --name albarakah-migration-import \
  --trigger-type Manual \
  --replica-timeout 7200 \
  ... \
  --args "migration-import"

az containerapp job start --name albarakah-migration-import --resource-group <rg>
```

Notes on those settings:

- **`--replica-retry-limit 1`.** The job resumes from its checkpoint, so a retry
  continues rather than repeating. More than one retry is reasonable; zero
  wastes the resume machinery.
- **`--replica-timeout`** should exceed the expected run comfortably. When it is
  hit, `SIGTERM` arrives and the job checkpoints and stops — the next scheduled
  run continues. A long job finishing across two nights is acceptable; being
  killed mid-write is not.
- **Secrets** go in Container Apps secrets and are referenced with `secretref:`,
  never as plain `--env-vars`.
- Use a **managed identity** for the registry pull and, when the VNet work is
  done, for the database too — removing the connection string entirely.

## `minor-majority-transition` (S-610, FRD 7.10.10)

A birthday is not a request anyone makes, so nothing on a request path can
notice one. `transitionMinorsAtMajority` (`src/lib/members/majority.ts`)
walks active members whose type has both `majority_age` and
`majority_transition_type_id` configured (migration 0023 — both null by
default, so this finds nothing until an administrator sets both from
**Membership types**), compares each one's applicant `date_of_birth` against
that age, and moves anyone who has reached it into the configured type.
Every move is audited under `member.majority_transition` with
`actor_user_id` null and an `actorDescription` naming the job — the same
pattern `document-expiry` (S-410) already established for a change nobody
requested.

No chunking: unlike a sweep over the full membership, the number of members
crossing an age threshold on any given day is small, so this reads and
writes in one query per run, the same shape as `document-expiry`. Run daily,
alongside it.

## `notification-retry` (S-904)

A notification is recorded before it is attempted (`src/lib/notifications/`),
so a relay that was down, or a process that died mid-send, always leaves a row
to come back to. `retryDueNotifications` is what comes back to it: everything
whose backoff has elapsed is attempted again, and anything that has exhausted
its attempts is marked `abandoned` — still visible on **Notifications**, just
no longer tried.

What is re-sent is the text stored on the row, never a re-render of the
template. Editing wording must not change what a member was already told.

Backoff is 5m, 15m, 1h, 6h, then 24h, giving up after six attempts — a little
over thirty hours in total, so an overnight outage still delivers the next
morning. Run **every fifteen minutes**: the first retry is only five minutes
behind the failure, and a member waiting on an approval notices the
difference.

No chunking, for the same reason `document-expiry` needs none: the queue is
whatever failed since the last run, which is normally nothing. A run with
nothing due does nothing at all, so it is safe on any environment, including
one where no provider is configured yet — there, each attempt fails visibly
rather than sending anything.

```bash
pnpm job notification-retry
```

## `retention-disposal` (S-1003)

Disposes of what is past the period the Society has set for it, and of nothing
at all until one is set: every period ships unset, unset means retain
indefinitely, and a class with no period is not queried. On a database where
the Society has stated nothing this run reads three rows and exits, which is
what makes it safe to schedule ahead of that decision.

Chunked in passes rather than by keyset, because the shape of the work is
different from a sweep: each pass takes a bounded number of the oldest due
records and commits, and the job stops when a pass finds nothing. That keeps a
first sweep of a years-deep log off one long transaction, and `SIGTERM` between
passes stops the job with everything so far committed.

Idempotent, as every job body above must be, by construction rather than by
care: notifications and drafts are deleted, so a repeated chunk does not find
them, and a redacted application carries `disposed_at`.

A draft that `deleteDraftApplication` refuses — one paid against, or with a
transition behind it — is counted and skipped, never thrown. It is offered
again on every run, which is correct: it is not disposable, and saying so
repeatedly beats forgetting it exists. It deliberately does not count as
progress, or the pass loop would never terminate.

Run **daily**, alongside `document-expiry`. `docs/retention.md` has what each
class means and what disposal does to it.

```bash
pnpm job retention-disposal
```

## Recommendation for M7 and M8

- **M7 migration import** — a Manual job. Read the cleansed extract in batches,
  checkpointing the last row imported. Import must be idempotent: keyed on the
  legacy member code so a repeated chunk updates rather than duplicating. The
  phase-wise plan (members first, finance later) fits naturally as separate job
  names sharing this runner.
- **M8 dormancy sweep** — a Schedule job, nightly. Decide dormancy per member,
  write only the ones that changed, and record each change in the audit trail
  with `actor_user_id` null and an `actorDescription` naming the job — the
  same shape `minor-majority-transition` (S-610, above) already proves.
- **Add a job that watches the jobs.** A `job_run` row still `running` with an
  `updated_at` hours old means a container died and no schedule has picked it up.
  Nothing currently notices. Now that M9's notification layer exists
  (`notify()`, and the delivery log that makes a failure visible), this has
  somewhere to report to.

## What is proven, and what is not

Proven here, against a real database:

- The lock excludes a second instance **across separate OS processes** — one
  swept 3001 rows while the other exited cleanly without starting.
- An interrupted run resumes and covers exactly the remaining rows.
- Failures are recorded with a message an operator can read.
- The container's exact entrypoint command runs and returns the right exit code.

**Not proven: the image and the platform.** No Docker daemon is available in the
environment this was built in, so `Dockerfile.jobs` has never been built, and
nothing has run on Container Apps. The job logic is exercised; the packaging and
the deployment are not. First build and first scheduled run are the remaining
verification.
