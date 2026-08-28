# The database

Azure Database for PostgreSQL — Flexible Server, one server per environment.
The application is a set of serverless functions on Vercel, which shapes most
of the decisions below.

## Two roles, not one

| Role            | Used by                         | Rights                                 |
| --------------- | ------------------------------- | -------------------------------------- |
| schema owner    | migrations (`pnpm migrate`, CI) | Owns the tables; may change the schema |
| `albarakah_app` | the running application         | Read and write rows; **no DDL at all** |

The separation is the point: an SQL injection that reaches the application's
connection can, at worst, do what the application can do. It cannot drop a
table, add one, or alter a constraint. `migrations/0005_application_grants.sql`
sets this up and the tests in `scripts/schema.test.ts` assert it.

Two further restrictions apply to the application role:

- `audit_event` — insert only. Updates, deletes and truncates are refused by a
  trigger as well as by the grant, so they fail even for the owner.
- `config_entry_history` — no writes at all. History is written by a
  `SECURITY DEFINER` trigger, so it cannot be skipped or forged by writing to
  the table directly.
- `financial_event`, `payment_line`, `receipt_print` — insert only;
  `payment` and `receipt_number` cannot be deleted from at all. Voiding a
  receipt is an UPDATE, which is why those two keep the privilege. See
  `docs/payments.md`.

## Connections in the test suite

Each integration test calls a `load()` helper that runs `vi.resetModules()` and
re-imports the modules under test, which builds a **new** pool. The pool it
replaces must be closed — an abandoned one keeps its connections until they
idle out (10s), and a suite that loads a hundred times over a few seconds piles
them up until the server refuses:

```
remaining connection slots are reserved for roles with the SUPERUSER attribute
```

which surfaces as `The database is unavailable.` in whichever test happened to
be running, nowhere near the one that caused it.

So `load()` closes the pool it replaces, and `afterAll` closes the last one
before dropping the database. Measured on the full suite: **peak 84 concurrent
connections without that, 42 with it.** CI runs stock `postgres:16` — 100 max,
3 reserved for superusers, so 97 usable. The margin is the point; if the suite
grows enough to approach it again, the answer is to look for a pool that is not
being given back, not to raise the ceiling.

## Connection strings

Two variables, because the two roles are different:

- `DATABASE_URL` — the application. Least privilege. Set on Vercel.
- `DATABASE_MIGRATION_URL` — the schema owner. Set as a **GitHub Environment
  secret**, so the production credential is only readable by runs on the
  `production` branch. The running app never has it.

Both must carry **`?sslmode=verify-full`**.

This is not a formality. node-postgres gives the connection string's `sslmode`
**precedence over the explicit `ssl` option**: a client built with
`ssl: { rejectUnauthorized: true }` but a URL ending `?sslmode=disable` connects
in **plaintext**, silently. The URL, not the code, would decide whether member
data crosses the network encrypted.

So the application does not trust it. `normaliseSslMode` in `src/lib/config.ts`
rewrites the mode to match the environment's policy before the driver sees it:

| URL says                              | Deployed environment        | Local (`DATABASE_ALLOW_INSECURE=true`) |
| ------------------------------------- | --------------------------- | -------------------------------------- |
| `verify-full`, `verify-ca`, `require` | rewritten to `verify-full`  | rewritten to `disable`                 |
| nothing                               | `verify-full` added         | `disable` added                        |
| `disable`, `allow`, `prefer`          | **refused** — the run fails | rewritten to `disable`                 |

An existing `sslmode=require` therefore keeps working and is silently
strengthened. That also matters for the future: node-postgres treats `require`
as `verify-full` today, but **pg v9 will adopt libpq semantics, where `require`
encrypts without verifying the certificate** — a downgrade that would otherwise
arrive unnoticed on a routine dependency bump.

## Connection pooling

Serverless scales by process. Every warm instance holds its own pool, so the
number of connections the server sees is `DATABASE_POOL_MAX` multiplied by the
number of warm instances — which is why the default is **3**, not the usual
double figures. Azure's smaller SKUs cap `max_connections` in the low tens; a
Burstable B1ms allows around 50.

If sustained traffic outgrows that, the answer is **Azure's built-in PgBouncer**
(enable `pgbouncer` on the server and connect on port **6432**), not a larger
pool here.

## Setting up a new environment

Run these once per server, connected as the Azure admin account:

```sql
-- The application role. Generate the password; never reuse the admin's.
CREATE ROLE albarakah_app WITH LOGIN PASSWORD '<generated>';

CREATE DATABASE albarakah;
\c albarakah

-- Nothing is granted to PUBLIC by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE albarakah TO albarakah_app;
GRANT USAGE ON SCHEMA public TO albarakah_app;
```

The migrations then create the tables and grant the application its row-level
rights. Migration `0005` fails with a clear message if the role does not exist
yet, rather than silently granting nothing.

