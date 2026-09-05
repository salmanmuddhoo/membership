# The member app's surface — `/api/v1/member`

What the member mobile application (`salmanmuddhoo/membership-MobileAPP`)
calls. The staff API (`docs/api.md`) is reached with the staff cookie and
every endpoint carries a staff permission; a member has neither. This is
the second surface on the same framework — the same envelope, the same
rate limiter, the same audit trail — scoped to one thing: **a member reads
and writes their own record, and nothing else.**

The document is generated with the rest (`pnpm openapi:generate`); the
operations tagged **Member app** in `docs/openapi.json` are this surface.
`x-required-permission` on each says whether it is public or needs a
member session.

## Identity

Four different things, kept apart because conflating them is how a phone
app ends up letting a card number open an account:

| Concern                      | What it is                                                                                                            | Where                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Identification / linking** | NIC + AB Number name exactly one active member                                                                        | `POST /auth/link-member`                      |
| **Verification**             | A one-time code proves the person holds the mobile on that member's record                                            | `POST /auth/verify-otp`                       |
| **Authentication**           | The session that results — access token + refresh token in the device keychain — is what every later request presents | `Authorization: Bearer`; `POST /auth/refresh` |
| **The link**                 | `member_session.member_id`, from that session to the `member` row                                                     | Server-side only; never sent to the phone     |

**NIC + AB Number alone open nothing.** They select whose registered
mobile the code goes to. The person typing them does not choose that
number, is never shown it (not even masked), and cannot change it from
the app — a member whose number has changed goes to a branch with their
ID. A lost card, a NIC read off a form, or both together get an attacker
exactly as far as the SMS they will not receive.

