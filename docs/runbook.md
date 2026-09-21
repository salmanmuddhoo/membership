# Operational runbook

What to do when something is wrong, and what the routine work is (S-1005).

Written for whoever is on the end of the phone when an officer says it is not
working — not necessarily the person who built it. Where a detail lives
elsewhere this points there rather than repeating it, because a copy is a
thing that goes stale.

| Need                                           | Go to                                    |
| ---------------------------------------------- | ---------------------------------------- |
| How the environments split, and how to promote | `docs/environments.md`                   |
| Database connection, roles, migrations         | `docs/database.md`                       |
| The scheduled jobs, and how to run one         | `docs/jobs.md`                           |
| Notification providers and their errors        | `docs/notifications.md`                  |
| The API, its callers and its limits            | `docs/api.md`                            |
| Documents and SharePoint                       | `docs/documents.md`                      |
| Security controls and the merge gate           | `SECURITY.md`, `docs/security-review.md` |
| How long records are kept, and disposal        | `docs/retention.md`                      |
| Functionally testing a deployment              | `docs/functional-testing.md`             |

## The shape of it

| Piece           | Runs on                                          | Notes                                                                        |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Web application | Vercel, region `cpt1`                            | Server-rendered; every request goes through `src/middleware.ts`              |
| Database        | Azure Database for PostgreSQL                    | Application connects as a least-privilege role that cannot change the schema |
| Documents       | SharePoint via Microsoft Graph                   | Bytes go browser → Microsoft directly, never through the app                 |
| Scheduled jobs  | Azure Container Apps Jobs                        | Not Vercel: a sweep exceeds a function's ceiling                             |
| Notifications   | Microsoft 365 mailbox and the WhatsApp Cloud API | Both behind one interface; the provider is configuration                     |
| Sign-in         | Microsoft Entra External ID (CIAM)               | A **different tenant** from the one SharePoint and mail use                  |

## First moves on any report of a problem

1. **Ask which environment.** The Test deployment shows a **TEST** badge. If
   the badge is there, production is fine and this is not urgent.
2. **Get the correlation id.** Every API failure returns one, and it is in the
   `x-correlation-id` header. One search of the Vercel logs for that id gives
   the request, its status, its duration and the actor.
3. **Check `/api/v1/health`** as a signed-in user. It reports whether the
   database is reachable and whether SharePoint is configured.
4. **Check the Vercel deployment list.** A failure that began at a known
   minute usually began with a deployment.

The request body is **never** logged — it routinely holds member personal and
financial data. Do not add logging that changes that in order to debug; use
the correlation id and the audit trail instead.

## Symptoms

### Nobody can sign in

Almost always Entra, not this application.

- Check the Entra app registration for **this environment** — each has its own,
  with its own redirect URIs. An expired `ENTRA_CLIENT_SECRET` presents as
  every sign-in failing at once.
- `/login?error=config` means the application could not read its own Entra
  settings: a missing or renamed environment variable in Vercel.
- `/login?error=auth` means the handshake came back and was rejected — a
  mismatched redirect URI, or a `state`/`nonce` cookie lost because the user
  took too long or blocked cookies.

### One person cannot sign in, everyone else can

Not Entra. They authenticated and this system declined them.

- Look in **Audit log** for `access.session_rejected` with their subject: the
  reason is recorded there.
- Usual cause: no `app_user` row, or the account was deactivated. Check
  **Staff accounts**.
- `/denied` instead means they are known but lack the permission for that
  page. Check **Roles**.

### "Something went wrong" on a page

Get the correlation id and search the logs. The envelope deliberately tells
the officer nothing else, so the log is the only place the detail exists.

### Documents will not upload

See `docs/documents.md`. In order of likelihood: the Graph client secret has
expired; the drive id is wrong for this environment; the file exceeds the
limit or is an unsupported type (the officer is told which). A failed upload
is **never** recorded as filed (S-408), so nothing is silently half-done.

### Members are not receiving notifications

Go to **Notifications**. It names what is carrying each channel and shows
what is waiting, being retried, or given up on. **Send test** puts one real
message through the whole path and shows the provider's own error.
`docs/notifications.md` has a table mapping each error to its cause.

Nothing being sent at all, with rows piling up as failed, usually means an
expired token — the Graph client secret for email, the Meta system user token
for WhatsApp.

### A scheduled job has not run

Go to **Reports → Scheduled work**. It lists every run, its status and its
error.

- A run still `running` with an old start means the container died. The next
  scheduled run resumes from its checkpoint; there is nothing to clear by hand.
- A run that is not there at all means the schedule did not fire — check the
  Container Apps job in Azure.
- `notification-retry` should run every fifteen minutes; `document-expiry`,
  `minor-majority-transition` and `retention-disposal` daily.

