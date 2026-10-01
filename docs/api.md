# The API

Versioned at `/api/v1`, consumed by this application today and by the member
mobile application from Phase 4 (AD-03). Because two clients depend on it, the
response shape is a contract rather than an implementation detail.

## Every response has the same shape

Success:

```json
{ "data": { "...": "..." }, "correlationId": "lhr1::abc123" }
```

Failure:

```json
{
  "error": {
    "code": "forbidden",
    "message": "You do not have access to this resource.",
    "correlationId": "lhr1::abc123"
  }
}
```

`code` is stable and safe to branch on. `message` is written for the person
reading it, never for the developer — an unexpected failure says only that
something went wrong. The stack trace, the SQL and the host name stay in the
server log, findable by `correlationId`, which is also returned in the
`x-correlation-id` header.

| Code                | Status | Meaning                                                                                     |
| ------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `unauthenticated`   | 401    | Not signed in                                                                               |
| `forbidden`         | 403    | Signed in but not permitted — **also** returned when the session belongs to no account here |
| `not_found`         | 404    | No such resource                                                                            |
| `validation_failed` | 422    | Rejected input; `details` carries field messages                                            |
| `conflict`          | 409    | Conflicts with current state                                                                |
| `rate_limited`      | 429    | Too many requests; see `retry-after`                                                        |
| `internal_error`    | 500    | A defect. Quote the correlation id                                                          |

`forbidden` deliberately covers two different situations. Distinguishing "you
have no account" from "you lack this permission" would tell an unknown caller
whether an account exists; the distinction is recorded in the audit trail
instead.

## Two callers, two wrappers

Staff reach `/api/v1` with the session cookie and every endpoint carries a
staff permission. The member mobile application reaches `/api/v1/member`
with a bearer token and has no permissions at all — every handler there is
scoped to the caller's own record by construction. The second surface is
built with `defineMemberEndpoint` (`lib/member/endpoint.ts`): same
descriptor, same envelope, same rate limiter and log line, a different
caller. See `docs/member-app.md`. The middleware never resolves a cookie
under `/api/v1/member/`, and `defineEndpoint` never resolves a bearer
token, so neither kind of credential reaches the other's endpoints.

## Defining an endpoint

There is one way for a staff endpoint, and it is not optional:

```ts
const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/members/{id}',
    summary: 'Fetch a member',
    tag: 'Membership',
    permission: 'member.view',
    responseSchema: {/* OpenAPI schema for `data` */},
  },
  async ({ principal, correlationId }) => {
    return apiSuccess(member, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
```

The wrapper resolves the caller, enforces the permission, applies the rate
limit, logs the request and converts anything thrown into the envelope. A
handler cannot skip any of it, because there is no way to write an endpoint that
bypasses the wrapper.

`permission: null` means "any signed-in, active account". It has to be written
deliberately — the field cannot be omitted, so an endpoint is never left
unprotected by forgetting something.

Throw `ApiError` for an expected failure. Anything else that escapes becomes
`internal_error`, so a forgotten `throw` cannot leak internals.

A handler reads a JSON body with `body<T>()`, which fails as
`validation_failed` when there is none.

### Idempotent writes

A write that must not happen twice declares `idempotent: true` (S-1308). The
wrapper then refuses a request without an `Idempotency-Key` header
(`validation_failed`), hands the key to the handler as `idempotencyKey`, and
the generated document states the header and the 409. What the key means is
the service's: `recordDeposit` answers the same key with the same request by
returning the original and refuses the same key with a different request as
a `conflict`, so a double-click or a dropped connection cannot move money
twice. The key is unique per acting user (`transaction_idempotency_idx`),
bounded to 128 characters, and stored on the row it protects.

## Documentation is generated, not written

`docs/openapi.json` is produced from the descriptors:

```bash
pnpm openapi:generate   # rewrite the document
pnpm openapi:check      # fail if it has drifted (runs in CI)
```

An endpoint file that exports no `descriptor` **fails the check by name**, so an
endpoint cannot be added without being documented. A committed document that has
drifted from the routes fails too — stale documentation is worse than none,
because an integrator trusts it.

## Reading it inside the application

**API** (`/admin/api`) renders the same generated document grouped by
category, with each endpoint's parameters, request and response schemas, and
the permission it needs. The category is the descriptor's tag, and since
S-2103 the tags follow the thing an integrator is after rather than who is
calling: an account's balance, history, statement and transactions sit under
**Accounts** and a deposit, withdrawal, transfer, reversal or exit under
**Transactions**, whether the caller is an officer with a permission or the
member app with a session — the permission line says which. **Member app**
keeps what is only the app's: identity, applications, documents, the
reference. Because it reads `docs/openapi.json`, it cannot drift
from the routes: an endpoint missing a descriptor fails the build, and a stale
committed document fails `pnpm openapi:check`.

