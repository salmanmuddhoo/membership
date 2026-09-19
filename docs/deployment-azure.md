# Deploying to Azure instead of Vercel

This is for whoever runs the Society's Azure subscription and is taking
production off Vercel. It assumes you already know App Service, Flexible
Server and Entra — it does not re-explain them — and it tells you exactly
what in this repository has to change to make that possible, and what to
click and set once it does.

`docs/adr/0001-azure-native-backend.md` and the "Networking, and an open
decision" section of `docs/database.md` already anticipated this move
(direction set 26 August 2026: "moving the API into Azure would be a
deployment change, not a rewrite"). That is why this is mostly configuration:
the data layer, the access layer and the API handlers are plain TypeScript
with no Vercel-specific runtime dependency. The one place Vercel is actually
load-bearing is the Astro **adapter**.

## 1. What has to change in the repo

### The adapter

`astro.config.mjs` builds the app for Vercel's serverless functions today:

```js
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  site: 'https://al-barakah.example.com',
  prefetch: { prefetchAll: true, defaultStrategy: 'tap' },
  vite: {
    plugins: [tailwindcss()],
  },
});
```

App Service runs a long-lived Node process, not a function platform, so the
adapter has to change to `@astrojs/node` in `standalone` mode — it builds a
plain Node HTTP server rather than a set of Vercel functions:

```js
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: 'https://<your-production-domain>',
  prefetch: { prefetchAll: true, defaultStrategy: 'tap' },
  vite: {
    plugins: [tailwindcss()],
  },
});
```

`output: 'server'` stays as it is — nothing about server rendering or the
auth middleware changes, only which adapter packages the output.

And in `package.json`:

- Remove the `@astrojs/vercel` dependency.
- Add `@astrojs/node` as a dependency (not a devDependency — it is imported by
  `astro.config.mjs` at build time and its runtime is what `pnpm build`
  produces). **Pin it to the major version that supports Astro 7** — run
  `pnpm add @astrojs/node@latest` (or `npx astro add node`, which also edits
  `astro.config.mjs` for you) and let pnpm resolve the compatible version;
  this repo does not currently depend on it, so no version is verified here.
- The `start` script (currently `astro dev`, which is the **dev** server) is
  not what production runs. Production runs the build's own entry file
  directly:

  ```json
  "start": "node ./dist/server/entry.mjs"
  ```

  That is the file `astro build` emits with the node adapter in standalone
  mode. App Service's Node runtime looks for `npm start` (or the pnpm
  equivalent) by default, so this is what it will invoke — set it correctly
  or the deployment serves nothing.

This is a code change, committed to the branch that deploys to Azure — not a
setting you flip in the Azure portal. A portal setting cannot turn Vercel
serverless functions into a Node server; the build output itself is
different.

**Decision for you: test stays on Vercel, or moves too?** `docs/environments.md`
describes one Vercel project with a `test` custom environment (branch `main`)
and `production` (branch `production`). An Astro project has exactly one
adapter in `astro.config.mjs`, so once it is `@astrojs/node` the repo can no
longer build a Vercel deployment from that same config. If Test is to stay on
Vercel, you need either a second config/branch that keeps the Vercel adapter,
or to move Test to Azure as well (an App Service deployment slot, for
example) and retire the Vercel project entirely. This document does not
decide that for you — `docs/environments.md` is maintained separately and
will need its own update once you have.

### Security headers currently set by `vercel.json`

`vercel.json` sets the CSP, HSTS, `X-Frame-Options` and the other response
headers for every route, plus `regions: ["cpt1"]` to keep the compute next to
the South Africa North database. None of that is read by App Service.
`regions` has no Azure equivalent to set — see step 2, App Service region
choice, instead. The headers do need to exist somewhere, and as this is written they exist
nowhere else: `src/middleware.ts` sets none of them. **Moving off Vercel
without reproducing them drops the CSP, HSTS and the rest silently** — the
app keeps working, so nothing tells you it happened. Do this before Azure
serves any real traffic, not after.

