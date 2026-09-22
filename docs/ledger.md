# The ledger

How an account has a balance. Everything here is in `src/lib/ledger/`; the
schema is `migrations/0064_ledger.sql`. Phase 1 recorded what an applicant paid
(`docs/payments.md`) and never a balance; Phase 2 moves money, and this is
where it is counted.

## The one design decision worth reading

**A balance is the sum of an account's entries. The number in
`account_balance` is a cache of that sum, and nothing trusts it over the
entries.**

The alternative — a `balance` column that each transaction adds to or takes
from — is one bug away from a figure nobody can explain, because nothing
records how it got there. So every posted transaction writes one immutable
`account_entry` per account it touched, the balance is derived from those, and
the cache exists only because summing a years-deep account on every page load
would not do.

The cache is maintained inside `post_transaction()`, in the same database
transaction as the entries it summarises, so the two cannot disagree by a
crash between them. If they ever disagree by anything else, `ledger_drift()`
says which accounts, and `rebuild_account_balance()` resolves it — from the
entries, never the other way round. The `ledger-verify` job asks nightly
(`docs/jobs.md`).

## The one road in

`post_transaction(transaction_id, actor_user_id, actor_description)` is the
only thing that writes `account_entry` or `account_balance`. It is `security
definer`, owned by the schema owner, and the application role holds **no**
insert, update or delete on either table — the same shape `reset_all_test_data`
and the retention job have. `scripts/schema.test.ts` asserts the grants, so a
second code path that writes a balance fails the build rather than a review.

What the function does, atomically: the entries, the cache, the transaction's
status, one `transaction.posted` row on `financial_event`, and one audit row
naming who posted. "Half posted" is therefore not a state that can exist.

What it does **not** decide is whether a transaction may post at all. The
account type's floor and limits, the approval chain, the cash controls — those
are the service layer's, evaluated before it calls. The function checks only
what must hold whoever calls it: the transaction is submitted or approved, the
account is active, and the kind is one it knows.

## Where the first balance comes from

Phase 1 recorded what an applicant paid and never a balance, so the ledger
started empty against members who had paid. Migration 0066 carried every
receipt over, and the same function it used is what the live paths call from
then on (S-1303):

- `post_opening_balances(application_id, actor, description)` reads every
  unvoided payment against the application. A `shares` fee line becomes a
  deposit on the Shares account the application opened, an `msa_deposit` line
  on the MSA, and a `payment_account_line` (an HSA or Investment opening
  deposit, or an imported balance of that type) on the account of its type.
  Entrance, processing and Takaful are income and open nothing. Every unvoided
  refund line becomes a **reversal** of the deposit its original's line
  became.
- Each line is carried at most once — `transaction.payment_line_id` and
  `payment_account_line_id` are unique — so the call is free to repeat, and
  it is called wherever an account might newly have something to carry:
  opening accounts on approval (`members/create.ts`, all four paths),
  recording a migrated legacy balance and recording a refund
  (`payments.ts`). Whichever runs first with an account to land on does the
  work; the rest post nothing.
- A carried transaction references the **receipt it came from** rather than
  taking a new one, names who took the money as `captured_by`, and is dated
  when it was taken (`created_at`). Who ran the carry is `posted_by`: the
  approving officer on the live path, the `system:migration` service account
  for the backfill (`migration@system.albarakah.mu`, `docs/runbook.md`).
- It **posts whatever the account's status**. A pending HSA or a dormant
  member's Shares still hold the money that was paid in; the status says what
  the holder may do next, not whether history may be written. A new deposit
  still needs an active account, and a closure (S-1702) is the one
  transaction that posts on a `closing` one — it is what the account is
  closing for.
- A migrated legacy balance (M7, S-709) is written as a payment with lines,
  so it is carried exactly the same way. There is one source, which is what
  makes "never both" trivially true.

The control total: the sum of every Shares balance equals the sum of every
issued, unrefunded `shares` line, and the same for the MSA.
`pnpm figures:capture` records both (`scripts/control-figures.ts`), and the
backfill test asserts it. A void of a receipt whose lines are already on a
balance is refused — the money is on an account, so "this was never taken"
would be untrue — and the correction is a refund, which reverses through the
engine on its own receipt.

## Recording a deposit

`recordDeposit()` in `src/lib/ledger/deposits.ts` is the first capture path
on the engine, and the shape every later kind follows (S-1305). In order:

1. **The key.** Given an idempotency key the officer already used, the
   original deposit is returned if the request is the same (a fingerprint of
   account, amount in cents, method, reference and note, stored beside the
   key) and refused as a conflict if it differs. Nothing is re-decided
   (S-1308). The form issues a key when it renders, so a refresh after a
   success cannot post twice; `POST /api/v1/deposits` demands one in the
   `Idempotency-Key` header, by declaration (`docs/api.md`).
2. **The method**, exactly as a payment: offered today, its reference
   present where it requires one (S-1307).
