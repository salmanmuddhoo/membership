# Al Barakah MCSL — Web Application

Internal operations platform for **Al Barakah MCSL**, an Islamic finance
institution in Mauritius. This repository currently contains the cleaned
foundation: authentication and a protected application shell. Operational
modules (membership, financing, documents, approvals, reporting, etc.) will be
added later based on the Functional Requirements Document (FRD).

## Tech stack

- [Astro](https://astro.build/) (server output) — pages, routing, middleware
- [Tailwind CSS v4](https://tailwindcss.com/) + [Preline UI](https://preline.co/) — design system
- [Supabase](https://supabase.com/) — email/password authentication & sessions
- [@astrojs/vercel](https://docs.astro.build/en/guides/integrations-guide/vercel/) — deployment adapter

## Getting started

```bash
pnpm install
cp .env.example .env   # then fill in your Supabase values
pnpm dev
```

The app runs at `http://localhost:4321`.

## Environment variables

| Variable                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `PUBLIC_AUTH_PROVIDER`     | Backend provider: `supabase` (default) or `azure` |
| `PUBLIC_SUPABASE_URL`      | Supabase project URL (Project Settings → API)     |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key                   |

The `PUBLIC_` prefix is required by Astro to expose these to the browser.
The anon key is safe to expose; never commit the `.env` file or any
service-role key.

> On Vercel these must be set **before** the build runs (they are inlined at
> build time) and take effect on the next deployment.

### Environments (test vs production)

Deployment is **Vercel only**. Test and production are separated purely by
environment variables — the same code runs in both:

| Environment | Vercel scope | Backend                                |
| ----------- | ------------ | -------------------------------------- |
| Test        | Preview      | A dedicated **test** Supabase project  |
| Production  | Production   | Supabase today (a future Azure option) |

Point each Vercel scope at its own Supabase project via the variables above.

### Swapping the backend (Supabase → Azure) later

Production may stay on Supabase or move to Azure. The app never talks to a
backend directly — it goes through a provider seam so a switch is a localized
change, not a rewrite:

```
src/lib/
├── config.ts              # getBackendProvider() reads PUBLIC_AUTH_PROVIDER
└── auth/
    ├── types.ts           # AuthUser + provider-agnostic contracts
    ├── server.ts          # createServerAuth(context)  — used by middleware
    ├── client.ts          # getBrowserAuth()           — used by login/logout
    └── providers/
        └── supabase.ts    # the only Supabase-specific code
```

To add Azure: implement an `azure.ts` provider satisfying the same contracts
(e.g. Entra ID for auth), wire it into the two `switch` statements in
`auth/server.ts` and `auth/client.ts`, and set `PUBLIC_AUTH_PROVIDER=azure`
for the production scope. Nothing else in the app changes.

## Creating a staff / admin user

There is no public sign-up — accounts are provisioned by an administrator.

**Option A — Supabase dashboard:** Authentication → Users → **Add user**, enter
the email and password, and enable "Auto Confirm User".

**Option B — script (repeatable):**

```bash
# Needs SUPABASE_URL and the service-role key (a secret — never commit it).
SUPABASE_URL="https://your-ref.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
  pnpm create:user admin@albarakah.mu 'ChangeMe-Str0ng!'
```

The user is created already confirmed, with `role: admin` in its metadata, and
can sign in immediately at `/login`. (Role-based access control itself is
deferred to the FRD; this only tags the account.)

## Routes

| Route        | Access        | Purpose                                   |
| ------------ | ------------- | ----------------------------------------- |
| `/`          | —             | Redirects to `/dashboard` or `/login`     |
| `/login`     | Public        | Email + password sign-in                  |
| `/dashboard` | Authenticated | Application shell / placeholder dashboard |

Authentication is enforced server-side in `src/middleware.ts`:
unauthenticated users are redirected to `/login`, and authenticated users are
redirected away from `/login`.

## Scripts

```bash
pnpm dev            # start the dev server
pnpm build          # type-check (astro check) + production build
pnpm preview        # preview the production build
pnpm format:fix     # format with Prettier
```

## Project structure

```text
src/
├── assets/styles/      # global Tailwind / Preline styles
├── components/         # BrandLogo, Meta, ThemeIcon, ui/icons
├── layouts/            # BaseLayout, AuthLayout, DashboardLayout
├── lib/                # config + auth provider seam (see below)
├── pages/              # index (redirect), login, dashboard
└── middleware.ts       # server-side auth guard

supabase/
├── config.toml         # Supabase CLI config
└── migrations/         # SQL migrations (applied on merge to main)

scripts/
└── create-user.mjs     # provision a staff/admin account
```

## Deployment

Both deployments happen automatically when changes land on `main`:

**App → Vercel.** Connected via Vercel's Git integration and the
`@astrojs/vercel` adapter; every push to `main` triggers a production deploy.
Set `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` in the Vercel project
(Production + Preview), and update `site` in `astro.config.mjs` to the real
domain.

**Database → Supabase.** `.github/workflows/supabase-deploy.yml` runs
`supabase db push` whenever files under `supabase/migrations/**` reach `main`,
applying pending migrations to the linked project. Add these **GitHub Actions
secrets** (Settings → Secrets and variables → Actions):

| Secret                  | Where to find it                          |
| ----------------------- | ----------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | Supabase account → Access Tokens          |
| `SUPABASE_PROJECT_REF`  | Project Settings → General → Reference ID |
| `SUPABASE_DB_PASSWORD`  | The database password set for the project |

Create migrations locally with `supabase migration new <name>`; there are none
yet, so the workflow is a no-op until the first one is added.

### Production on Azure (optional)

Production can run a **self-hosted Supabase stack on Azure** while the frontend
stays on Vercel and test keeps using managed Supabase. Because production still
speaks the Supabase API, the app needs **no code changes** — only the Vercel
Production env vars point at the Azure-hosted URL/anon key. See
[`infra/azure/README.md`](infra/azure/README.md) for the runbook and the
provisioning scaffold.