It can also make the request. That is an ordinary same-origin call carrying the
officer's own session cookie, so it goes through the same middleware, the same
per-endpoint permission check and the same rate limit as any other caller —
**the page grants no access**. It removes the need for a separate HTTP client,
nothing more.

What it does change is how easy a destructive call becomes: one button rather
than a deliberately composed request. So anything that is not a `GET` is held
behind a switch that has to be turned on first. Reaching the page at all needs
`api.explore`, which starts out granted to System Administrator only.

## A third caller: machines

`/api/v1/public` is reached by a server rather than a person — Albarakah.mu
submitting an application (S-908). It is built with
`defineIntegrationEndpoint` (`lib/api/integration-endpoint.ts`): same
descriptor, same envelope, same log line, and a credential instead of a
session.

Nobody is present, so what a person's own caution would cover has to be
structural:

- **The credential is checked against the database on every request**, never
  cached. Revoking one stops it on its very next call.
- **Refusals are recorded**, not merely logged (S-909). A credential being
  tried and failing is the signal that someone is probing, and it is worth
  more than a success when it repeats. The reason is recorded as
  `no_credential`, `invalid_credential`, `out_of_scope`, `rate_limited` or
  `too_many_attempts`.
- **Every way of being wrong returns the same 401.** No credential, a wrong
  secret and a revoked one are indistinguishable to the caller, so a list of
  client ids cannot be sorted into real and invented.
- **The limit is per credential**, at its own ceiling, so one integration
  looping on a bug cannot exhaust another's allowance. An address that has
  not yet authenticated is limited separately and hard — nothing legitimate
  fails to authenticate repeatedly.
- **The scope is written per endpoint**, so a new endpoint added beside an
  existing one does not inherit its reach.

### Credentials

Issued at **Administration → API credentials** (`api_credential.manage`), as
`<client_id>.<secret>`:

```
Authorization: Bearer ab_kJ3f….9tQm…
```

The client id is the lookup half and is not secret. The secret is 32 random
bytes, stored only as a SHA-256 and **shown once**. There is no way to read it
back — a credential the system could show again is one a copy of the database
hands over, and re-issuing takes a moment. Tokens begin `ab_` so a leaked one
is recognisable to a secret scanner.

The middleware never resolves a staff cookie under `/api/v1/public/`, so a
signed-in officer's browser cannot reach these endpoints as themselves, and
`defineIntegrationEndpoint` never resolves a cookie or a member token.

## Rate limiting

A fixed-window counter kept **in the database**, not in process memory: the
application runs as serverless functions, so each instance has its own memory
and an in-process counter would let a caller multiply their allowance by the
number of warm instances. The increment is one statement, so concurrent requests
cannot both read the same count and both decide they are under the limit.

| Variable                    | Default |                                        |
| --------------------------- | ------- | -------------------------------------- |
| `RATE_LIMIT_MAX_REQUESTS`   | 300     | Per subject per window                 |
| `RATE_LIMIT_WINDOW_SECONDS` | 60      | Window length                          |
| `RATE_LIMIT_DISABLED`       | —       | `true` switches it off, for local work |

The defaults are generous: this slows abuse, it does not shape normal use. An
officer working quickly through a list should never meet it. A caller may
name a tighter ceiling and window for one subject — the member app's public
endpoints do, per NIC, per number and per address (`docs/member-app.md`).

**It fails open.** If the counter is unavailable the request proceeds and the
failure is logged loudly. The limiter is not the access control — a request
reaching it has already been authenticated and authorised, both of which needed
the same database — so failing closed would take the API down to guard against
something already permitted. That is a deliberate trade, and the opposite choice
would be defensible if the API were ever exposed to the public internet
unauthenticated.

A fixed window lets a caller burst across a boundary. A sliding window would need
a row per request, which is write amplification this does not warrant.

## Logging

One structured line per request, as JSON so a search can filter by correlation
id or status without a regular expression:

```json
{
  "kind": "api",
  "correlationId": "…",
  "method": "GET",
  "path": "/api/v1/health",
  "status": 200,
  "durationMs": 12,
  "actor": "officer@albarakah.mu"
}
```

**The request body is never logged.** For this application it routinely holds
member personal and financial data, and a log is a much easier thing to read
than a database.