3. **The cash controls**, exactly as a payment: the same function
   (`applyCashPaymentRules`) reading the same three configuration entries —
   the ceiling refuses, the threshold demands the Source of Fund form's
   confirmation (S-1306). What is not yet there for a deposit is the filed
   checklist document with its Missing → Verified lifecycle; the deposit
   records the officer's confirmation (`source_of_fund_form_confirmed`, the
   column a payment has carried since 0034).
4. **The destination**: the holder active, the account active, the type's
   `allows_deposit`, the type's `maximum_transaction_amount` (S-1304). Each
   refusal names its rule, before anything is written.
5. **The write**: a receipt number allocated on its own (so a number that
   never became a receipt shows in the sequence, S-502), then in one
   database transaction the `transaction` row, `post_transaction()`, and
   the receipt marked issued. A failure inside abandons the number with the
   reason.

A deposit below the escalation threshold has no chain (FRD 6.2), so it posts
on submit; M14 puts the threshold in front of this call. `transaction.capture`
is the permission, held by whoever holds `payment.record`.

Two ways in, one form. **Deposit** on the person's page (in the banner, with
the other kinds as they arrive) opens `/members/{id}/deposit` with their
accounts to choose from. **Transactions** in the sidebar shows every kind as
a card — Deposit live, the rest arriving with their milestones — and Deposit
there asks for the account type and its number (the member's own for Shares
and the MSA, the account's own for an HSA or Investment;
`findAccountByNumber`, `src/lib/ledger/lookup.ts`), then opens the same form
with that account chosen.

**Cash above the Source of Fund threshold is a request, not one act**
(S-1306, `src/lib/ledger/deposit-requests.ts`, M23). The Society wants the
Source of Fund form signed, filed and checked by somebody else before that
money is on an account, and a tick on the capture screen is not that. So
the deposit page, for cash above `payment.cash_source_of_fund_threshold`,
continues into a request instead: `startDepositRequest` writes the
transaction as a `draft` (the account, the amount, the method, checked as
any deposit is, the cash ceiling included) and posts nothing;
`/deposits/{id}` is the wizard and `/deposits/{id}/form` the sheet the
depositor signs on screen, rasterised and filed against the transaction
through the same wiring as a closure request (`documents.ts`, owner
'transaction'; the document type is 0062's `source_of_fund_form`, so a fee
payment and a deposit share one form). An officer holding
`document.verify` verifies or rejects it on the transaction page — never
the officer who recorded the request, the rule an application's papers
already follow — and only then does `submitDepositRequest` go: the form
verified, the same rules again, the matrix, the engine, the receipt when it
posts, `source_of_fund_form_confirmed` set on the row. A draft can be
changed (amount, reason; below the threshold it is refused, because that is
a direct deposit) or cancelled by its captor.

The deposit page's button for such an amount is **Sign the Source of Fund
form** and opens the form directly. Once signed, the wizard's Signature
step shows the filed form with its state, **View** and **Delete**; deleting
it (`removeFiledDocument`, allowed while the request is a draft) puts the
Sign button back. Submit says what is missing — the form not yet signed,
waiting on another officer, or rejected — rather than one line for all
three. The request reaches the second officer through **Waiting on you**:
`formsToVerify()` (`review.ts`) lists draft deposits whose form waits
under review for anyone with `document.verify` other than the captor, and
`depositRequestsToFinish()` hands the captor back their own once the form
is verified (submit it) or rejected (sign again). Both count towards the
queue's number. The API's `POST
/api/v1/deposits` keeps its confirmation flag for an integrating surface;
the screen no longer offers one.

## Recording a withdrawal

`recordWithdrawal()` in `src/lib/ledger/withdrawals.ts` (S-1501) is the same
shape as a deposit, with the checks money leaving needs, in FRD 6.3's order
and naming the first failure: the account is active and its type allows
withdrawals (`allows_withdrawal`, S-1304); the holder is active — not
dormant, resigned or demised; the **available** balance covers it; the
balance after would not fall below the type's `minimum_balance` (hard, FRD
4.3 — a Shares account cannot be drawn below membership by mistake, and
resignation is the way out, decision 12); the amount is within the type's
maximum. Then the matrix (S-1401): below its band the withdrawal is paid out
and posted at once by the officer recording it, who needs `transaction.post`
and gives the reference the method requires; above it, capture alone submits
it to its chain, and paying it out is a separate act once approved.

**Available, not merely current** (S-1502): `availableBalance()` in
`ledger.ts` is the balance less every withdrawal on the account that is
submitted, under review or approved — what is already on its way out. A
query over `transaction`, not a ledger entry, so a rejection releases it by
doing nothing. The withdrawal form shows it beside the balance, and
`GET /api/v1/accounts/{id}/balance` returns it as `available` with
`pendingDebits`.

