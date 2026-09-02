# Environments & promotion

Two long-lived environments, one Vercel project, one repository.

| Environment    | Git branch   | Vercel environment           | Backend (Entra app / DB)         |
| -------------- | ------------ | ---------------------------- | -------------------------------- |
| **Test**       | `main`       | Vercel **custom env** "test" | test Entra app (+ test DB later) |
| **Production** | `production` | Vercel **Production**        | prod Entra app (+ prod DB later) |

- Every merge to `main` auto-deploys to **Test**.
- **Production** deploys only when the `production` branch is updated — i.e. when
  you promote. It is never deployed automatically from `main`.

## One-time Vercel setup

1. **Project → Settings → Git → Production Branch** → set to **`production`**.
2. **Project → Settings → Environments** → add a **custom environment** named
   `test` and attach it to the **`main`** branch (gives it a stable URL).
3. **Environment Variables** — add the app's variables **twice**, scoped to the
   right environment:
   - **Production** scope → the **production** Entra app's values + prod URLs.
   - **test** custom env → the **test** Entra app's values + test URLs.
     Set `PUBLIC_APP_ENV=test` on the test env (a "TEST" badge then shows in the
     UI). Leave it `production` (or unset) on Production.

Because each environment has its own URL, each needs its **own Entra app
registration** with that environment's redirect URIs
(`https://<env-url>/auth/callback` and `.../login`).

## Promoting `main` → Production

Do this when a tested `main` should go live. Prefer a PR for the audit trail:

```bash
# Option A — PR (recommended: reviewable, recorded)
#   Open a pull request from `main` into `production` and merge it.

# Option B — fast-forward from the CLI
git fetch origin
git checkout production
git merge --ff-only origin/main
git push origin production
```

`production` only ever receives from `main`, so it stays a linear subset of
`main` and fast-forwards cleanly. Do not commit directly to `production`.

## Adding the database later

When the Postgres data layer lands, give each environment its **own** Azure
Database for PostgreSQL and set its connection string per Vercel environment —
same split as the Entra apps above. Never point Test at the production database.

## Resetting Test back to empty

A System Administrator can wipe every member, application, document, payment
and receipt on **Test** — `/admin/reset-data`, gated by the `system.reset_data`
permission — for a clean slate between rounds of testing. Staff accounts,
roles and reference configuration (membership types, fees, the document
checklist) are left alone; only what a member or an application actually
touches is removed. See `docs/database.md` for what makes that possible at
the database level.

**This is refused outright unless `PUBLIC_APP_ENV` marks the deployment as
non-production** — the same flag this page already asks you to set to `test`
on the Test custom environment, above. There is no override: an unset or
`production` value is read as production, never as permission, so nothing
short of that Vercel environment variable being wrong can put this within
reach of the real database. It never runs on Production, because Production
does not set it.
