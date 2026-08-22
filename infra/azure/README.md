# Production on Azure — self-hosted Supabase

This sets up the **production** backend as a **self-hosted Supabase stack on
Azure**, while the frontend stays on **Vercel** and **test** keeps using a
managed Supabase project.

Because production still speaks the Supabase API, **the application needs no
code changes** — `PUBLIC_AUTH_PROVIDER` stays `supabase`, and the Production
Vercel scope simply points at the Azure-hosted Supabase URL and anon key.

```
Browser ──▶ Vercel (Astro app, Production scope)
                │  PUBLIC_SUPABASE_URL = https://api.your-domain.com
                ▼
        Azure VM (Docker)  ──▶  Caddy (TLS)  ──▶  Supabase stack (Kong :8000)
                │                                   ├─ GoTrue (auth)
                │                                   ├─ PostgREST (data API)
                │                                   └─ Studio, Storage, Realtime…
                ▼
        Postgres  (bundled in compose, or Azure Database for PostgreSQL)
```

## 0. Prerequisites

- An Azure subscription and the `az` CLI (`az login`).
- A domain you control (for the API host, e.g. `api.your-domain.com`).

## 1. Provision Azure infrastructure

Review and edit the variables at the top of `provision.sh`, then run it:

```bash
./infra/azure/provision.sh
```

It creates a resource group, an Ubuntu Docker-host VM with a static public IP
and DNS label, opens 80/443, installs Docker, and (optionally) creates an
Azure Database for PostgreSQL Flexible Server.

## 2. Point DNS at the VM

Create an `A` record `api.your-domain.com` → the VM's public IP (or a `CNAME`
to the `*.cloudapp.azure.com` label). Caddy needs this to issue TLS certs.

## 3. Deploy the Supabase stack on the VM

SSH into the VM, then:

```bash
# Official, maintained self-hosting compose (source of truth for the stack):
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
```

Fill `.env` using `infra/azure/supabase.env.example` in this repo as the guide
— set `JWT_SECRET`, `POSTGRES_PASSWORD`, `DASHBOARD_*`, generate `ANON_KEY` and
`SERVICE_ROLE_KEY` (see the link in that file), and set `API_EXTERNAL_URL` /
`SUPABASE_PUBLIC_URL` to `https://api.your-domain.com` and `SITE_URL` to the
Vercel app URL. Set `DISABLE_SIGNUP=true` (staff are provisioned, no public
sign-up). To use managed Azure Postgres instead of the bundled db, point the
Postgres host/credentials at your Flexible Server and remove the `db` service.

Start it, then put Caddy in front for TLS:

```bash
docker compose up -d
# Copy infra/azure/caddy/Caddyfile to the host (edit the domain), then:
docker run -d --name caddy --network host \
  -v $PWD/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data caddy:2
```

Verify: `https://api.your-domain.com/auth/v1/health` returns OK.

## 4. Wire the Vercel Production scope

In Vercel → Project → Settings → Environment Variables, set for **Production**
(leave Preview pointing at the test Supabase project):

| Variable                   | Value                         |
| -------------------------- | ----------------------------- |
| `PUBLIC_AUTH_PROVIDER`     | `supabase`                    |
| `PUBLIC_SUPABASE_URL`      | `https://api.your-domain.com` |
| `PUBLIC_SUPABASE_ANON_KEY` | the `ANON_KEY` you generated  |

Redeploy (these are inlined at build time).

## 5. Apply the database schema

The existing GitHub Actions workflow (`.github/workflows/supabase-deploy.yml`)
can target this instance. For a self-hosted DB, either:

- run migrations with the Supabase CLI against its connection string
  (`supabase db push --db-url "postgresql://postgres:...@api.your-domain.com:5432/postgres"`), or
- point the workflow's linked project at this host.

There are no migrations yet, so nothing runs until the first one is added.

## 6. Create the production admin user

From a machine that can reach the API:

```bash
SUPABASE_URL="https://api.your-domain.com" \
SUPABASE_SERVICE_ROLE_KEY="<the SERVICE_ROLE_KEY>" \
  pnpm create:user admin@albarakah.mu 'ChangeMe-Str0ng!'
```

## Operational notes

- **Backups:** use Azure Backup for the VM disk, and (if managed Postgres)
  its automated backups; otherwise schedule `pg_dump` off the VM.
- **Secrets:** keep `.env` and `SERVICE_ROLE_KEY` off git; store in Azure Key
  Vault or the VM only. Only `ANON_KEY` + URL are exposed to the browser.
- **Hardening:** restrict SSH (NSG source IP), enable automatic security
  updates, and consider Azure Container Apps or AKS instead of a single VM
  for HA once load justifies it.
- **Parity:** test (managed Supabase) and prod (self-hosted Supabase) run the
  same software, so behaviour matches — the only difference is the URL/keys.
