# ADR 0001 — Azure-native backend (Entra External ID + Azure PostgreSQL)

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Al Barakah MCSL
- **Applies to:** both environments (test and production)

## Context

Al Barakah is a financial application intended for long-term operation. The
initial foundation used Supabase (auth + Postgres) with the frontend on Vercel.
We want to standardise the backend on **Microsoft Azure managed services** for
both test and production, to reduce operational burden and strengthen the
compliance/audit posture expected of a financial institution.

The frontend stays on **Vercel** (Astro). Only the backend changes.

## Decision

Adopt an **Azure-native** backend:

| Concern          | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Identity / auth  | **Microsoft Entra External ID** (CIAM), OIDC Authorization Code + PKCE  |
| Database         | **Azure Database for PostgreSQL — Flexible Server**                     |
| Frontend hosting | **Vercel** (unchanged)                                                  |
| Environments     | Separate Entra app registration + Postgres per environment (test, prod) |

Supabase is retired once Entra + Postgres are verified.

### Login experience

Entra External ID uses a **redirect-based** sign-in (the app redirects to a
Microsoft-hosted, Al-Barakah-branded page; the user returns via a callback).
This replaces the current in-app email/password form. Rationale: the redirect
flow is the standard, well-audited pattern; Entra's "native authentication"
API (custom in-app form) is newer/preview and carries more risk for a financial
app. Entra can still be configured with **local email/password accounts**, so
staff sign in with an email + password — just on the Entra page.

## Why now

The only Supabase-specific code today is the **auth layer**, already isolated
behind a provider seam (`src/lib/auth`). There is **no data/module code yet**.
Switching auth now is small; switching after the FRD modules are built would be
far larger and riskier. This is the cheapest possible moment to migrate.

## Consequences

**Positive**

- Fully managed data + identity (backups, HA, patching, certifications) with
  first-party support; no self-hosted stack to operate.
- Enterprise-grade identity (MFA, conditional access) available when needed.
- Test and production run identical, managed software.

**Negative / trade-offs**

- Sign-in becomes a redirect flow; the current in-app form is retired.
- We own a data-access layer against Postgres (no auto REST API / RLS tooling
  that Supabase provided) — added when the first module lands.
- User provisioning moves from a script to Entra (invite/create users there).

## Migration plan (phased, no downtime)

The migration is complete apart from the data layer. Steps are kept here as the
record of how it was carried out; the status column reflects where we are.

| #   | Step                                                                                                                                                                            | Status                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | **Config seam** — a provider seam so auth could be swapped without touching pages                                                                                               | Done                                      |
| 2   | **Provision Azure** — Entra External ID tenant, user flow and app registration per environment; Azure Database for PostgreSQL Flexible Server per environment (checklist below) | Entra done; **Postgres outstanding**      |
| 3   | **Entra auth provider** — `providers/entra.ts` plus `/auth/login`, `/auth/callback`, `/auth/logout` (OIDC + PKCE, signed cookie session)                                        | Done                                      |
| 4   | **Flip test → prod** — verified against the real tenant on test, then production                                                                                                | Done                                      |
| 5   | **Data layer** — Postgres client + migrations, introduced with the first FRD module                                                                                             | **M1** — blocked on the Postgres instance |
| 6   | **Retire Supabase** — remove the Supabase provider, the `create-user` script and the deploy workflow                                                                            | Done                                      |

Entra is now the only auth provider: there is no `PUBLIC_AUTH_PROVIDER` switch
and no Supabase code path. Step 5 is the sole remaining item, tracked as
milestone M1 in [`../backlog.md`](../backlog.md).

## Open: where the API runs

This ADR places the frontend on Vercel and assumes the API runs there too. That
assumption is **explicitly held open**.

Jobs already run on Azure Container Apps (see `docs/jobs.md`), and the direction
set on 26 August 2026 is to keep open the option of moving the API there as
well, with VNet integration and a private-endpoint PostgreSQL — which would also
close the firewall question in `docs/database.md`.

Nothing should be written that would make that move a rewrite rather than a
deployment change. The constraints that follow from it are listed in
`docs/database.md`.

## Azure/Entra provisioning checklist (per environment)

**Entra External ID**

- Create an External ID (CIAM) tenant.
- Add an **email + password** user flow (sign-in only; self-service sign-up
  disabled — staff are invited/created by an admin).
- Register an application:
  - Redirect URI (web): `https://<app-url>/auth/callback`
  - Front-channel logout URL: `https://<app-url>/auth/logout`
  - Create a **client secret**; note the **client id**, **tenant id**, and the
    **authority** (e.g. `https://<tenant>.ciamlogin.com/`).
  - Grant delegated scopes: `openid`, `profile`, `email`, `offline_access`.

**Azure Database for PostgreSQL**

- Create a **Flexible Server** (per environment), note host/admin/password.
- Restrict network access (private endpoint or firewall allow-list).

These values populate the environment variables documented in `.env.example`
and are set per-scope in Vercel (Preview = test tenant/db, Production = prod).
