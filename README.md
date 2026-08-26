# Al Barakah MCSL — Web Application

Internal operations platform for **Al Barakah MCSL**, an Islamic finance
institution in Mauritius. This repository currently contains the cleaned
foundation: authentication and a protected application shell. Operational
modules (membership, financing, documents, approvals, reporting, etc.) will be
added later based on the Functional Requirements Document (FRD).

## Tech stack

- [Astro](https://astro.build/) (server output) — pages, routing, middleware
- [Tailwind CSS v4](https://tailwindcss.com/) + [Preline UI](https://preline.co/) — design system
- **Microsoft Entra External ID** — authentication (OIDC), via [`jose`](https://github.com/panva/jose)
- **Azure Database for PostgreSQL** — data store (added with the first module)
- [@astrojs/vercel](https://docs.astro.build/en/guides/integrations-guide/vercel/) — deployment adapter

The backend is **Azure-native** — see
[`docs/adr/0001-azure-native-backend.md`](docs/adr/0001-azure-native-backend.md).
The frontend is deployed on **Vercel**.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in your Entra values
pnpm dev
```

The app runs at `http://localhost:4321`. Sign-in requires a configured Entra
tenant (see below); until then the login page shows a "not configured" notice.

## Environment variables

The Entra values are **server-side secrets** (no `PUBLIC_` prefix — never sent
to the browser). The only browser-exposed one is `PUBLIC_APP_ENV` (a label).

Provide the OIDC endpoints **either** as `ENTRA_METADATA_URL` **or** as
`ENTRA_AUTHORITY` + `ENTRA_TENANT_ID`.

| Variable                         | Description                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_METADATA_URL`             | Exact "OpenID Connect metadata document" URL (App reg → Endpoints)                                                         |
| `ENTRA_AUTHORITY`                | `https://<subdomain>.ciamlogin.com/` — `<subdomain>` is the onmicrosoft prefix (a single label), **not** a business domain |
| `ENTRA_TENANT_ID`                | Directory (tenant) ID                                                                                                      |
| `ENTRA_CLIENT_ID`                | App registration (client) ID                                                                                               |
| `ENTRA_CLIENT_SECRET`            | App registration client secret                                                                                             |
| `ENTRA_REDIRECT_URI`             | `<app-url>/auth/callback`                                                                                                  |
| `ENTRA_POST_LOGOUT_REDIRECT_URI` | `<app-url>/login`                                                                                                          |
| `ENTRA_SCOPES`                   | `openid profile email offline_access` (default)                                                                            |
| `AUTH_SESSION_SECRET`            | Random string used to sign the session cookie                                                                              |
| `PUBLIC_APP_ENV`                 | Optional UI label; set `test` on the test env to show a "TEST" badge                                                       |

### Environments (test vs production)

Deployment is **Vercel only**, one project, two long-lived environments that
run the same code with their own env vars and their own Entra app registration
(and, later, their own Postgres database):

| Environment | Git branch   | Vercel environment | Promotion             |
| ----------- | ------------ | ------------------ | --------------------- |
| Test        | `main`       | custom env `test`  | auto on every merge   |
| Production  | `production` | Production         | promoted occasionally |

Promote by updating `production` from `main` (a PR `main → production` gives an
audit trail). Full setup and promotion steps:
[`docs/environments.md`](docs/environments.md).

## Authentication flow

Sign-in is a standard **OIDC Authorization Code + PKCE** redirect to Entra
(staff use email + password on the Entra-hosted page). Routes:

| Route            | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `/auth/login`    | Starts sign-in (PKCE, redirects to Entra)                  |
| `/auth/callback` | Exchanges the code, verifies the id_token, sets the cookie |
| `/auth/logout`   | Clears the session, redirects to Entra sign-out            |

The app then holds its **own** short-lived, signed session cookie
(`AUTH_SESSION_SECRET`); the middleware verifies it locally on every request —
no third-party tokens are stored. Guarding lives in `src/middleware.ts`:
unauthenticated users are sent to `/login`; the `/auth/*` routes are public.

## Routes

| Route        | Access        | Purpose                               |
| ------------ | ------------- | ------------------------------------- |
| `/`          | —             | Redirects to `/dashboard` or `/login` |
| `/login`     | Public        | Sign-in entry point                   |
| `/auth/*`    | Public        | OIDC handshake endpoints              |
| `/dashboard` | Authenticated | Application shell / placeholder       |

## Project structure

```text
src/
├── assets/styles/      # global Tailwind / Preline styles
├── components/         # BrandLogo, Meta, ThemeIcon, ui/icons
├── layouts/            # BaseLayout, AuthLayout, DashboardLayout
├── lib/
│   ├── config.ts       # Entra config (runtime env)
│   └── auth/
│       ├── types.ts        # AuthUser + ServerAuth
│       ├── server.ts       # createServerAuth(context)
│       ├── session.ts      # signed session cookie (jose)
│       └── providers/
│           └── entra.ts    # OIDC: discovery, PKCE, token/id_token, logout
├── pages/
│   ├── index.astro     # root redirect
│   ├── login.astro     # sign-in page
│   ├── dashboard.astro # placeholder
│   └── auth/           # login.ts, callback.ts, logout.ts
└── middleware.ts       # server-side auth guard

docs/adr/               # architecture decision records
```

## Setting up Azure

Create, **per environment**, an Entra External ID tenant + email/password user
flow + app registration (redirect `…/auth/callback`, a client secret, scopes
`openid profile email offline_access`), and an Azure Database for PostgreSQL
Flexible Server. Full checklist in the
[ADR](docs/adr/0001-azure-native-backend.md).

## Deployment

**Vercel** (Git integration + the `@astrojs/vercel` adapter), one project with
two environments:

- **Test** deploys automatically on every merge to `main`.
- **Production** deploys when `production` is updated — see
  [`docs/environments.md`](docs/environments.md) for the environment setup and
  the `main → production` promotion steps.

Set the environment variables above once per environment (test values on the
`test` custom env, production values on Production). Because Entra secrets are
read at runtime, they take effect on the next deploy.

## Planning

- [`docs/backlog.md`](docs/backlog.md) — the Phase 1 product backlog: 16 epics
  decomposed into features and user stories, with full acceptance criteria for
  the next three milestones.
- [`docs/adr/0001-azure-native-backend.md`](docs/adr/0001-azure-native-backend.md)
  — the backend architecture decision.
- [`docs/environments.md`](docs/environments.md) — test and production
  environments, and how a release is promoted.
- [`docs/database.md`](docs/database.md) — the two database roles, TLS, pooling
  and how migrations are applied.
- [`docs/access-control.md`](docs/access-control.md) — how a signed-in person is
  resolved to an account, how permissions are decided, and how to provision
  staff accounts.
- [`docs/api.md`](docs/api.md) — the `/api/v1` contract, how an endpoint is
  defined, and how the OpenAPI document stays current.

## Security & contributions

Every pull request into `main` or `production` must pass an automated security
audit (secrets, SAST, dependency and misconfiguration scanning) and a human
review before it can merge. See [`SECURITY.md`](SECURITY.md) for the policy and
[`docs/security-gate.md`](docs/security-gate.md) for how the gate is configured.
