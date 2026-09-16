# Functional testing a deployment

`pnpm test` proves the code. This proves a **deployment**: the real Entra
sign-in, the real database, the real SharePoint tenant, served the way Vercel
actually serves it. Nothing in it is mocked, which is the point — and the
reason it writes real data.

Run it against **Test**. There is a guard that stops the run if the target does
not identify itself as non-production.

## What it covers

| Spec                    | What it walks                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `00-environment`        | The badge says this is not Production; the database and integrations answer                                                       |
| `01-membership-journey` | An Individual application: capture → documents → payment and receipt → submit → verify → forward → approve → member with accounts |
| `02-access`             | What each of the five roles can and cannot open, and that signing out ends the session                                            |
| `03-operations`         | Receipt reconciliation, every report, notification wording, retention periods, the API reference, the audit trail                 |

The journey is walked as **five different people**, because segregation of
duties means it has to be: the officer who captures may not review, and the
Secretary may not approve. A suite running as one account could never reach
approved — it would be stopped by the control it is meant to be testing.

## What you need first

**Five accounts in the Test Entra tenant**, each with an `app_user` row and one
role:

| Role                   | Needs to                                   |
| ---------------------- | ------------------------------------------ |
| `regional_officer`     | Capture, file documents, take the payment  |
| `secretary`            | Verify documents, forward to the President |
| `president`            | Approve                                    |
| `treasurer`            | Reconcile the receipt sequence             |
| `system_administrator` | Configuration, audit log, API, retention   |

That is not an inconvenience the tests invented — it is S-1004's own work,
provisioning real people with real roles, done before go-live rather than on
it. Set them up in **Staff accounts** and **Roles**.

## Running it

```bash
pnpm install
npx playwright install chromium        # once

export E2E_BASE_URL=https://<your-test-deployment>

pnpm e2e:login                         # sign in once per role, in a real browser
pnpm e2e                               # run the suite
pnpm e2e:report                        # open the report
```

`pnpm e2e:login` opens a browser and waits for you to sign in — MFA, a one-time
code, whatever your tenant asks for. It saves the session so the tests can
reuse it. Sessions expire after eight hours and the suite refuses one older
than seven, so expect to run it again the next day.

To capture one role only: `pnpm e2e:login secretary`.

### If your test accounts have no MFA

```bash
export E2E_AUTH_MODE=password
export E2E_OFFICER_EMAIL=... E2E_OFFICER_PASSWORD=...
# ... and the same for SECRETARY, PRESIDENT, TREASURER, ADMIN
```

The script types the credentials itself. It reaches Microsoft's own pages,
which change without notice, so treat a failure here as "use the manual mode"
rather than as a defect in this application.

### Against a developer's own machine

```bash
export E2E_AUTH_MODE=local
export AUTH_SESSION_SECRET=<the local one>
export E2E_OFFICER_SUBJECT=... E2E_OFFICER_EMAIL=...   # per role
```

Mints the session cookie directly, with no Entra at all. It exercises every
screen and the whole journey, and proves nothing about sign-in.

## What it writes, and how to find it again

Everything the suite creates carries a run id in the applicant's surname —
`Testcase-T3K9F2`, and the run prints it at the end. So a person looking at the
Test database afterwards can tell the suite's rows from an officer's real ones,
and a second run never collides with the first.

It leaves behind, per run: one application, one member with the accounts their
membership type opens, one payment, **one consumed receipt number**, and the
documents filed against it in SharePoint.

The receipt number is the one that does not come back. Receipt serials are
allocated in sequence and a consumed one is gone (S-502) — which is exactly why
the guard at the top refuses to run against Production.

To clear it all down: `/admin/reset-data`, which is refused outright unless
`PUBLIC_APP_ENV` marks the deployment non-production.

## Reading a failure

Each failing test says what it expected in the terms of the job rather than the
terms of the DOM — "Approval should have created a member with a membership
number", not "expected 1 element". `pnpm e2e:report` opens the run with a
screenshot, a video and a trace of every failure, so a finding can be handed to
somebody without them having to reproduce it first.

Three kinds of failure, and they mean different things:

- **A step of the journey fails.** Something in the application is broken.
  That is a defect.
- **An access test fails.** Usually this deployment's own role grants, edited
  from Configuration → Roles, rather than a code defect. The message says which
  role and which page.
- **A setup test fails.** An account is missing, has no role, or its saved
  session has expired. Nothing has been tested yet.

## What it deliberately does not cover

- **Anything about money beyond one payment.** It records one and checks the
  receipt sequence; it does not test refunds, voids or variance.
- **The member app and the public API.** Both have their own surfaces.
- **Load, concurrency, or two officers acting on one application at once.**
- **Email and WhatsApp actually arriving.** It reports what each channel is
  configured with and checks the wording exists. **Send test** on
  **Notifications** is how you prove delivery, and it needs a real recipient.

## Adding to it

Address fields by their `name`, not by their label: the names come from the
membership type's own field keys, which are the system's contract, and a test
that breaks because a field key changed is reporting something real where one
that breaks because a label was reworded is noise.

Assert on what the job requires, not on what the deployment happens to be
configured with. Which documents a checklist asks for, which accounts a
membership opens and what the fees are all differ per deployment; `fixtures.ts`
reads them from the page rather than naming them, and anything new should too.
