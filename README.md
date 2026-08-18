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

| Variable                   | Description                                   |
| -------------------------- | --------------------------------------------- |
| `PUBLIC_SUPABASE_URL`      | Supabase project URL (Project Settings → API) |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key               |

The `PUBLIC_` prefix is required by Astro to expose these to the browser.
The anon key is safe to expose; never commit the `.env` file or any
service-role key.

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
├── lib/supabase/       # client, server, and config helpers
├── pages/              # index (redirect), login, dashboard
└── middleware.ts       # server-side auth guard
```

## Deployment

The project targets [Vercel](https://vercel.com/) via `@astrojs/vercel`.
Set the two Supabase environment variables in the Vercel project settings.
