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
| **Identification / linking** | NIC + AB Number name exactly one member who may use the app                                                           | `POST /auth/link-member`                      |
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
names nobody — wrong NIC, wrong AB Number, right pair but not entitled —
gets the same response as one that does: a challenge id, purpose
`link_member`, `sentTo: null`, five minutes. Behind it is a
`link_member_miss` challenge row with a random hash nothing can match and
no SMS; verifying against it fails and burns exactly as a wrong code does.
The difference is recorded in the audit trail (`member.link.refused`, with
the AB Number as typed and a prefix of the NIC's hash), never in the
response. The app tells the person a code has been sent _if_ the details
matched, and what to do if nothing arrives.

It is also written to the server log, as
`{"kind":"member-link-refused","correlationId":…,"abNumber":…,"reason":…}`
where `reason` is `no_match` or `no_mobile_on_record`. A server log is not
the caller, so this costs nothing the response protects — and without it a
refusal is invisible to whoever is setting an environment up: the request
logs 200 like any other, no `member-otp` line appears because nothing was
sent, and the only symptom is an OTP that will not verify five minutes
later. Reading the audit trail instead needs database access, which the
person holding the deployment log often does not have.

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

| Step | Endpoint                                        | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `POST /auth/link-member` `{ nic, abNumber }`    | 422 if either is malformed (`details.nic`, `details.abNumber`). **404 if the pair does not name one member who may use the app** (active, or resigned with an account still open; `mayUseAppSql`) — one message for "no such NIC", "no such AB Number", "not together" and "not entitled", telling the person to contact the Al Barakah office on +230 5944 9797; a member with no mobile on record gets the same instruction worded for that. The app goes no further on a 404 (officer direction, October 2026; the earlier decoy challenge that answered a miss as a hit is gone, so the rate limits — which count a miss — are the control against guessing pairs). On a hit, returns the challenge with no number. Audit: `member.link.requested` on the member, `member.link.refused` on a miss. |
| 2    | `POST /auth/verify-otp` `{ challengeId, code }` | Five wrong codes burn the challenge (404 from then on); a code lives five minutes and works once. On success a `member_session` with `member_id` set. Audit: `member.link.completed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3    | `POST /auth/refresh` `{ refreshToken }`         | New pair; the old refresh token is dead the moment it is used. Ninety days from last use, so a phone that opens the app now and then never re-links. A member no longer entitled to the app is signed out here rather than when a token happens to lapse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4    | `POST /auth/logout`                             | Revokes the session. The device must link again to get back in. Audit: `member.session.revoked`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| —    | `POST /auth/resend-otp` `{ challengeId }`       | Fresh code, same purpose, same number; the previous code is dead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

The phone's push token (`member_device`, migration 0118) travels the other
way — from the phone to the server, on every start — and is tied to the
session that sent it: revoking the session silences the phone. It can
only receive; it identifies an app install, never the person.

## The system user

Applications from the phone are captured by `Member app`
(`app_user.entra_subject = 'system:member-app'`, migration 0039). It has no
role and no permission, so it cannot reach a page; its `entra_subject` is
a value no token can carry, so `claimPreProvisionedAccount` can never bind
a real sign-in to it. Every audit row it writes carries the masked mobile
that acted: `member-app:+2305xxx234`.

It is read, and seeded again if missing, on every action from the phone
(`systemUser()`, `src/lib/member/applications.ts`): "Reset test data"
used to delete it with the staff (fixed in migration 0119, which keeps
every `system:%` account), and until then every application started from
the app failed with "Something went wrong" on a freshly reset test
environment.

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

All under `/api/v1/member`; the generated document has the schemas. In
the in-app explorer (`/admin/api`) the account reads and the transaction
writes are grouped under Accounts and Transactions beside the staff
endpoints they mirror (S-2103); the rest is under Member app.
Where a rule says 422, `details` carries one entry per problem, keyed
`subject.ordinal.fieldKey` for a party field and `document.<code>` for a
missing document — the app folds those onto the fields by that key.

**Every write must send `Content-Type: application/json`, whether or not it
has a body.** Astro's `security.checkOrigin` is on by default: for any
method outside GET/HEAD/OPTIONS, a request declaring no content-type at all
is refused with `403 Cross-site POST form submissions are forbidden` unless
its `Origin` header matches the site, while one that declares a type is
refused only if that type is form-like (`x-www-form-urlencoded`,
`multipart/form-data`, `text/plain`). A native client has no browsing
context and sends no `Origin`, so the content-type decides it alone. The
two calls that carry nothing of their own — submitting an application and
deleting a draft, both of which take everything from the path — are the
ones this catches, and it catches them before any handler runs, so the
answer is a bare 403 with no envelope and no correlation id. Sending the
header is the whole of what is needed; a body is not.

| Method | Path                                                             | Caller | What                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reference`                                                     | public | Active membership types with their fields, applicant-facing checklist (`signed_form` left out — a branch step), fees in force, and the Society's bank accounts by name (S-2102).                                                                                                                                                                                                                         |
| GET    | `/me`                                                            | member | Membership, the founding application's parties, and any pending details request.                                                                                                                                                                                                                                                                                                                         |
| PUT    | `/me/details`                                                    | member | A `member_details_request`. 422 on a blank mandatory field or an unplaceable phone; 409 while one is pending; 403 for an applicant. Audit: `member.details.requested`.                                                                                                                                                                                                                                   |
| GET    | `/me/accounts`                                                   | member | Balance from the ledger's cache (S-1309), or null for an account nothing has ever posted to. `transactionCount` is the number of entries recorded; the app hides an account with none.                                                                                                                                                                                                                   |
| GET    | `/me/accounts/{id}/transactions`                                 | member | The ledger's entries, oldest first (`accountEntries`); 404 unless the caller's.                                                                                                                                                                                                                                                                                                                          |
| GET    | `/me/accounts/{id}/balance`                                      | member | The staff `/accounts/{id}/balance` payload — balance, pending debits, available — for the caller's own account; 404 unless the caller's (S-2101).                                                                                                                                                                                                                                                        |
| GET    | `/me/accounts/{id}/history`                                      | member | The staff `/accounts/{id}/history` payload, newest first, paged by `before`; 404 unless the caller's.                                                                                                                                                                                                                                                                                                    |
| GET    | `/me/accounts/{id}/statement`                                    | member | The staff `/accounts/{id}/statement` payload for a period (`from`, `to`; the month to date by default), or the spreadsheet with `format=xlsx`; 404 unless the caller's.                                                                                                                                                                                                                                  |
| POST   | `/me/deposits`                                                   | member | A deposit into the caller's own account, captured by the system user in the Member role and routed by the matrix; never cash; 403 until deposits from the app are switched on (S-2102).                                                                                                                                                                                                                  |
| POST   | `/me/withdrawals`                                                | member | A withdrawal from the caller's own account, the same way; 403 until switched on.                                                                                                                                                                                                                                                                                                                         |
| POST   | `/me/transfers`                                                  | member | A transfer from the caller's own account to an account here, the same way; 403 until switched on.                                                                                                                                                                                                                                                                                                        |
| GET    | `/me/transactions`                                               | member | The requests the caller made from the app and where each stands: Pending approval with who has it, approved, completed, or not approved with the officer's reason (migration 0120).                                                                                                                                                                                                                      |
| GET    | `/me/documents`                                                  | member | `documentsForMember`; each entry's `id` opens at the row below.                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/me/dependents`                                                 | member | The active minors the caller is guardian of (member or non-member account holder), each with their accounts and balances. Matched on the guardian block by the caller's Member No. or NIC (`members/guardian.ts`); empty for a member who guards nobody. Read-only.                                                                                                                                      |
| GET    | `/me/dependents/{dependentId}/accounts/{accountId}/transactions` | member | The entries behind a guarded minor's balance, oldest first; 404 unless the caller guards the minor and the account is that minor's.                                                                                                                                                                                                                                                                      |
| GET    | `/promotions`                                                    | member | The cards on the app's home screen: the active `app_promotion` rows inside their dates, in sort order (migration 0111). Written on **Configuration → Member app**. The phone shows each card's picture alone (so a picture is required); the title and text are the administrator's label and the screen reader's description. The same for every session, applicant included; nothing about the caller. |
| GET    | `/outlets`                                                       | member | Where the membership card earns a discount: the active `card_outlet` rows in sort order (migration 0116) — logo, category tag, percentage, description, address, link, and `isPartner` (pays the premium fee: shown on the home screen as well, migration 0117). Written on **Configuration → Member app**. The same for every session; nothing about the caller.                                        |
| POST   | `/me/devices`                                                    | member | This phone's Firebase push token, tied to the caller's session (migration 0118; `docs/notifications.md`, Push). The app registers on every start; the same token again refreshes the row, a token that moves to another session moves with it. 422 without a token or a platform.                                                                                                                        |
| DELETE | `/me/devices`                                                    | member | Withdraws the token for the caller's own session — the app calls it before signing out. Revoking a session disables every token of it regardless.                                                                                                                                                                                                                                                        |
| GET    | `/me/documents/{id}/content`                                     | member | The file itself, streamed from this origin for the app to render in place; 404 unless the document is the caller's own — one listed above (`ownedDocumentId`).                                                                                                                                                                                                                                           |
| GET    | `/applications`                                                  | member | Those started from the caller's verified mobile, plus a member's founding one.                                                                                                                                                                                                                                                                                                                           |
| POST   | `/applications`                                                  | member | `startApplication` as the system user; 409 while one is in progress.                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/applications/{id}`                                             | member | 404 unless the caller's.                                                                                                                                                                                                                                                                                                                                                                                 |
| DELETE | `/applications/{id}`                                             | member | `deleteDraftApplication`; draft only.                                                                                                                                                                                                                                                                                                                                                                    |
| PUT    | `/applications/{id}/parties`                                     | member | `saveDraft` — never fails on content; only fields the type configures are kept. 409 once submitted.                                                                                                                                                                                                                                                                                                      |
| POST   | `/applications/{id}/documents/begin-upload`                      | member | `beginUpload` through the same broker as staff (`docs/documents.md`); `checklistItemId` is `<documentTypeId>:<subject>`.                                                                                                                                                                                                                                                                                 |
| POST   | `/applications/{id}/documents/commit-upload`                     | member | `commitUpload`; only a version begun on this application.                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/applications/{id}/submit`                                      | member | `problemsBlockingSubmission` plus every required document not filed, all in one 422; on success `received`. Audit: `membership.application.received`.                                                                                                                                                                                                                                                    |

The three account reads that arrived with S-2101 are the staff endpoints'
own payloads: the schema and the mapping live once, in
`src/lib/ledger/api-payloads.ts`, and the staff endpoint under
`/api/v1/accounts/{id}` and the member's under `/me/accounts/{id}` both
call it. A member in the app and an officer at the branch are reading one
ledger, and the member endpoint adds exactly one thing — `ownedAccountId`
in `src/lib/member/profile.ts`, which answers not found for any account
that is not the caller's own, another member's and a non-existent one
alike.

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

**Staff act on it at Members → Details updates**
(`/members/details-updates`, `member.details_verify`, migration 0042).
The queue shows one card per waiting member: what the record holds, what
they say it should be, field by field, and nothing else — a member who
corrects one field sends the whole form back, and the reviewer should see
the one field, not forty. Apply writes it; Decline needs a reason,
because the member is shown it (`lastUpdate.comment` on `/me`).

Three things about applying are worth knowing because they are not
obvious from the endpoints:

- **A change is measured against what the member was shown**, not against
  the record as it stands. `previous_parties` on the request is
  `application_party` as it was at the moment they submitted. Diffing
  against the record instead would read every untouched field the app sent
  back as a change, and applying would write the member's stale copy over
  anything an officer corrected at the branch while the request waited.
- **Only the changed fields are written**, merged into the party with
  `values || patch`. A request never replaces a party wholesale.
- **A member with no founding application cannot send one at all.** A
  member's details live on their application's parties, so a legacy record
  imported without one (M7) has nowhere for this to land; `PUT /me/details`
  refuses with 409 rather than queueing something nobody can apply.

The request is history once made: the application role has no `delete` on
`member_details_request`, and applying records both halves — the parties
as they were, and the field-by-field change — in the audit trail
(`member.details.applied`, `member.details.declined`).

**The member is told.** Applying or declining raises
`member.details.applied` (the fields that changed, by label) or
`member.details.declined` (the officer's reason) after the decision
commits — email and WhatsApp wording each, migration 0087, on the address
the founding application recorded (`src/lib/members/tell-member.ts`, the
same path dormancy uses). The app still shows the outcome under
`lastUpdate` for a member with no address on file.

## Transactions from the app

A deposit, a withdrawal or a transfer a member starts from the phone
(S-2102, `src/lib/member/transactions.ts`) is the transaction an officer
would record at the branch — the same service function, the same account
rules, the same approval matrix — with two differences.

**Who captures it.** The member-app system user, acting in the Member role
(migration 0085; assigned to nobody, holding no permission) with
`transaction.capture` and nothing more. The matrix reads that role, so a
rule "by Member" at Configuration → Approval matrix, moved above the band
it would otherwise fall into, routes a member's own transaction to the
chain of the Society's choosing. Because the app never holds
`transaction.post`, a route that would post at once is refused with 403
and "please visit the branch": a member's transaction goes to a chain or it
goes nowhere, and the officers on that chain decide. It can never be more
lenient than a clerk's.

**Where it goes** (officer direction, October 2026; migration 0120). Every
request from the app is validated by officers before money moves, and the
member sees **Pending approval** until then. Three rules "by Member" sit
at the top of the matrix, any amount:

| From the app | Chain                                                  | Then                                                               |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Deposit      | Deposit from the member app: **Accounts verification** | Another Account Officer records it (`transaction.post`; four eyes) |
| Withdrawal   | Withdrawal approval: **Secretary → President**         | The **Treasurer** disburses it (`transaction.disburse`)            |
| Transfer     | Transfer approval: **Secretary → President**           | It is recorded (`transaction.post`)                                |

Accounts verification is a one-step chain for the Account Officer, which
is therefore also given `transaction.approve`; acting on a step still needs
that step's role, so it reaches no other chain's decision. A request from
the app is **never returned** — its captor is the system user, so nobody
could correct it and it would sit in no queue holding the member's money
as pending: `reviewTransaction` refuses a return and the staff page hides
the button, so a reviewer rejects it with the reason, which the member is
told (push wording for `deposit.rejected`, `transfer.rejected` and
`withdrawal.rejected`). All of it is configuration, at Configuration →
Approval matrix and → Workflows.

**What the member sees.** `GET /me/transactions` lists what the caller
asked for from the app, newest first: `state` pending, approved,
completed, declined, returned or cancelled, `statusLabel` in the member's
words ("Pending approval", "Approved", "Paid out", "Not approved"),
`stage` naming who has it ("Being verified by the accounts department",
"With the Secretary", "Awaiting disbursement by the Treasurer") and, when
declined, the officer's `reason`. `/reference` says which operations are
switched on (`enabledOperations`) and how a deposit may have been paid
(`depositMethods`, never cash).

**Whether it may be started at all.** `member_api.enabled_operations`, set
at Configuration → Member app (`config.manage`), lists which of the three
are on. Empty is the default: the endpoints exist from day one and answer
403 until switched on, and Readiness shows the setting. A cash deposit is
refused whatever the switch says — nobody took cash from a phone — so a
deposit names a bank or mobile money method, its reference and the
Society's bank account from `/reference`. A transfer goes to an account on
the system by id, never to a payee outside: that is a withdrawal in another
name, and the branch's to record. Every write demands an `Idempotency-Key`
header, as the staff API does.

## Configuration

| Variable                      | Purpose                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMBER_SESSION_SECRET`       | Signs access tokens. Its own key, never `AUTH_SESSION_SECRET`: a staff cookie and a member token must not be interchangeable. At least 32 characters.                                                                                                                                                                                                             |
| `MEMBER_OTP_DELIVERY`         | `http` posts `{ to, message }` to `MEMBER_OTP_WEBHOOK_URL` (with `MEMBER_OTP_WEBHOOK_TOKEN` as a bearer, if set) — whatever SMS or WhatsApp gateway the Society uses. `log` writes the code to the server log; **non-production only**, refused elsewhere. Unset: codes cannot be sent and the endpoints say so (503).                                            |
| `MEMBER_OTP_FIXED_CODE`       | Six digits every challenge accepts, for exercising the app against the test environment. **Non-production only.**                                                                                                                                                                                                                                                 |
| `MEMBER_ACCESS_TOKEN_SECONDS` | Default 3600.                                                                                                                                                                                                                                                                                                                                                     |
| `MEMBER_REFRESH_TOKEN_DAYS`   | Default 90, from last use.                                                                                                                                                                                                                                                                                                                                        |
| `NOTIFY_PUSH_DELIVERY`        | How push notifications reach the app's phones: `fcm` through Firebase Cloud Messaging with `NOTIFY_PUSH_SERVICE_ACCOUNT` (the project's service-account key file, as JSON or base64), `http` to a gateway, `log` on a non-production environment. `docs/notifications.md`, "Push". Unset: push rows fail with the reason, as any other unconfigured channel's do. |

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