**Disbursement** (S-1503): `postApprovedTransaction()` in `review.ts` takes,
for a withdrawal, how it was actually paid — the method, and the reference
where the method requires one or touches the Society's bank — records it on
the transaction, then posts. The entry is dated the disbursement, not the
decision, and the receipt is issued then. The person who approved it may not
be the one who pays it out (0072's segregation rule), on top of the captor
not being either.

`post_transaction()` is the last line: a withdrawal posts as a debit and is
refused there if it would take the account below its type's floor, because
the balance may have moved between the decision and the disbursement (0072).

Two ways in, as for a deposit: **Withdrawal** in the person's banner opens
`/members/{id}/withdraw`; the **Transactions** card asks for the type and
number and opens the same form. `POST /api/v1/withdrawals` is the endpoint.

## Recording a transfer

`recordTransfer()` in `src/lib/ledger/transfers.ts` (S-1504, FRD 6.4) is two
legs under one id, never two transactions that happen to match: a `transfer`
row (`TR-000001`, the source's holder, the reason, a status that mirrors the
debit leg's) and `transaction` rows of kind `transfer_leg` — a debit leg on
the source, and a credit leg on the destination when it is an account on the
system. The debit leg meets every check a withdrawal does, with the type's
`allows_transfer` in place of `allows_withdrawal`, and the credit leg meets a
deposit's: the holder and the account active, the type's `allows_deposit`,
its maximum. Both take the same amount, the same note, and the method
`internal_transfer` (a system method, never offered on a form).

The debit leg is the transaction: the matrix routes it, the chain reviews
it, the queue lists it, the receipt is on it, and its captor corrects it. The
credit leg follows — never in a queue, never posted on its own.
`post_transaction()` posts a debit leg and then, in the same call, its credit
leg and the transfer's status, so both post or neither (0073). A rejection
of the debit leg ends the credit leg too.

For the matrix, a transfer between the same holder's accounts is its own
kind (`transfer`, seeded to post up to the threshold); one to another
person's account, or to a payee, is a withdrawal — funds are leaving the
source holder's control (FRD 6.4).

A destination with no account here — a non-member, "Other" — has no credit
leg (open point 5's default). The debit leg names the payee and how it is
to be paid; below the band it is paid out and posted at once, the method's
reference demanded now; above it, it is disbursed once approved through the
same step as a withdrawal (S-1503).

The available balance counts a transfer's debit leg in flight as money on
its way out. A statement line reads "Transfer to AB0001 · Shares" on the
source and "Transfer from …" on the destination, or "Transfer to <payee>".

**Transfer** in the person's banner opens `/members/{id}/transfer`: another of
their own accounts, another member's or customer's found by type and number,
or a payee. The Transactions card asks for the source by type and number
first. `POST /api/v1/transfers` takes one call and one idempotency key for
the pair.

## Where a balance is read

- **The member's page** shows each account's balance from the cache, with a
  link to its history; an account nothing has ever posted to shows a dash,
  because a zero would read as a fact (S-1309).
- **The history page** (`/accounts/{id}`) lists every posted entry, newest
  first, fifty at a time, each with the balance the account stood at once it
  had posted — computed from the entries in SQL, so it is exactly what the
  ledger says whatever the cache does. `accountEntries()` is the one reader;
  each line carries a description ("Opening deposit" for a carried Phase 1
  line, "Refund" for its reversal, "Deposit", "Reversal of TX-…"), the
  method, the receipt, the note and who captured it.
- **The API**: `GET /api/v1/accounts/{id}/balance` and
  `GET /api/v1/accounts/{id}/history` (paged by `before`), through
  `defineEndpoint` (S-1310). The older `/accounts/{id}/transactions` keeps
  its shape for the Members list's dialogue and now reads the same entries.
- **The member app** reads the cache for `/me/accounts` and the entries for
  `/me/accounts/{id}/transactions`, and since S-2101 the staff payloads
  themselves at `/me/accounts/{id}/balance`, `/history` and `/statement`
  — one schema and one mapping in `src/lib/ledger/api-payloads.ts`, used
  by both — for the caller's own accounts only (`docs/member-app.md`).
- **The Members list's Total funds** is the sum of the cache over every
  account the person holds, whichever application opened it.

Nothing derives a balance from payments any more: the stand-in that read
"opening payment less refund" is gone, because those two lines are now the
account's first entries (S-1303).

## The matrix decides where a transaction goes

Before a submitted transaction is posted, `resolveRoute()` reads the approval
matrix (`docs/configuration.md`, S-1401): by kind, amount band, account type
and the role submitting, the first matching rule names a chain or none.
`submitTransaction()` applies it — posting through the engine at once, or
leaving the transaction at the first enabled step of its chain
(`transaction.current_step_code`) for the review screens — and writes a
`transaction_transition` row naming the rule and the chain (S-1406), so two
withdrawals either side of a matrix edit show different trails and both are
right. A transaction routed to a chain takes no receipt yet: the receipt is
issued when it posts.

For a deposit this means: up to the threshold it is captured and posted in one
act and needs `transaction.post` as well as `transaction.capture`; above it,
capture alone submits it for review, so a Clerk records a large deposit and
the Secretary and President decide it.

A transaction the member app starts (S-2102, `docs/member-app.md`) reaches
the same `resolveRoute` with `roleCodes: ['member']` and a principal that
may capture but never post, so a rule "by Member" decides its chain and a
route with no chain is refused rather than posted.

**The officer sees the route before they record it.** The deposit,
withdrawal and transfer forms — reached from a member's page or from the
Transactions lookups, which land on the form with the account chosen — open
on the same chevron the transaction page will show, drawn ahead of time
(`RoutePreview.astro`, `previewTimeline` and `routePreviewGroups` in
`src/lib/workflow/timeline.ts`): Record as the current step, every step of
the chain to come, Posted at the end — or Record and Posted alone with "posted
at once, no review needed" above, where the matrix posts directly. The
amounts are `routeBands()` in `routing.ts`: every boundary the kind's rules
draw for that account type and that officer, each band read off
`resolveRoute` itself, so the picture can never say something the submit
would not do. One block per account and band is rendered; a script shows the
one for the account and amount typed, so a larger amount reveals its review
before Record is pressed.

## Acting on what waits

`src/lib/ledger/review.ts` (S-1403, S-1404). Where a transaction stands is
read against the chain as it is now: `positionOf()` takes the step it was
left at (`current_step_code`) and returns the first enabled step from there,
so a step disabled under a queued transaction moves it on to the next role's
queue with no code change (S-1402), and null means no enabled step remains
and an administrator has to enable one. Every step but the last is a review
(`transaction.review`: forward or return); the last is the decision
(`transaction.approve`: approve or reject) — by position, not by step name,
so a chain re-shaped at Configuration → Workflows needs no release. The
comment is mandatory on return and reject, checked in the library so no
caller skips it. Acting also needs the step's configured role, and the
segregation rules refuse the officer who captured it (0069, 0071).

`/transactions/pending` is one queue for every kind: what waits at a step the
person's role owns, what is approved for them to post (`transaction.post`),
and their own captures a reviewer returned. The sidebar badge on
Transactions counts the same three, so a badge counts what its own link
opens — the President's number on Applications stays the applications.

Approval decides; posting moves the money. `postApprovedTransaction()` is a
separate act by someone with `transaction.post` who did not capture it, and a
deposit takes its receipt there, since a receipt is issued when money posts.

The strip at the top of the transaction page is the chain as it is now
(S-1405): `chainTimeline('transaction', id)` in `src/lib/workflow/timeline.ts`
puts Recorded and Posted either side of the enabled steps of the
transaction's chain, done where the trail says it passed, current where
`positionOf` says it stands, so a deposit routed nowhere shows no approval
stage at all and a step disabled today is gone from every chevron rendered
from now on. A returned transaction reads as back at Recorded, red, naming
who returned it; a rejected one marks the step that rejected it. The trail
underneath is the log, not the chain (S-1406): it still names a step that
has since been disabled, and the audit log lists the same acts under the
transaction's reference, which the transaction page also answers to
(`/transactions/TX-000123`).

A returned transaction is its captor's to correct, and nobody's while it
sits at a step. `resubmitDeposit()` changes amount, method, reference, note
or account (one of the same holder's), writes both versions to the audit
trail, and hands the routing decision to `resubmitTransaction()`: the matrix
is read again, and when it names the same chain and the returning step is
still enabled the transaction re-enters there — an approval already given is
not asked for twice. When the amount crossed a band, or the chain changed,
the rule that would apply to a first submission applies now (decision 11):
the first step of the new chain, or posted at once, which a Clerk without
`transaction.post` is refused.

## Receipts

Every transaction that posts takes its receipt from `receipt_number`, the one
sequence payments have used since 0017 (S-1601, FRD 6.8): a deposit and a
withdrawal when they post, a chained one at disbursement, a transfer on its
debit leg — the two legs share one receipt — and a reversal on its own. The
number is allocated as a committed row before the post and issued inside it,
exactly as a payment's (`docs/payments.md`), so a number that never became a
receipt shows in the sequence with its reason. A transaction still on its
chain has no receipt yet.

`/receipts/{id}` answers to a transaction's id, its number's id or the number
itself and renders the sheet from the transaction alone
(`src/lib/ledger/receipts.ts`, `TransactionReceiptSheet.astro`): who,
which account, the other side of a transfer or the payee, the method, who
recorded and who posted, the amount and the balance after. Printing is
recorded on `receipt_print` (0075), so a reprint says so, as a payment's does.

**Void** (S-1603) withdraws the number with a reason — `receipt.void`, the
Treasurer's, never the officer who captured it — and leaves the transaction
posted: the money moved, and undoing that is a reversal. The void is a
`transaction.voided` event on the stream and a row on the audit trail. The
reconciliation page lists a voided transaction receipt beside a voided
payment receipt, opening the transaction, and counts a transaction's receipt
in the period's total by the direction of its entry (a leg between two
accounts here counts nothing). The receipts report shows kind, reference,
method, amount and the void reason, with totals by method.

**Sent to the member** (S-1602): `notifyReceiptIssued()` in
`src/lib/ledger/receipt-notifications.ts` raises `receipt.issued` — an
email and a WhatsApp template, migration 0076, edited like any other at
Configuration → Notification wording — to the email and mobile on the
holder's application (the same `contactFor` M9 uses, so a minor's goes to
the guardian). Every path that issues a receipt calls it after its
transaction commits: a deposit or withdrawal posting directly, a chained
one at disbursement, a transfer (once, for the debit leg), a reversal. It
never throws and returns the notification ids, so a post whose message
failed is still a post, and the delivery log says what happened. The
receipt page lists where it went and re-sends it with **Send**, to whatever
address the member has now; a voided receipt is not sent.

The message carries a link rather than a file: a JWT (`jose`, HS256) signed
with `MEMBER_SESSION_SECRET` — the member-facing secret, since it is the
member's to open — naming one transaction, with purpose `receipt`, good for
thirty days (`src/lib/ledger/receipt-links.ts`). `/receipts/shared/{token}`
is public in the middleware; the token is the credential, and the page
renders the sheet with nothing that leads into the officer's screens, or
one line saying the link no longer works. The origin is `PUBLIC_APP_URL`,
else `ENTRA_REDIRECT_URI`'s; with no origin or no secret the wording's
`{{link}}` reads "Ask at your branch for a printed copy." instead. The
receipt as a document is the story's Should half, built since migration
0089: the same token with `.pdf` on the end serves the sheet as a PDF
(`src/lib/ledger/receipt-pdf.ts`), attached on whichever channel's wording
says so — `docs/notifications.md` has how each provider carries it.

## The statement

`accountStatement(accountId, from, to)` in `src/lib/ledger/ledger.ts`
(S-1604) is the account over two calendar days, inclusive, in the
database's day: the opening balance is the sum of every entry posted before
`from`, each entry in the period carries the balance after it (the same
window over `sequence_no` the history uses), the totals in and out are
summed in cents, and the closing balance is the last line's, or the
opening one when nothing moved. Nothing is read from `account_balance`, so
a statement is exactly what the entries say.

`GET /api/v1/accounts/{id}/statement?from&to` returns it; with neither
date it is the month to date, and either alone takes the other from it
(`statementPeriod()` in `src/lib/ledger/statement.ts`). `format=xlsx`
returns the same through S-905's `reportToWorkbook`, opening and closing
balance as the first and last rows so the sheet reconciles without adding
anything up. `/accounts/{id}/statement`, linked from the account's history,
shows it with a period form, prints through the browser as a receipt does,
and links the download.

## Who may do what

`transaction.capture` records; `transaction.post` posts directly below the
escalation threshold, so a deposit — one act — needs both, and posts an
approved transaction off its chain; `transaction.review` and
`transaction.approve` act at a chain's steps; `account.view` reads a
balance or a history; `transaction.view` reads transactions and the queue;
`receipt.void` voids a receipt. The default mapping and the segregation
rules are in `docs/access-control.md` (S-1311). The capture path writes a
`transaction.captured` audit row before `post_transaction()` writes
`transaction.posted`, which is what the rules key on.

## Reversal

A `reversal` names the transaction it reverses (`reverses_id`) and posts the
opposite direction on the same account, for no more than the original moved.
The original is never touched. It is the shape S-1505 asks for (decision 12),
and refunds of carried lines use it now. `post_transaction()` reads the
direction from the original's own entry, so reversing a reversal restores it.

`reverseTransaction()` in `src/lib/ledger/reversals.ts` is the correction of
a posted mistake: `receipt.void` (the Treasurer's, as voiding a payment is),
a reason that is required, a transaction that is posted and not already
reversed, and never the officer who captured it (0074's segregation rule).
It inserts the reversal, posts it through the engine and issues it a receipt
of its own, in one database transaction; a transfer is reversed whole, both
legs, the receipt on the reversal of the leg named. The trail on the
original records `transaction.reversed` with the reversal's reference. The
review page offers Reverse on a posted transaction to whoever holds the
permission, and `POST /api/v1/transactions/{id}/reversals` is the endpoint.

**Drafts** (S-1505's first criterion) are not persisted for transactions: a
form abandoned before Submit records nothing — no reference, no receipt, no
ledger effect — which is the same outcome the story asks of a draft without
a `draft` row whose generated reference would burn a number in the
sequence. The `draft` status stays in the vocabulary for a later capture
path that saves as it goes. Recorded as decision 17.

## Closing an account

A closure (S-1702, `src/lib/ledger/closures.ts`, migration 0077) is a
transaction of kind `closure`. The matrix has routed the kind since 0070 —
always Secretary → President as seeded — so a request rides the same chain,
queue, trail and chevron as a withdrawal and is paid out through the same
disbursement step. Only an account that is not the membership's default can
close here: Shares and the MSA go together, and the refusal says by name
that taking them away is a resignation (S-1703).

The request has a life before its chain. `startClosure()` writes a draft
naming the account, the reason (mandatory: it goes on the signed request)
and how the balance goes back, with the balance as it stands. The member
signs the request on `/closures/{id}/form`, a sheet rasterised and filed
against the transaction — `document.transaction_id`, the third owner
(`docs/documents.md`) — so a member who closes two accounts over the years
has two signed requests, not one replacing the other. `submitClosure()`
refuses without it, refuses while any other transaction is still on its way
on the account, sets the amount to the balance now, puts the account into
`closing` — every capture path refuses a non-active account, and
`availableBalance()` counts the closure as a pending debit — and hands the
routing to `submitTransaction()` or, for a returned request,
`resubmitTransaction()`. `cancelClosure()` withdraws a draft or a returned
request and reopens the account; `reviewTransaction()` does the same on a
rejection. The chevron is `closurePrelude()`'s Details → Signature →
Documents before Submitted, the chain and Closed (`timeline.ts`); a draft
shows the chain the matrix would send it to today.

Posting is `postApprovedTransaction()` with a disbursement, as for a
withdrawal. It reads the balance again into the amount, and
`post_transaction()` refuses a closure whose amount is not the balance at
that moment — nothing is left on a closed account, nothing is paid that is
not there. The floor does not apply: it is what an open account keeps. The
debit entry (none for an empty account, which still closes) and
`account.status = 'closed'`, dated, are written in the same statement, and
the `transaction.posted` event carries `account_closed`. A closed account
no longer counts against one account of each type per holder (0018, 0027),
so the member can open another later.

**Reopening** (M26, migration 0090): "another" means the same one. The
closed account's row on the member's page offers **Reopen**, which starts
the additional-account application for that type (the same one that opened
it, through the same chain, `startAdditionalAccountApplication`), and the
row says "Reopening · APP-…" while it is on its way
(`accountApplicationsInFlightFor`). On approval `openAccountsForApplication`
finds the holder's closed account of the type and reactivates it —
`status` back to the type's default, `closed_at` cleared, `reopened_at`
set, the approving application recorded as `opened_by_application_id` —
under its own id and its own number, so HSA0001 comes back as HSA0001 with
its history in one place rather than an HSA0002 beside a dead HSA0001. The
audit action is `account.reopened`; the row wears "Reopened {date}" from
then on. The "already holds" refusal at approval and the offer of types to
open both ignore a closed account, and a customer's closed account reopens
the same way (`openAccountsUnderCustomer`).

`member.status` is a check constraint since 0077 (S-1701) — pending,
active, inactive, dormant, resigned, demised — with `status_changed_at`
beside it; `src/lib/members/status.ts` is the same list for the code and
the one rule the capture paths already apply: only an active holder
transacts or opens an account. `dormant` is set by the nightly
`dormancy-detection` job after `dormancy.months` without a posted entry or
a fee payment on any of the member's accounts, and unset by an officer with
`member.reactivate` and a reason (M22, `src/lib/members/dormancy.ts`,
`docs/jobs.md`).

## Resigning

A resignation (S-1703, `src/lib/ledger/resignations.ts`, migration 0078)
is a transaction of kind `resignation` on the member's Shares account,
covering every account of a membership-default type: Shares and the MSA go
together and cannot be resigned singly (FRD 7.2), while a Hajj Savings or
Investment account is untouched and closes, if the member wants it closed,
on its own request. The request's life before its chain is a closure's —
`/members/{id}/resign` starts a draft, `/resignations/{id}` is the wizard,
`/resignations/{id}/form` the sheet the member signs, filed against the
transaction — and it rides the same chain, queue, trail and chevron
(Details → Signature → Documents → Submitted → the chain → Resigned).

What is its own is the **pre-checks** (`checksFor()`), each a
configuration switch at Configuration → Fee schedules (`config_entry`,
`resignationChecks()`) and each named on the request when it blocks: no
transaction still on its way on either core account; the joining fees
fully paid (`amountDueForApplication` less the live payments against the
founding application; a legacy member with no application here has
nothing to check); and no financing outstanding, a hook for Phase 3/4 that
passes until something records financing, seeded off. A check switched off
is shown as not checked and never blocks.

`submitResignation()` refuses without the signed request or while an
enabled check fails, sets the amount to what both accounts hold, puts both
into `closing`, and routes by the matrix's `resignation` kind. Rejected or
withdrawn, both are active again. Posting is S-1503's disbursement, one
receipt for the combined balance: `postApprovedTransaction()` reads the
balances again into the amount, and `post_transaction()` refuses a
resignation whose amount is not their sum, writes one debit per account
for what it holds, closes each as it empties, and ends the membership —
`member.status = 'resigned'`, `status_changed_at = now()` — in the same
statement. The `transaction.posted` event carries `account_closed` and
`membership_ended`. From that day the member's documents have the anchor
retention was waiting for (`docs/retention.md`).

**Rejoining** (M26, migration 0090). A resigned member's page offers
**Rejoin** to an officer with `application.capture`, which starts a
membership application of their type — the same form, the same fees the
schedule asks, the same chain that admitted them — naming the member
(`membership_application.rejoins_member_id`, `startRejoinApplication`),
with the founding application's parties copied in for the officer to check
rather than retype and its documents filed into the founding folder. The
page says "Rejoining · APP-…" while it is on its way (`rejoinInFlightFor`;
one at a time), and the application page wears "Rejoining as AB0001". On
approval `createMemberFromApplication` sees the member named and, rather
than inserting a second member with a second number, reactivates the one
row: `status` back to active, `rejoined_at` set, the rejoin application
recorded as theirs, and the Shares and MSA the resignation closed
reactivated under their own ids (`reopened_at`, as for a closure), a
membership-default type they never held opening fresh. The rejoin
application keeps its APP reference — the AB number already belongs to the
founding application. Audit: `member.rejoined`, `account.reopened`. The
page's header reads "joined {date} · rejoined {date}" from then on. A
demised member does not rejoin; a dormant one is reactivated, not
re-admitted (M22).

## A deceased member's claim

A claim (S-1704, `src/lib/ledger/demises.ts`, migration 0079) is a
transaction of kind `demise` covering every account the member holds, of
any type. The claimant is who is paid: the nominee the member named on
their application (S-602, `nomineeFor()`) by default, or another person
the officer records in full — name, NIC, address, relation — carried on
the transaction (`claimant_kind`, `claimant`) with the name in
`payee_name`, which is what the receipt reads "Paid to" from. The request's
life before its chain is a closure's without a signature of the member's
to take: **Demised claim** on the member's page starts a draft
(`/members/{id}/demise`), `/demises/{id}` is Claimant → Documents →
Submit, and the death certificate and the affidavit are filed against the
transaction from the Documents step through the same upload path as any
document. The affidavit is a category, not a validation: whether the file
is the right legal instrument is the reviewer's call, and the wizard and
the review screen say so in one line (FRD 7.3).

The two figures (`claimTotals()`): what every account holds, and the
**Takaful benefit** — the Society's own money, `demised.takaful_benefit`
at Configuration → Fee schedules (default 15,000, Administrator-editable),
read when the claim is submitted and carried on the transaction
(`takaful_benefit`) as its own line, in the total and never in the ledger,
which only ever says what an account held. `submitDemise()` refuses
without both papers or while any transaction is still on its way on any
of the member's accounts, sets the amount to the accounts' balances plus
the benefit, and puts every account into `closing`; rejected or withdrawn,
all are active again. Posting is S-1503's disbursement, one receipt:
`postApprovedTransaction()` reads the balances again, `post_transaction()`
refuses a claim whose amount is not their sum plus the benefit, writes one
debit per account, closes each as it empties and ends the membership —
`member.status = 'demised'`, dated, a distinct value from `resigned` for
the exits report (S-1806) — in the same statement. The `transaction.posted`
event carries `account_closed`, `membership_ended`, `takaful_benefit` and
`claimant`. The retention anchor is the same as a resignation's.

Every stage of an exit is told to its member or claimant (S-1705,
`src/lib/ledger/exit-notifications.ts`, `docs/notifications.md`); a
deposit, a withdrawal and a transfer tell the member the same way
(S-1803, `src/lib/ledger/transaction-notifications.ts`), the step's role
hears of every arrival and the captor of every return (S-1804), and
whoever else may void hears of a void (S-1805,
`src/lib/ledger/void-notifications.ts`) — all after the commit, none able
to fail it; and the
**Exits** report (S-1706, `src/lib/reports/definitions.ts`) lists closures,
resignations and claims by the period they were submitted in: who, what
was paid out and to whom, the benefit, the status, and the days from
submission to payout — or to the decision, or to today, for one not paid
out.

The rest of FRD 13's reports (S-1806) sit beside it. **Transactions**:
everything recorded in a period, by kind, method and officer, with its
status, receipt and posting date and the posted totals by kind in the
summary; a transfer shows once, as its debit leg, and a draft not at all.
**Approvals**: everything that went to a chain — which step and role it
waits at, or "Payout" once approved, the days since submission for one
still waiting and to the decision for one decided, and the average
turnaround in the summary. **Accounts near their minimum**: open accounts
whose balance is within a margin of their type's floor, the configured
near-floor margin unless a figure is typed, with the headroom and whether
they are at or below it. The **Accounts** report (S-905) gains a balance
column and filters by status and by a balance band. Region is not among
the filters: nothing in the data records one (the regional roles are
roles, not places), so a filter would be a lie. The cashier's own report
is under "The cash drawer".

## The Society's bank accounts

Where the money went or came from, on the Society's side (S-1901, S-1902,
FRD 15): `transaction.bank_account_id` names one of the accounts
configured at Configuration → Bank accounts, and wherever the method
touches a bank it is mandatory together with the method reference — the
two things a bank statement is matched on. A deposit says at capture (its
method is final then, chain or no chain); a withdrawal, a transfer to a
payee and an exit say at capture when they post at once and at
disbursement otherwise, beside the method and reference; a reversal
inherits the original's. `requireBankAccount()` in
`src/lib/ledger/bank-accounts.ts` is the rule at every one of those
points, in the caller's own words, and `post_transaction` (0083) is the
guarantee underneath: it refuses to post money through a bank without
both, whatever path the transaction took. The posting's `financial_event`
payload carries `bank_account_id` beside `method_reference`, which is what
Phase 5's reconciliation reads. The ledger refuses anything but an active
account of the Society's. Each account's balance is derived from the
posted transactions naming it (`docs/configuration.md`).

## The cash drawer

A cashier's drawer (S-2001, S-2002, FRD 14) is a `cash_session`
(migration 0084): opened with a float, closed against a count. What it
should hold is never typed in. It is the float plus every cash movement
the database attributed to the session while it was open — and the
attribution is the database's, not each path's: when a cash transaction
posts, a trigger writes the open session of whoever posted it onto the
row (`transaction.cash_session_id`), and when a cash fee receipt or refund
is recorded, the open session of whoever recorded it
(`payment.cash_session_id`). A movement with no open session belongs to
no drawer, and the daily report says so. Money credited to a member's
account or taken on a fee receipt is cash in; money debited or refunded is
cash out; a voided fee receipt was never taken.

`src/lib/cash/sessions.ts`: `openSession` (one open drawer per cashier,
refused otherwise), `drawerFigures` (float, in, out, expected, and every
movement), `closeSession` (the cashier's own only; the expected figure,
the count and the over or short are fixed on the session then and never
recomputed; a closed session cannot change and no session is deleted),
`listSessions` for a holder of `cash.view`. Opening and closing are
audited with the figures. **Cash drawer** is the cashier's own page;
**Cash drawers** lists every session for the Treasurer, the Regional
Manager and the Auditor. There is no region or branch to record: nothing
in the data has one, so a session is a cashier's.

**Daily cash reconciliation** (S-2003, `cash.view`, in
`src/lib/reports/definitions.ts` beside the other reports) is the day's
account of the till: one row per drawer in the period — day, cashier,
opened and closed, float, cash in, cash out, expected, counted, over or
short, movements and the note — and one row per day and officer for the
cash that moved with no drawer open, so a cash deposit posted by somebody
who never opened a drawer is on the sheet rather than missing from it. A
closed drawer's expected figure is the one fixed at closing, the record;
the cash in and out beside it are what the database attributes to the
drawer now, and the only way they can disagree is a fee receipt voided
after the drawer closed (a posted transaction never changes and a
reversal is a new movement), which the row's status says. An open
drawer's expected figure is live. The summary gives the counted total
against the expected and the net over or short across the closed
drawers, and the total moved outside any drawer.

## History, across accounts

`listTransactions()` in `src/lib/ledger/history.ts` (S-1506) is one query
for every kind and every status, newest first, paged, filterable by member
or customer (across all their accounts), account, kind, status and the dates
recorded between. A transfer shows once: its credit leg is left out wherever
its debit leg is in the same list — the same holder, or no holder filter at
all — and shows on its own only for the person who received it. The person's
page links to `/members/{id}/transactions`; the Transactions page links to
`/transactions/all`, the Society's day by default (there is no region on a
transaction or a principal yet, so the day is everyone's); and
`GET /api/v1/transactions` takes the same filters.

## Direction

From the account holder's side, because that is how a member reads a
statement:

| Direction | Means                               | Balance |
| --------- | ----------------------------------- | ------- |
| `credit`  | Money in — a deposit, a transfer in | rises   |
| `debit`   | Money out — a withdrawal, a payout  | falls   |

`balance = sum(credits) − sum(debits)`. A deposit is one credit entry. A
reversal of one is one debit entry; a withdrawal is one debit entry (M15). A transfer (M15) is a debit on the source
and a credit on the destination, both under one transaction pair.

A transaction is held by a member **or** a customer (0027's non-member
account holders), exactly one — the check `transaction_has_one_holder`.

## What cannot change

| Table             | After the insert                                                  |
| ----------------- | ----------------------------------------------------------------- |
| `account_entry`   | Nothing                                                           |
| `account_balance` | Only through `post_transaction()` and `rebuild_account_balance()` |
| `transaction`     | Working columns until posted; nothing once posted                 |

A transaction's identity — reference, kind, holder, who captured it, when,
what it reverses, what receipt line it carries — never changes even while it
is a working record (`guard_transaction`).

A `transaction` is a working record before it posts: a draft can be deleted
by the officer who started it, a returned one is edited and resubmitted. Its
identity — reference, kind, member, who captured it — never changes. Once
posted, nothing changes: a mistake is a **reversing transaction** that names
the original, through the same function, on its own receipt. Never an edit.

Enforced by triggers **and** by the grants, as `docs/payments.md` describes
for payments; every guard honours the test-data reset's flag (migration 0019)
so `reset_all_test_data()` reaches these tables too.

## Order

`account_entry.sequence_no` is the posting order, and it is what a running
balance is computed over. `posted_at` alone would not do: two entries in one
transaction share it.

## Money

Decimal strings across the boundary, integer cents for arithmetic — the rule
`docs/payments.md` sets, for the same reason. The running balance on a
statement is computed in SQL, over the entries, so it is exactly what the
ledger says whatever the cache does.

## `financial_event`

The stream Phase 5 will consume gained a second subject. `payment_id` may now
be null, `transaction_id` was added, and exactly one of the two is set.
`transaction.posted` joins the three payment events, carrying the whole
posting self-contained: reference, kind, account, direction, amount, method,
receipt, the balance after, who and when. Migration 0017 is on `main` and was
not edited; 0064 widened it.
