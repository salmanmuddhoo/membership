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

## Connection strings

Two variables, because the two roles are different:

- `DATABASE_URL` — the application. Least privilege. Set on Vercel.
- `DATABASE_MIGRATION_URL` — the schema owner. Set as a **GitHub Environment
  secret**, so the production credential is only readable by runs on the
  `production` branch. The running app never has it.

Both must carry `?sslmode=require`. The client verifies the certificate: the
code offers no "TLS without verification" setting, only verified TLS or (for a
local plaintext cluster) no TLS at all, and the latter is refused unless
`PUBLIC_APP_ENV` is set to something other than `production`.

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