Two extensions must be allow-listed on the server before the first migration
runs (Azure blocks extensions by default). Add `PGCRYPTO` and `CITEXT` to the
server parameter `azure.extensions`, then apply.

## Configuration tables refuse an unattributed write

Every table migration 0010 creates carries a trigger that writes the change to
the audit trail and raises if the session has not declared who is acting. That
applies to the schema owner too, so a hand-edit at a psql prompt fails unless
it names itself:

```sql
begin;
set local albarakah.actor_description = 'your.name@albarakah.mu — ticket 123';
update account_type set minimum_opening_amount = 6000 where code = 'msa';
commit;
```

From the application, `withConfigurationActor()` does this. See
docs/configuration.md.

## Applying migrations

```bash
pnpm migrate:status   # what would be applied; changes nothing
pnpm migrate          # apply everything pending
```

Deployed environments are migrated by `.github/workflows/migrate.yml` on a merge
to `main` (test) or `production` (production). Nobody applies schema changes by
hand.

The runner is deliberately small enough to read in one sitting
(`scripts/migrate.ts`). Its rules:

- Plain `.sql` files in `migrations/`, applied in filename order.
- **Forward-only.** A migration that has been applied is never edited — the
  runner records a checksum and refuses to run if a file no longer matches what
  was applied.
- One transaction per migration, so a failure leaves the database exactly as it
  was and the run goes red.
- An advisory lock, so two pipeline runs cannot race.
- A database ahead of the checkout (a migration recorded but absent from the
  repository) is an error, not something to work around.

## Local development

```bash
bash scripts/dev-db.sh    # starts PostgreSQL on port 5433, creates both roles
pnpm migrate              # with DATABASE_MIGRATION_URL pointed at it
pnpm test
```

The script mirrors the deployed setup rather than being a convenient shortcut,
so code that accidentally relies on the application being able to change the
schema fails locally instead of in Azure.

## Networking, and an open decision

Vercel's serverless functions have **dynamic egress IPs** on the Hobby and Pro
plans, so there is no stable set of addresses to put in the Azure firewall.
That leaves three options, and this is not yet decided:

1. **Open the firewall wide**, relying on TLS and a strong password. Simplest,
   and the weakest posture — an auditor will ask about it.
2. **Vercel Secure Compute** — static egress IPs that can be allow-listed.
   Enterprise plan.
3. **Move the API into Azure** (App Service or Container Apps) with VNet
   integration and a private endpoint to PostgreSQL, keeping Vercel for the
   frontend only.

Option 3 is where a financial application usually ends up, and it would amend
ADR 0001, which currently assumes the backend runs on Vercel. It does not block
development — the schema, the runner and the data layer are the same either way
— but it should be settled before production holds real member data.

> **Direction set 26 August 2026: keep option 3 open.** Moving the API into
> Azure with VNet integration and a private-endpoint PostgreSQL remains on the
> table and must not be foreclosed. In practice that is a constraint on how code
> is written from here:
>
> - **No dependency on Vercel-specific runtime APIs** in business logic. The
>   data layer, the access layer and the API handlers must remain plain
>   TypeScript that would run unchanged under Node in a container.
> - **Nothing may assume the serverless request-body limit is permanent.** It
>   shapes the upload design today; it would not exist behind Azure compute.
> - **Configuration stays environment-variable driven**, so the same image runs
>   in either place.
>
> Jobs already run on Azure (see `docs/jobs.md`), so the pattern and the
> container are proven. Moving the API would be a deployment change, not a
> rewrite — which is the property worth protecting.

### The same problem applies to CI

GitHub-hosted runners also have dynamic egress IPs, so the migration workflow
hits the firewall exactly as the application does. The symptom is a **connection
timeout**, not a refusal or an authentication error:

```
Error: connect ETIMEDOUT 40.123.240.30:5432
```

`ETIMEDOUT` means packets are being dropped in transit — the firewall. A wrong
password gives an authentication error and a wrong host gives DNS failure or
`ECONNREFUSED`, so this symptom is specific.

GitHub publishes its runner ranges at `https://api.github.com/meta` (the
`actions` array), but there are thousands of them and they change, so
allow-listing them is not practical. The workable approaches are:

1. **Open the firewall broadly** while only the test database exists and holds
   no real data. Fastest, and acceptable only under those two conditions. It
   must be closed before production holds member data.
2. **Just-in-time firewall rule.** The workflow authenticates to Azure (a
   federated OIDC credential, no stored secret), adds a rule for the runner's
   own IP, migrates, then removes the rule. This is the standard answer for
   CI reaching a firewalled database and leaves nothing open between runs.
3. **A self-hosted runner inside the VNet**, reaching PostgreSQL over a private
   endpoint. Most control, most to operate.

Option 2 is the right long-term shape and pairs naturally with option 3 of the
application-side decision above.