Emit them from `src/middleware.ts` rather than as App Service response-header
rules: they then apply wherever the app runs, which is the platform
independence the ADR argues for, and they stay in review with the code
instead of in a portal nobody diffs. `vercel.json` is the list to work from
— copy it exactly, then delete it with the Vercel project.

### Nothing else in `src/` names Vercel

There is no `@astrojs/vercel` import anywhere under `src/` — the adapter is
only referenced from `astro.config.mjs` and `package.json`. `.vercel/` is a
local/CI build artifact (gitignored) and needs no action.

## 2. Which Azure services

| Service                                                      | Why                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Service (Linux, Node)**                                | Runs the standalone Node server the build produces. Choose the **Node 22 LTS** runtime stack to match what CI already builds and tests against (`node-version: 22` in every `.github/workflows/*.yml` job) — the repo pins no version in `package.json` itself, so this is your call to make explicit; consider adding an `engines.node` field once you do. |
| **Azure Database for PostgreSQL — Flexible Server**          | Already the database in every environment (`docs/database.md`, `docs/adr/0001-azure-native-backend.md`) — this does not change with the move off Vercel.                                                                                                                                                                                                    |
| **Microsoft Entra External ID (CIAM)** app registration      | Staff sign-in. Already exists per environment — see `docs/adr/0001-azure-native-backend.md`'s provisioning checklist. Only its **redirect URIs** need attention when the domain changes (step 4, below).                                                                                                                                                    |
| **Microsoft Graph app registration (Al Barakah 365 tenant)** | SharePoint document filing. Already set up and documented in full in `docs/documents.md` (`Sites.Selected` permission, per-site grant, `GRAPH_DRIVE_ID`) — nothing about it changes because the app moved off Vercel; do not re-provision it, just carry the same `GRAPH_*` values into App Service configuration (step 5).                                 |
| **GitHub Actions** (already in the repo)                     | Extend it to build, deploy to App Service and run migrations, rather than introducing a separate Azure DevOps or portal-ZIP path — see step 3.                                                                                                                                                                                                              |

## 3. Step by step to first deploy

1. **Resource group.** One per environment you are standing up on Azure (at
   minimum, production), in the same region as the database for latency —
   the existing database is **Azure South Africa North**
   (`docs/database.md`), so put App Service there too unless you have a
   reason not to.

2. **Azure Database for PostgreSQL Flexible Server**, if not already
   provisioned for this environment (it already exists for test/production
   per the ADR — reuse it if you are only moving compute, not the database).
   If provisioning fresh, follow `docs/database.md`'s "Setting up a new
   environment" section for the role/grant setup, and:
   - Allow-list the `PGCRYPTO` and `CITEXT` extensions on the server
     parameter `azure.extensions` before the first migration runs.
   - **TLS is mandatory.** `src/lib/config.ts`'s `normaliseSslMode` rewrites
     any `DATABASE_URL` to `sslmode=verify-full` in a deployed environment and
     **refuses to start** if the URL asks for anything weaker — production
     must use `?sslmode=verify-full` (or nothing; it gets added). Do not set
     `DATABASE_ALLOW_INSECURE` in Azure App Service — it is refused outright
     the moment `PUBLIC_APP_ENV` reads as production (unset counts as
     production), and it exists only for a local, TLS-less development
     cluster.
   - **Network access:** `docs/database.md` leaves this an open decision
     (firewall allow-list vs. private endpoint) precisely because Vercel's
     dynamic egress IPs made a firewall allow-list impractical. Moving
     compute to App Service removes that constraint — **VNet-integrate the
     App Service and use a private endpoint to the Flexible Server**, which
     is the option `docs/database.md` already names as "where a financial
     application usually ends up." If you are not ready for that on day one,
     a firewall allow-list scoped to App Service's outbound IPs (App Service
     on a non-Free tier gives you a stable set, under **Networking →
     Outbound IP addresses**) is the fallback — do not open the firewall
     wide in production.

