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

## Defining an endpoint

There is one way, and it is not optional:

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
officer working quickly through a list should never meet it.

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
