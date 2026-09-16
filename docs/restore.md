# Backup and restore

S-1002 does not ask for a backup. It asks for a restore that **has been
performed**, because an untested backup is an assumption rather than a
control. This is the procedure, and the tool that turns a drill into evidence.

> **Status: the drill has not been run.** Azure's automated backups are on by
> default for a Flexible Server, but nothing in this repository has ever
> restored one. Until the drill below has been carried out and its record
> filled in, the Society does not know its recovery time and does not know the
> backup works. That is the open item, not the writing of this page.

## What is backed up, and what is not

| What                                     | Where it lives                            | How it is recovered                                           |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Member, application, payment, audit data | Azure Database for PostgreSQL             | Azure automated backups — point-in-time restore               |
| Documents (the files)                    | SharePoint                                | Microsoft 365 retention and versioning, **not** this database |
| Document metadata                        | PostgreSQL                                | With the database                                             |
| Schema                                   | `migrations/` in this repository          | Re-applied by the pipeline                                    |
| Application code                         | This repository and Vercel                | Redeploy                                                      |
| Secrets                                  | Vercel environment variables, Entra, Meta | **Not backed up anywhere.** See below                         |

Two things follow that are easy to miss.

**The documents and their metadata recover separately.** A database restored
to an earlier point still points at SharePoint files that were never rolled
back, so a document filed after that point exists in SharePoint with no row
describing it. That is the safe direction — an orphan file rather than a
dangling reference — but the checklist will show a document as missing that a
person can see in SharePoint. Expect it, and re-file rather than hand-editing
rows.

**Secrets are not in any backup.** Losing the Vercel project loses them.
Whoever holds the Entra, Graph and Meta credentials must be able to reissue
them; `docs/runbook.md` lists what each one breaks.

## Before a drill: capture the control figures

Against the **live** database, so there is something to verify against:

```bash
DATABASE_URL="<the live connection string>" pnpm figures:capture > baseline.json
```

That records twenty figures — counts, the money total, and the high-water
marks for member number, application reference, receipt serial and financial
event sequence. Keep the file with the drill record.

The high-water marks matter more than the counts. A restore that lost a day
still has plausible-looking counts; a receipt serial that has gone **backwards**
means the next receipt issued would reuse a number already given to a member,
which is the thing S-502 exists to prevent.

## The drill

Never restore over production. Azure restores to a **new server**, which is
what makes this safe to rehearse.

1. **Note the time you start.** The recovery time is one of the two things
   this drill produces.
2. In the Azure portal, **Restore** the production server to a point in time —
   choose one a few hours old, so the restore is demonstrably not simply the
   current database.
3. Wait for the new server to come up. Record how long it took.
4. Verify against the baseline:

   ```bash
   DATABASE_URL="<the RESTORED server's connection string>" \
     pnpm figures:verify baseline.json
   ```

5. **Read the differences.** The command exits non-zero if any figure differs.
   A restore to a point before the baseline **is expected to differ** — what
   matters is that the differences are consistent with the point chosen, and
   that nothing has gone backwards that must not.
6. Point a Test deployment at the restored server and sign in. A database that
   restores but that the application cannot use is not a recovery.
7. **Delete the restored server** when finished. It is a full copy of member
   data and it bills by the hour.

## Recording the drill

The story asks for the time taken to be recorded. Add a row here each time:

| Date            | Restored to | Time to recover | Figures | Notes |
| --------------- | ----------- | --------------- | ------- | ----- |
| _(not yet run)_ |             |                 |         |       |

## If this is a real recovery, not a drill

The order is different, because the application must not write to a database
that is about to be replaced.

1. **Stop the writes.** Take the Vercel deployment down, or point it at a
   maintenance page. An application still taking payments against a database
   you are about to discard loses exactly the records people will ask about.
2. Restore to the last point known good. The audit trail is how that point is
   established: `latest audit event` in the control figures, and the **Audit
   log** page.
3. Run `pnpm figures:verify` against your most recent baseline and **write
   down what differs**. Those differences are the work lost, and somebody has
   to re-enter it.
4. Re-point the application, redeploy, sign in, check the Dashboard.
5. Reconcile receipts before taking another payment — **Receipts →
   Reconciliation** shows gaps and duplicates in the sequence, which is
   precisely what a restore can introduce.
6. Tell the Treasurer what the money figures were before and after.

## What is still missing

- **The drill itself**, and with it the recovery-time figure. Nobody knows it
  yet.
- **A scheduled capture of the control figures.** They are captured by hand
  today, so a baseline is as old as the last time somebody remembered. A daily
  job writing one somewhere durable would mean a real recovery always has
  something recent to verify against.
- **A tested SharePoint recovery.** Only the database half is covered here.