3. **App Service plan and Web App.** Linux, Node 22. Create it in the same
   resource group and region as the database. If you went with a private
   endpoint in step 2, enable **VNet integration** on the Web App now, before
   first deploy, so the very first migration/connection attempt can reach the
   database.

4. **Deployment method: extend the existing GitHub Actions, not portal ZIP
   deploy.** The repo already has `.github/workflows/ci.yml` (build, format,
   `verify:routes`, `openapi:check`, `verify:migrations`, tests) and
   `.github/workflows/migrate.yml` (runs `pnpm migrate` against
   `DATABASE_MIGRATION_URL`, gated by a GitHub Environment per environment).
   Add a **deploy** job or workflow, gated the same way `migrate.yml` is (a
   GitHub Environment per Azure target, `main` → test, `production` →
   production), that runs after `ci.yml` succeeds:

   ```yaml
   name: Deploy to Azure

   on:
     workflow_run:
       workflows: [CI]
       types: [completed]
       branches: [main, production]

   permissions:
     id-token: write # for OIDC login to Azure — no stored publish profile
     contents: read

   concurrency:
     group: deploy-${{ github.ref }}
     cancel-in-progress: false

   jobs:
     deploy:
       if: ${{ github.event.workflow_run.conclusion == 'success' }}
       runs-on: ubuntu-latest
       environment: ${{ github.event.workflow_run.head_branch == 'production' && 'production' || 'test' }}
       steps:
         - uses: actions/checkout@v7
           with:
             ref: ${{ github.event.workflow_run.head_sha }}

         - uses: pnpm/action-setup@v6
           with:
             version: 10

         - uses: actions/setup-node@v7
           with:
             node-version: 22
             cache: pnpm

         - name: Install and build
           run: |
             pnpm install --frozen-lockfile
             pnpm build

         - name: Azure login (OIDC)
           uses: azure/login@v2
           with:
             client-id: ${{ secrets.AZURE_CLIENT_ID }}
             tenant-id: ${{ secrets.AZURE_TENANT_ID }}
             subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

         - name: Deploy to App Service
           uses: azure/webapps-deploy@v3
           with:
             app-name: <your-app-service-name>
             package: .
   ```

   Use **federated OIDC credentials** for `azure/login` (an Entra app
   registration with a federated credential trusting this GitHub repo/branch)
   rather than a stored publish-profile secret, for the same reason
   `docs/database.md` recommends OIDC for the just-in-time firewall rule
   idea — no long-lived Azure secret sitting in GitHub. Register that
   deploy-credential app registration in your own Azure AD tenant; it is
   unrelated to the two application registrations (`ENTRA_*`, `GRAPH_*`)
   already documented.

   This is a starting point, not a tuned pipeline — exact App Service
   deployment action inputs, the trigger shape (`workflow_run` vs. putting
   the deploy steps directly in `ci.yml`), and how many environments you
   stand up are yours to decide; nothing here is verified against a real
   Azure deployment.

5. **Migrations stay exactly as documented** — `.github/workflows/migrate.yml`
   already runs `pnpm migrate` against `DATABASE_MIGRATION_URL` (the schema
   owner, a GitHub Environment secret) after a merge to `main` or
   `production`. That workflow is platform-agnostic already: it does not
   touch Vercel or Azure compute, only the database. Nothing about it needs
   to change for this move, **except** the networking point in step 2 — if
   you put the database behind a private endpoint, the migration job (which
   runs on a GitHub-hosted runner, not inside your VNet) needs the
   just-in-time firewall rule or self-hosted-runner treatment
   `docs/database.md`'s "The same problem applies to CI" section already
   describes. Apply the same choice you made for the application's own
   network access.

## 4. The custom domain