### The application is up but every page is slow

Check the database first. The pool is deliberately small per instance
(`DATABASE_POOL_MAX`, default 3) because serverless multiplies it by the
number of warm instances; a server near its connection limit shows as
everything being slow at once rather than as errors.

## Routine work

### Deploying

`main` deploys to Test on merge. Production deploys only when the `production`
branch is updated — see `docs/environments.md` for the promotion steps.

### Applying a schema change

Never by hand. Migrations reach a database only through
`.github/workflows/migrate.yml`, which runs after a merge to `main` (test) and
`production` (production), and can be run manually from the Actions tab
against a chosen environment.

**Never edit a migration that is already on `main`.** The runner records a
checksum and refuses a file that has changed — and refuses every migration
after it, so the database silently falls behind while the application moves
on. `pnpm verify:migrations` fails a branch that does, and runs in CI.

If a migration fails, the run stops and that migration is rolled back whole.
Nothing after it is applied. Fix it in a new migration and merge again.

### Adding a member of staff

**Staff accounts** → add them, then **Roles** to grant what they need. They
also need an account in the Entra tenant for this environment. A person who
can sign in but has no `app_user` row is refused and the refusal is audited.

### Issuing a credential for an integration

**API credentials**. The secret is shown once and cannot be recovered; reissue
if it is lost. Revoking takes effect on the integration's very next request.

### Rotating a secret

| Secret                  | Where                           | Effect of rotating                                    |
| ----------------------- | ------------------------------- | ----------------------------------------------------- |
| `ENTRA_CLIENT_SECRET`   | Entra app registration → Vercel | Sign-in breaks until Vercel is updated and redeployed |
| `GRAPH_CLIENT_SECRET`   | Graph app registration → Vercel | Documents and Graph email stop; nothing is lost       |
| `AUTH_SESSION_SECRET`   | Vercel                          | **Signs out every member of staff at once**           |
| `MEMBER_SESSION_SECRET` | Vercel                          | **Signs out every member app user at once**           |
| `NOTIFY_WHATSAPP_TOKEN` | Meta → Vercel                   | WhatsApp sends fail and are retried; nothing is lost  |
| An API credential       | **API credentials** in the app  | That integration stops on its next call               |

The two session secrets are the disruptive ones. Rotate them deliberately, out
of hours, not as a first response to something unexplained.

### Resetting Test

`/admin/reset-data`, refused outright unless `PUBLIC_APP_ENV` marks the
deployment non-production. See `docs/environments.md`.

## Clearing production back to empty

Wipes every member, application, payment and document from production. Not a
button in the app — the in-app reset screen (`/admin/reset-data`) is
test-only and does not appear in production's sidebar. This is a deliberate,
hands-on database operation, for before real members are loaded or to clear
a pilot round. Nobody runs this without being asked to.

1. **Connect as the schema owner** (the Azure admin account —
   `DATABASE_MIGRATION_URL`, see `docs/database.md`), to the `albarakah`
   database. Not `albarakah_app`.

   `reset_all_test_data()` is `security definer`, owned by the schema owner.
   The refusal that keeps it off production lives in the application
   (`resetAllTestData()`, `src/lib/admin/reset.ts`), not in the function
   itself — that is why this runs from a psql prompt against production while
   the site itself refuses to run it there.

2. **Look before wiping.**

   ```sql
   select
     (select count(*) from member)                 as members,
     (select count(*) from membership_application) as applications,
     (select count(*) from payment)                as payments,
     (select count(*) from document)               as documents,
     (select count(*) from audit_event)            as audit_rows;
   ```

3. **Run the reset**, naming who is running it and why — the function raises
   if the description is empty:

   ```sql
   select reset_all_test_data(
     '<the administrator''s app_user id>'::uuid,
     '<name or email> — reason for the clear'
   );
   ```

   Truncates `membership_application`, `receipt_number`, `sharepoint_folder`
   and `audit_event` with `cascade` — which empties everything hanging off
   them: members, accounts, payments, documents, transitions, receipts,
   financial events. Truncates `account_number_counter` and restarts the
   application, member and receipt number sequences, so numbering begins at 1
   again. Writes one `system.data_reset` audit row naming who ran it — the
   only row left in the audit trail afterwards.

