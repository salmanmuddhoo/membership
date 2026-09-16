# Security review

A manual review of the application ahead of the external penetration test
(S-1001). `SECURITY.md` covers the automated gate that runs on every pull
request — secrets, SAST, dependencies, misconfiguration. This is the part a
scanner does not do: reading the code for what it actually allows.

It is not a substitute for the external test. It is what makes that test worth
paying for, by removing the findings a tester would otherwise spend the
engagement writing up.

**Reviewed:** 16 September 2026, against `main`.

## What was found

### 1. Stored cross-site scripting in the guardian and member search — FIXED

**Severity: high.** An applicant's own typed name, reaching a member of
staff's browser as markup.

`CaptureFields.astro` rendered each search result by interpolating the
candidate's name, surname, reference and status into a string assigned to
`innerHTML`. Those values come from `application_party.values` — captured from
a form, not from any controlled vocabulary.

The reachability is what made it serious:

- **Anyone with a mobile number** can plant one. The member app's sign-up is
  public by design (`docs/member-app.md`): verify a number by one-time code,
  start an application, save any value into the applicant's `surname`.
- **The website can too**, since S-908. A public submission lands in
  `received`, and the guardian search matches every application
  `not in ('approved', 'rejected')` — `received` among them.
- It fires in a **staff** browser, in the application's own origin, with that
  officer's session. The session cookie is `httpOnly`, so the cookie itself is
  not readable; everything the cookie authorises is. A payload could approve
  an application, read the membership, or — against a System Administrator —
  issue itself an API credential.

Fixed by building the elements and setting `textContent`. No string is parsed
as HTML anywhere in the client code now, and
`src/lib/access/html-sinks.test.ts` fails the build if one is: it scans every
`.ts` and `.astro` file for `innerHTML`, `outerHTML`, `insertAdjacentHTML` and
`document.write`, and allows `set:html` only in the one file whose content
comes from route descriptors rather than from a person.

That guard was checked by reintroducing the original line, watching the test
name the file and line, and removing it again.

## What was checked and found sound

Recorded so the external test can start from what has already been covered,
and so a later reader can tell "not found" from "not looked at".

| Area                         | Finding                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQL injection**            | No query builds SQL from caller input. Four places interpolate, all verified: PostgreSQL catalogue identifiers (quoted), module constants, and literal condition fragments whose values are bound. Every filter in the reports, the notification log and the searches is a bound parameter.               |
| **Authorisation**            | Deny by default: a route absent from the map in `authorise.ts` is refused. Every `/api/v1` endpoint goes through a wrapper that enforces its declared permission — verified by scanning every file under `src/pages/api` for one of the three wrappers. `permission` cannot be omitted from a descriptor. |
| **Reports**                  | Each names an existing data permission rather than one of its own, checked when listing, again on the report page, and again on the export path.                                                                                                                                                          |
| **Horizontal access (IDOR)** | Member endpoints resolve through `loadOwned`, which scopes to the caller's own verified mobile or their own member record, and validates the id is a UUID before touching the database.                                                                                                                   |
| **Session**                  | Own HS256 JWT, `httpOnly`, `secure`, `SameSite=Lax`, eight hours, verified locally on every request. A staff cookie and a member token are signed with different secrets, so neither is usable as the other.                                                                                              |
| **OIDC**                     | `state`, PKCE `code_verifier` and `nonce` are all issued, stored in short-lived cookies, deleted on use and verified on callback. No redirect target comes from the request.                                                                                                                              |
| **API credentials**          | Secret stored only as a SHA-256, shown once. Checked against the database on every request, so a revoked credential stops immediately. Every authentication failure returns one message and one status, so credentials cannot be enumerated. Refusals are recorded.                                       |
| **Rate limiting**            | Database-backed, so it cannot be multiplied across warm instances. Per credential, per session, and a tighter ceiling on public endpoints. **Fails open** by deliberate decision — see `docs/api.md`; worth the tester's attention as a design choice rather than an oversight.                           |
| **File upload**              | Path traversal blocked (`..`, leading `/`, backslash) and the file name sanitised of path separators, SharePoint's forbidden set and control characters. Bytes go browser-to-Microsoft; completion is confirmed by asking Graph rather than trusting the client (S-408).                                  |
| **Secrets**                  | None in the repository; Gitleaks runs on every pull request and over history. Nothing secret is read into a client-side script, and no log statement writes a token, secret or password. Provider error bodies are truncated and carry no member data beyond an address already on the row.               |
| **Error handling**           | One envelope. An unexpected failure returns `internal_error` and a correlation id; the detail stays in the server log. Request bodies are never logged.                                                                                                                                                   |
| **Dependencies**             | `pnpm audit` reports no known vulnerability at `high` or above.                                                                                                                                                                                                                                           |
| **XSS elsewhere**            | Astro escapes `{expression}` in templates, so server-rendered member data is safe. The only other DOM construction (`members/index.astro`) uses `createElement` and `textContent`.                                                                                                                        |

## What this review did not and cannot cover

The external test is still needed for:

- **The deployed environment** rather than the code: TLS configuration, HTTP
  security headers as actually served, the Vercel and Azure surface, network
  exposure of the database.
- **The Entra and Microsoft 365 tenants**, including the scope of the
  `Mail.Send` application permission (see below).
- **Authenticated business-logic abuse** by a real staff role — approving
  outside segregation rules, receipt sequence manipulation — which needs
  someone working the application with intent.
- **Denial of service** and resource exhaustion under load.

## Two things for the Society to settle, not the code

**`Mail.Send` is tenant-wide.** Granted as an application permission it lets
this application send as **any** mailbox in the Graph tenant, not only the
notification address. `docs/notifications.md` names the Exchange application
access policy that narrows it to one mailbox. That is a tenant-side control
this repository cannot apply or verify.

**Retention periods are still unset.** The default is to retain indefinitely,
which is safe against loss and not compliant with any stated policy (S-1003,
and the open value M10 records). Nothing can be disposed of until the Society
states how long KYC and audit records are kept, and that decision gates the
disposal mechanism rather than the other way round.
