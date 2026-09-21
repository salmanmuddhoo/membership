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
  still needs an active account.
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
  `/me/accounts/{id}/transactions` (`docs/member-app.md`).
- **The Members list's Total funds** is the sum of the cache over every
  account the person holds, whichever application opened it.

Nothing derives a balance from payments any more: the stand-in that read
"opening payment less refund" is gone, because those two lines are now the
account's first entries (S-1303).

## Who may do what

`transaction.capture` records; `transaction.post` posts directly below the
escalation threshold, so a deposit — one act — needs both; `account.view`
reads a balance or a history; `transaction.view` reads transactions;
`receipt.void` voids a receipt. The default mapping and the segregation
rules are in `docs/access-control.md` (S-1311). The capture path writes a
`transaction.captured` audit row before `post_transaction()` writes
`transaction.posted`, which is what the rules key on.

## Reversal

A `reversal` names the transaction it reverses (`reverses_id`) and posts the
opposite direction on the same account, for no more than the original moved.
The original is never touched. It is the shape S-1505 asks for (decision 13),
and refunds of carried lines use it now. `post_transaction()` reads the
direction from the original's own entry, so reversing a reversal restores it.

## Direction

From the account holder's side, because that is how a member reads a
statement:

| Direction | Means                               | Balance |
| --------- | ----------------------------------- | ------- |
| `credit`  | Money in — a deposit, a transfer in | rises   |
| `debit`   | Money out — a withdrawal, a payout  | falls   |

`balance = sum(credits) − sum(debits)`. A deposit is one credit entry. A
reversal of one is one debit entry. A transfer (M15) is a debit on the source
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