4. **Removing staff accounts, if that is wanted.** `app_user` holds service
   accounts as well as people:

   - `member-app@system.albarakah.mu` — the actor the member mobile app
     captures applications as
   - `public-api@system.albarakah.mu` — the actor for applications submitted
     through the public API from the Society's website
   - `retention@system.albarakah.mu` — the actor the retention and disposal
     job acts as

   Each has an `entra_subject` beginning `system:`, a value no real sign-in
   token can carry, and holds no role. **Deleting them breaks the member app,
   the website integration and the disposal job, and nothing recreates
   them** — the migrations that insert them use
   `on conflict (email) do nothing` and are already recorded as applied, so
   re-running migrations will not bring them back. Restoring one means
   inserting the row by hand.

   Exclude them:

   ```sql
   delete from app_user
    where id <> '<the administrator''s app_user id>'::uuid
      and (entra_subject is null or entra_subject not like 'system:%');
   ```

   `user_role` rows for the deleted accounts go with them:
   `user_role.user_id` cascades on delete (migration 0002).

   **The delete can still refuse.** Six columns in tables the reset leaves
   alone point at `app_user` without cascading, and a row in any of them
   naming an account being deleted stops the whole statement:
   `user_role.granted_by`, `config_entry.updated_by`,
   `config_entry_history.changed_by`, `fee_schedule_version.created_by`,
   `notification_template.updated_by`, and `api_credential.created_by` /
   `revoked_by`. They record who configured the Society's settings, fees,
   notification wording and API credentials — none of which a data reset
   touches. On a system nobody has worked in yet there is nothing there and
   the delete goes through. After a pilot round there will be.

   Check before running it, with the administrator's id in place of the
   placeholder:

   ```sql
   select 'user_role.granted_by'           as reference, count(*)
     from user_role           where granted_by is distinct from '<id>'::uuid and granted_by is not null
   union all select 'config_entry.updated_by', count(*)
     from config_entry        where updated_by is distinct from '<id>'::uuid and updated_by is not null
   union all select 'config_entry_history.changed_by', count(*)
     from config_entry_history where changed_by is distinct from '<id>'::uuid and changed_by is not null
   union all select 'fee_schedule_version.created_by', count(*)
     from fee_schedule_version where created_by is distinct from '<id>'::uuid and created_by is not null
   union all select 'notification_template.updated_by', count(*)
     from notification_template where updated_by is distinct from '<id>'::uuid and updated_by is not null
   union all select 'api_credential.created_by', count(*)
     from api_credential      where created_by is distinct from '<id>'::uuid and created_by is not null;
   ```

   All zero: run the delete. Anything above zero: stop and decide
   deliberately. Clearing those columns is not a tidy-up — `config_entry` and
   `notification_template` carry the trigger that refuses an unattributed
   write and writes its own audit row, and `config_entry_history` refuses
   direct writes altogether (`docs/database.md`). Deactivating those accounts
   instead, which is what migration 0002 intends, costs nothing and leaves
   the record intact.

   This is a departure from migration 0002's "deactivation, never deletion":
   chosen deliberately here, because the reset above already empties the
   audit trail.

   Wrap steps 3 and 4 in one transaction, so a failure leaves nothing half
   done:

   ```sql
   begin;
   select reset_all_test_data(
     '<admin app_user id>'::uuid, '<name/email> — reason for the clear'
   );
   delete from app_user
    where id <> '<admin app_user id>'::uuid
      and (entra_subject is null or entra_subject not like 'system:%');
   commit;
   ```

5. **What this does not reach: SharePoint.** `sharepoint_folder` rows go, but
   the filed documents stay in the library — the database cannot reach into
   SharePoint. Clear anything filed during a pilot there separately. See
   `docs/documents.md`.

6. **Recovery.** Only a database restore undoes this. See `docs/restore.md`.

## Backup and restore

See `docs/restore.md`. The short version: Azure's own automated backups, and a
restore that has actually been performed and verified against control figures
— an untested backup is an assumption, not a control.

## Escalation

1. **An officer cannot work** — a whole function is down: the technical lead,
   now.
2. **Member data may have been exposed or lost** — the technical lead and the
   System Administrator, now, and do not delete anything: the audit trail is
   the evidence.
3. **A security finding that recurs or is unresolved** — `SECURITY.md` names
   the path; no further changes are merged to the affected component until it
   is remediated.

## What is deliberately not automated

Recorded so nobody assumes otherwise:

- **Nothing watches the jobs.** A container that dies leaves a `running` row
  and no alert. **Reports → Scheduled work** shows it to whoever looks.
  `docs/jobs.md` proposes a job that watches the jobs; it is not built.
- **Nothing alerts on a failed notification.** The counts on **Notifications**
  are visible to whoever opens the page.
- **Branch protection is off**, by decision of the sole maintainer — see
  `SECURITY.md`. The audit informs the merge; it does not block it.
- **Nothing is disposed of yet**, though the mechanism is built. Every
  retention period ships unset, and unset means keep indefinitely. Disposal
  starts when somebody enters a number on **Configuration → Retention** —
  see `docs/retention.md`, which also puts the one question this cannot
  answer for the Society: whether to weaken the append-only audit trail in
  order to honour a period on it.