1. **App Service → Custom domains → Add custom domain.** Enter the
   production hostname (e.g. `app.albarakah.mu` or whatever
   `docs/environments.md`'s production URL becomes).
2. **DNS records**, at your DNS provider (not Azure, unless Azure also hosts
   the zone):
   - A **CNAME** record for the hostname, pointing at
     `<your-app-service-name>.azurewebsites.net` — this is the normal path
     for a subdomain.
   - If the domain is a bare/apex domain that cannot take a CNAME, use an
     **A record** pointing at the Web App's inbound IP address (App Service
     → **Custom domains** shows it) plus a **TXT record**
     (`asuid.<hostname>` → the Web App's custom domain verification ID,
     also shown on that same screen) so Azure can verify you own the domain.
3. **Domain verification** in the portal once DNS has propagated.
4. **TLS: add a Managed Certificate** (App Service → Certificates → Managed
   certificates → free, auto-renewing) and bind it to the custom domain
   (SNI SSL binding).
5. **Enforce HTTPS.** App Service → Configuration → General settings →
   **HTTPS Only: On**. Do not rely on application-level redirects for this —
   `vercel.json`'s `upgrade-insecure-requests` CSP directive helps in-page but
   does not itself redirect a plain-HTTP request; App Service's own
   HTTPS-only switch is what actually refuses port 80.

### What must be updated when the domain changes

Everything below is **URL-derived** and must move together, or sign-in and
notifications break silently for the new domain while looking fine in the
old one:

- **`ENTRA_REDIRECT_URI`** and **`ENTRA_POST_LOGOUT_REDIRECT_URI`** — update
  in **both** places:
  1. App Service → Configuration → Application settings (the running app's
     values).
  2. The **Entra app registration itself** (Authentication → Redirect URIs /
     Front-channel logout URL) — `docs/adr/0001-azure-native-backend.md`'s
     checklist is where these were first set
     (`https://<app-url>/auth/callback`, `https://<app-url>/auth/logout`).
     `src/lib/config.ts`'s `getEntraConfig()` fails closed with
     `/login?error=config` if the app setting is missing, but a value that is
     merely **wrong** — pointing at the old domain — fails differently: Entra
     redirects back to a URI it does not recognise and rejects the handshake
     (`docs/runbook.md` calls this out as `/login?error=auth`, "a mismatched
     redirect URI"). Missing either half of this update is exactly the
     failure mode `docs/runbook.md`'s "Nobody can sign in" section describes.
- **`site` in `astro.config.mjs`** — the public site URL Astro bakes into the
  build (canonical links, etc). Update it to the new domain and rebuild;
  it is not an environment variable, so a config-only App Service change will
  not fix it.
- Nothing else found in this repo derives from the domain automatically —
  `GRAPH_*` values point at Microsoft's own tenant/drive, not at this app's
  URL, and `NOTIFY_*` similarly. If you introduce anything else that embeds
  the app's own URL (a webhook callback URL, for instance), add it to this
  list.

## 5. Where environment variables go

**App Service → Configuration → Application settings** for everything below.
For the values marked **secret**, prefer an **Azure Key Vault reference**
(`@Microsoft.KeyVault(SecretUri=...)` as the setting's value, with the Web
App's managed identity granted `get` on the vault) over pasting the secret
directly into Application settings — it gives you rotation and access
auditing without a redeploy, and keeps the secret out of the App Service
configuration export/ARM template.

This is every variable this repository's application code reads
(`src/lib/config.ts`, `src/lib/db/pool.ts`, `src/lib/documents/graph.ts`,
`src/lib/api/rate-limit.ts`, and `.env.example`):

| Variable                          | For                                                                                         | Secret? | Production value                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_METADATA_URL`              | Entra OIDC metadata document URL (or use the two below instead)                             | No      | From the Entra app registration's Endpoints panel                                                                                                                                         |
| `ENTRA_AUTHORITY`                 | Entra CIAM authority, alternative to the metadata URL                                       | No      | `https://<tenant-subdomain>.ciamlogin.com/`                                                                                                                                               |
| `ENTRA_TENANT_ID`                 | Entra CIAM tenant id                                                                        | No      | GUID from the app registration                                                                                                                                                            |
| `ENTRA_CLIENT_ID`                 | Entra app registration client id (sign-in)                                                  | No      | GUID                                                                                                                                                                                      |
| `ENTRA_CLIENT_SECRET`             | Entra app registration client secret (sign-in)                                              | **Yes** | Key Vault reference                                                                                                                                                                       |
| `ENTRA_REDIRECT_URI`              | OIDC callback URL — must match the app registration exactly                                 | No      | `https://<production-domain>/auth/callback` — update in both places (step 4)                                                                                                              |
| `ENTRA_POST_LOGOUT_REDIRECT_URI`  | Where Entra sends the user after sign-out                                                   | No      | `https://<production-domain>/login`                                                                                                                                                       |
| `ENTRA_SCOPES`                    | OIDC scopes requested                                                                       | No      | `openid profile email offline_access` (the default if unset)                                                                                                                              |
| `AUTH_SESSION_SECRET`             | Signs the staff session cookie                                                              | **Yes** | Key Vault reference; `openssl rand -base64 40`. Rotating it signs out every staff member at once (`docs/runbook.md`).                                                                     |
| `DATABASE_URL`                    | Application's Postgres connection (least-privilege role, no DDL)                            | **Yes** | Key Vault reference; `postgresql://albarakah_app:<password>@<server>.postgres.database.azure.com:5432/albarakah?sslmode=verify-full`                                                      |
| `DATABASE_MIGRATION_URL`          | Schema-owner connection, used only by the migration workflow                                | **Yes** | Set as a **GitHub Environment secret**, not on App Service — the running app never needs it (`docs/database.md`)                                                                          |
| `DATABASE_POOL_MAX`               | Per-instance connection pool ceiling                                                        | No      | Default `3`; raise only with a reason (`docs/database.md`)                                                                                                                                |
| `DATABASE_IDLE_TIMEOUT_MS`        | How long an idle pooled connection is kept                                                  | No      | Default `60000`                                                                                                                                                                           |
| `DATABASE_CONNECT_TIMEOUT_MS`     | Connection attempt timeout                                                                  | No      | Default `10000`                                                                                                                                                                           |
| `DATABASE_ALLOW_INSECURE`         | Opens a **plaintext** connection, for a local TLS-less cluster                              | No      | **Do not set in Azure.** Refused outright whenever `PUBLIC_APP_ENV` reads as production (unset counts as production) — `src/lib/config.ts` throws on startup. **Local development only.** |
| `GRAPH_TENANT_ID`                 | Microsoft Graph app registration tenant (Al Barakah 365 tenant — different from Entra CIAM) | No      | GUID — see `docs/documents.md`                                                                                                                                                            |
| `GRAPH_CLIENT_ID`                 | Graph app registration client id                                                            | No      | GUID                                                                                                                                                                                      |
| `GRAPH_CLIENT_SECRET`             | Graph app registration client secret                                                        | **Yes** | Key Vault reference                                                                                                                                                                       |
| `GRAPH_DRIVE_ID`                  | The SharePoint document library documents are filed in                                      | No      | From `GET /sites/{site-id}/drives`; production must use its **own** site, separate from test (`docs/documents.md`)                                                                        |
| `RATE_LIMIT_MAX_REQUESTS`         | API rate limit, requests per subject per window                                             | No      | Default `300` (`docs/api.md`)                                                                                                                                                             |
| `RATE_LIMIT_WINDOW_SECONDS`       | API rate limit window length                                                                | No      | Default `60`                                                                                                                                                                              |
| `RATE_LIMIT_DISABLED`             | Switches the rate limiter off entirely                                                      | No      | **Do not set in production.** Local/test work only.                                                                                                                                       |
| `MEMBER_SESSION_SECRET`           | Signs the member mobile app's access tokens — its own secret, never `AUTH_SESSION_SECRET`   | **Yes** | Key Vault reference; `openssl rand -base64 40`, at least 32 characters. Rotating signs out every member app user.                                                                         |
| `MEMBER_OTP_DELIVERY`             | How member one-time codes are sent (`http` in production)                                   | No      | `http`                                                                                                                                                                                    |
| `MEMBER_OTP_WEBHOOK_URL`          | SMS/WhatsApp gateway URL for OTPs, when `MEMBER_OTP_DELIVERY=http`                          | No      | The Society's gateway URL                                                                                                                                                                 |
| `MEMBER_OTP_WEBHOOK_TOKEN`        | Bearer token for that gateway                                                               | **Yes** | Key Vault reference                                                                                                                                                                       |
| `MEMBER_OTP_FIXED_CODE`           | A fixed OTP accepted on every challenge, to test without a gateway                          | No      | **Do not set in production** — refused outright whenever `PUBLIC_APP_ENV` reads as production.                                                                                            |
| `MEMBER_ACCESS_TOKEN_SECONDS`     | Member app access token lifetime                                                            | No      | Default `3600`                                                                                                                                                                            |
| `MEMBER_REFRESH_TOKEN_DAYS`       | Member app refresh token lifetime                                                           | No      | Default `90`                                                                                                                                                                              |
| `NOTIFY_EMAIL_DELIVERY`           | Email channel: `graph` (Society's M365 mailbox) or `http` in production                     | No      | `graph`                                                                                                                                                                                   |
| `NOTIFY_EMAIL_FROM`               | Mailbox mail is sent as, for `graph` delivery — must be in the Graph tenant                 | No      | e.g. `noreply@albarakah.mu`                                                                                                                                                               |
| `NOTIFY_EMAIL_WEBHOOK_URL`        | Gateway URL, if `NOTIFY_EMAIL_DELIVERY=http`                                                | No      | Only if using `http` delivery                                                                                                                                                             |
| `NOTIFY_EMAIL_WEBHOOK_TOKEN`      | Bearer token for that gateway                                                               | **Yes** | Key Vault reference, only if using `http` delivery                                                                                                                                        |
| `NOTIFY_WHATSAPP_DELIVERY`        | WhatsApp channel: `cloud_api` (Meta direct) or `http` in production                         | No      | `cloud_api`                                                                                                                                                                               |
| `NOTIFY_WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Business phone number id, for `cloud_api`                                     | No      | From Meta Business settings                                                                                                                                                               |
| `NOTIFY_WHATSAPP_TOKEN`           | Meta permanent system-user token, for `cloud_api`                                           | **Yes** | Key Vault reference. Rotating: WhatsApp sends fail and are retried, nothing lost (`docs/runbook.md`).                                                                                     |
| `NOTIFY_WHATSAPP_API_VERSION`     | Pin a specific Graph API version for WhatsApp                                               | No      | Optional                                                                                                                                                                                  |
| `NOTIFY_WHATSAPP_BASE_URL`        | Override the WhatsApp Cloud API base URL                                                    | No      | Optional                                                                                                                                                                                  |
| `NOTIFY_WHATSAPP_WEBHOOK_URL`     | Gateway URL, if either notify channel uses `http` delivery                                  | No      | Only if using `http` delivery                                                                                                                                                             |
| `NOTIFY_WHATSAPP_WEBHOOK_TOKEN`   | Bearer token for that gateway                                                               | **Yes** | Key Vault reference, only if using `http` delivery                                                                                                                                        |
| `PUBLIC_APP_ENV`                  | UI "TEST" badge, and the safety flag every `*_ONLY`/insecure setting above checks           | No      | **Leave unset (or `production`) in production.** Set to `test` only on the test environment.                                                                                              |

`NOTIFY_EMAIL_DELIVERY=log` and `NOTIFY_WHATSAPP_DELIVERY=log` are the same
shape of local-only escape hatch as `DATABASE_ALLOW_INSECURE` and
`MEMBER_OTP_DELIVERY=log` — do not set either in production; `getNotificationConfig()`
demotes a `log` channel to `unconfigured` in production regardless, so setting
it there would only silently stop that channel rather than actually log
anything.

Two more are development-only and absent from the table for the same reason:
`GRAPH_BASE_URL` and `GRAPH_LOGIN_URL` override where the Graph client
points, so a developer can run the whole upload path against a local stub.
Set in Azure they would send every member document somewhere that is not
SharePoint. Leave both unset; the defaults are Microsoft's own endpoints.

The notification variables are built from a shared prefix
(`channelDelivery('NOTIFY_EMAIL', …)` / `'NOTIFY_WHATSAPP'`), so the code
technically accepts `NOTIFY_EMAIL_PHONE_NUMBER_ID` and `NOTIFY_EMAIL_TOKEN`
too. They mean nothing for email — Microsoft 365 sends mail, not WhatsApp —
and are left out of the table deliberately rather than by oversight.

## 6. After deploying

- **Run the repo's own gates against the new build**, the same ones CI
  already runs: `pnpm verify:routes` (every declared page is reachable in the
  build output — written for the Vercel adapter's route manifest; confirm it
  still reads what `@astrojs/node` produces, or treat this as something to
  verify once, not assumed), `pnpm openapi:check` (the committed OpenAPI
  document matches every `defineEndpoint`), and `pnpm verify:migrations`
  (no already-applied migration was edited). All three already run in
  `.github/workflows/ci.yml` on every PR; nothing new to add there, just
  confirm they still pass once the adapter changes.
- **Health check:** `GET /api/v1/health`, signed in — reports whether the
  database is reachable and whether the Graph/SharePoint settings are
  present (`src/pages/api/v1/health.ts`). Point App Service's own **Health
  check** (Monitoring → Health check) at it if you want App Service to
  recycle an unhealthy instance automatically; note it requires
  authentication, so a plain unauthenticated ping will get a 401, not a
  200 — App Service's health check feature does support this via warm-up,
  but confirm behaviour against an authenticated probe before relying on it.
- **Logs:** App Service → **Log stream** for live stdout/stderr (what
  `console.error('[db] query failed:', err)`-style logging in
  `src/lib/db/pool.ts` and elsewhere lands as). For anything beyond
  live-tailing — searching by the `x-correlation-id` header
  `docs/runbook.md` builds its whole "first moves" section around — wire up
  **Application Insights** (App Service → Application Insights → enable) so
  those logs are queryable rather than only streamable. `docs/runbook.md`'s
  guidance currently says "one search of the Vercel logs for that id" —
  once Azure is where logs live, that becomes a Log Analytics/Application
  Insights query instead, and `docs/runbook.md` (maintained separately) will
  need that pointer updated.
- Everything else about day-to-day operation — rotating secrets, diagnosing
  a symptom, the scheduled jobs, backup/restore — is unchanged by this move
  and already covered in `docs/runbook.md`. Read it.

## 7. What is left behind

Once Azure is serving production and you are confident in it:

- **Vercel project:** remove the `production` environment/branch mapping (or
  the whole project, if Test also moved to Azure) so nothing accidentally
  still resolves the old domain or holds a stale copy of the secrets in
  step 5.
- **DNS:** remove any record still pointing the production hostname at
  Vercel once the Azure custom domain (step 4) is live and verified — do
  this only after the cutover, not before, so there is no window with no
  working domain.
- **The Entra app registration's redirect URIs:** remove the old Vercel
  hostname's callback/logout URLs once nothing uses them, so a stale entry
  is not sitting there as an unused-but-valid redirect target.
- **Repo cleanup:** `vercel.json` and the `@astrojs/vercel` dependency (once
  its config lines are removed per step 1) have no purpose once nothing
  deploys to Vercel — delete them in the same change that removes the
  adapter, rather than leaving dead configuration for the next person to
  puzzle over. If a `regions` equivalent or the response headers moved into
  `src/middleware.ts` per step 1, confirm that happened before deleting
  `vercel.json`, not after.