**The answer never says whether the pair exists.** A NIC + AB Number that
names nobody — wrong NIC, wrong AB Number, right pair but not active —
gets the same response as one that does: a challenge id, purpose
`link_member`, `sentTo: null`, five minutes. Behind it is a
`link_member_miss` challenge row with a random hash nothing can match and
no SMS; verifying against it fails and burns exactly as a wrong code does.
The difference is recorded in the audit trail (`member.link.refused`, with
the AB Number as typed and a prefix of the NIC's hash), never in the
response. The app tells the person a code has been sent _if_ the details
matched, and what to do if nothing arrives.

**AB Number** is `member.member_no` — `AB` and four digits, allocated by
`next_member_number()` — which the business also calls the Shares Account
Number. Matching is on `member.member_no`, whole, case-insensitive.

**NIC** is not a column on `member`. It lives on the applicant party of the
application that created the member, and `link-member` joins to it exactly
as `searchExistingMembers` does — but matched whole, never as a fragment,
and returning no name. A legacy record imported without an application
(M7's `member.application_id` is nullable for that) cannot link until the
import gives it one; that is the import's job, not this endpoint's.

### Linking an existing member

| Step | Endpoint                                        | Rules                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /auth/link-member` `{ nic, abNumber }`    | 422 if either is malformed (`details.nic`, `details.abNumber`). **404 if the pair does not name one active member** — one message for "no such NIC", "no such AB Number", "not together" and "not active". Returns the challenge with the registered mobile masked. Audit: `member.link.requested` on the member, `member.link.refused` on a miss. |
| 2    | `POST /auth/verify-otp` `{ challengeId, code }` | Five wrong codes burn the challenge (404 from then on); a code lives five minutes and works once. On success a `member_session` with `member_id` set. Audit: `member.link.completed`.                                                                                                                                                              |
| 3    | `POST /auth/refresh` `{ refreshToken }`         | New pair; the old refresh token is dead the moment it is used. Ninety days from last use, so a phone that opens the app now and then never re-links. A member no longer active is signed out here rather than when a token happens to lapse.                                                                                                       |
| 4    | `POST /auth/logout`                             | Revokes the session. The device must link again to get back in. Audit: `member.session.revoked`.                                                                                                                                                                                                                                                   |
| —    | `POST /auth/resend-otp` `{ challengeId }`       | Fresh code, same purpose, same number; the previous code is dead.                                                                                                                                                                                                                                                                                  |

This is **not** the staff `GET /api/v1/applications/existing-member-search`.
That matches a fragment of a name, NIC or Member No. against every active
member and returns names — right for an officer with `application.capture`,
and exactly what a public endpoint must never do. `link-member` is exact
pair only, no search, no names in the response, and the staff endpoint
stays behind its staff permission where a member token cannot reach it
(the middleware never resolves a cookie on `/api/v1/member/`, and
`defineEndpoint` never resolves a bearer token).

### A new applicant

Someone applying has no AB Number, and must not need one.

| Step | Endpoint                          | Rules                                                                                                                                                                                                                                                                                                        |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `POST /auth/sign-up` `{ mobile }` | Any form `toInternational` accepts. **Always succeeds for a well-formed number**, on some record or not — the response must not reveal who is a member.                                                                                                                                                      |
| 2    | `POST /auth/verify-otp`           | A `member_session` with `member_id` **null** and `identity.kind: 'applicant'`. It can start, save and submit an application and read its own; nothing else. **It never resolves to a member record, even when the verified mobile is the one on a member's file**: member access comes only through linking. |

The verified mobile becomes the applicant's `mobile` on the application,
pre-filled and kept whatever the phone sends. The NIC is captured on the
form like every other field, and checked by the officer against the ID
card they file.

### What the phone holds

`accessToken` — a JWT (HS256, `MEMBER_SESSION_SECRET`, audience
`member-app`, subject the session id, one hour). Verified locally, then
the session row is read, so a revoked session is refused on its very next
request. `refreshToken` — 32 random bytes, stored as a SHA-256, rotated on
every use. Neither the NIC nor the AB Number is stored on the device; the
internal member id is never sent to it.

## The system user

Applications from the phone are captured by `Member app`
(`app_user.entra_subject = 'system:member-app'`, migration 0039). It has no
role and no permission, so it cannot reach a page; its `entra_subject` is
a value no token can carry, so `claimPreProvisionedAccount` can never bind
a real sign-in to it. Every audit row it writes carries the masked mobile
that acted: `member-app:+2305xxx234`.

## Received online

The officer's own submit (draft → new, the `capture` step) requires the
signed form filed and the payment recorded — neither of which a phone can
produce. So an application submitted from the app lands on **`received`**
(migration 0039, a `workflow_status` row like any other), with the branch
and not yet in the chain.

From there an officer works it exactly as a returned one: `received` is
in `capture.ts`'s editable set (`isEditableStatus`), the document guards
accept it, the capture pages show Submit on it, and `assertMayAct` lets
the `capture` step act on it. The officer checks the documents, prints
the form for signing, takes the payment and submits — draft → new, as
ever. `pendingApplicationIds` flags every `received` application for
everyone who may submit, since it is nobody's draft.

The applicant's own view (`GET /applications/{id}`) shows a timeline built
from `application_transition` with member-safe labels — "Submitted",
"Received by the branch", "Under review", "Returned for correction",
"Approved" — never an officer's name, and a review comment only where it
was written for the applicant (a return or a rejection).

## Endpoints

All under `/api/v1/member`; the generated document has the schemas.
Where a rule says 422, `details` carries one entry per problem, keyed
`subject.ordinal.fieldKey` for a party field and `document.<code>` for a
missing document — the app folds those onto the fields by that key.

| Method | Path                                         | Caller | What                                                                                                                                                                   |
| ------ | -------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reference`                                 | public | Active membership types with their fields, applicant-facing checklist (`signed_form` left out — a branch step) and fees in force.                                      |
| GET    | `/me`                                        | member | Membership, the founding application's parties, and any pending details request.                                                                                       |
| PUT    | `/me/details`                                | member | A `member_details_request`. 422 on a blank mandatory field or an unplaceable phone; 409 while one is pending; 403 for an applicant. Audit: `member.details.requested`. |
| GET    | `/me/accounts`                               | member | Balance is the opening payment less any refund, or null with nothing recorded — there is no ledger yet.                                                                |
| GET    | `/me/accounts/{id}/transactions`             | member | `transactionsForAccount`; 404 unless the caller's.                                                                                                                     |
| GET    | `/me/documents`                              | member | `documentsForMember`. No download URL.                                                                                                                                 |
| GET    | `/applications`                              | member | Those started from the caller's verified mobile, plus a member's founding one.                                                                                         |
| POST   | `/applications`                              | member | `startApplication` as the system user; 409 while one is in progress.                                                                                                   |
| GET    | `/applications/{id}`                         | member | 404 unless the caller's.                                                                                                                                               |
| DELETE | `/applications/{id}`                         | member | `deleteDraftApplication`; draft only.                                                                                                                                  |
| PUT    | `/applications/{id}/parties`                 | member | `saveDraft` — never fails on content; only fields the type configures are kept. 409 once submitted.                                                                    |
| POST   | `/applications/{id}/documents/begin-upload`  | member | `beginUpload` through the same broker as staff (`docs/documents.md`); `checklistItemId` is `<documentTypeId>:<subject>`.                                               |
| POST   | `/applications/{id}/documents/commit-upload` | member | `commitUpload`; only a version begun on this application.                                                                                                              |
| POST   | `/applications/{id}/submit`                  | member | `problemsBlockingSubmission` plus every required document not filed, all in one 422; on success `received`. Audit: `membership.application.received`.                  |

### What a member never gets

Officer names, other members, `view-url`, guardian or existing-member
search (the Minor form takes the guardian's Member No. typed; the server
validates it at submit as S-605 already does), payments, receipts,
configuration beyond `/reference`.

## A member's own capture of their details

What KYC verified must not change from a phone with nobody checking; a
member who moved house must still be able to say so. `PUT /me/details`
records a `member_details_request` — the values as the officer's form
would have them, phones normalised, every mandatory field present, the
sign-in mobile kept — and the member sees "pending" until staff act.

**Not built yet:** the staff side. Applying a request means writing to
`application_party` on an approved application, which nothing does today,
and the Members page has no queue for it. Until it exists a request is
visible in the audit trail (`member.details.requested`) and the table, and
`/me` reports it pending. It is the next piece of work on this surface.

## Configuration

| Variable                      | Purpose                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMBER_SESSION_SECRET`       | Signs access tokens. Its own key, never `AUTH_SESSION_SECRET`: a staff cookie and a member token must not be interchangeable. At least 32 characters.                                                                                                                                                                  |
| `MEMBER_OTP_DELIVERY`         | `http` posts `{ to, message }` to `MEMBER_OTP_WEBHOOK_URL` (with `MEMBER_OTP_WEBHOOK_TOKEN` as a bearer, if set) — whatever SMS or WhatsApp gateway the Society uses. `log` writes the code to the server log; **non-production only**, refused elsewhere. Unset: codes cannot be sent and the endpoints say so (503). |
| `MEMBER_OTP_FIXED_CODE`       | Six digits every challenge accepts, for exercising the app against the test environment. **Non-production only.**                                                                                                                                                                                                      |
| `MEMBER_ACCESS_TOKEN_SECONDS` | Default 3600.                                                                                                                                                                                                                                                                                                          |
| `MEMBER_REFRESH_TOKEN_DAYS`   | Default 90, from last use.                                                                                                                                                                                                                                                                                             |

## Codes: the controls, in one place

| Control             | Value                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Length and source   | Six digits from the CSPRNG (`randomInt`); `MEMBER_OTP_FIXED_CODE` only where non-production is asserted                                                                                                                         |
| Storage             | SHA-256 salted on the challenge's own id; compared in constant time; the code appears nowhere else, the audit trail included                                                                                                    |
| Expiry              | 5 minutes; one use (`consumed_at`)                                                                                                                                                                                              |
| Attempts            | 5 per challenge, counted in one statement under the row lock, then burnt                                                                                                                                                        |
| Resend cooldown     | 30 s per key (AB Number for a link, number for a sign-up), read from the challenge rows so it holds even with the limiter off                                                                                                   |
| Rate limits         | `link-member`: 5/NIC/h, 5/AB Number/h, 20/address/h, counted hit or miss. `sign-up`, `resend-otp`: 3/number/10 min, 20/address/h. Every public endpoint: 30/address/min on top. Member endpoints: the staff default per session |
| Delivery failure    | A code that could not be sent takes its challenge with it: nothing that never arrived can be guessed at                                                                                                                         |
| Information leakage | A miss is answered, stored and verified exactly as a hit; the registered mobile is never shown for a link                                                                                                                       |
| Audit               | `member.link.requested` / `refused` / `completed`, `member.signup.requested` / `verified`, `member.otp.resent` / `rejected` / `burnt`, `member.session.revoked` — with the correlation id and address, never the code           |

All limits go through `checkRateLimit` (`docs/api.md`), which takes a
ceiling and window per call for exactly this; the cooldown does not, on
purpose.
