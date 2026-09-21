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

## Direction

From the account holder's side, because that is how a member reads a
statement:

| Direction | Means                               | Balance |
| --------- | ----------------------------------- | ------- |
| `credit`  | Money in — a deposit, a transfer in | rises   |
| `debit`   | Money out — a withdrawal, a payout  | falls   |

`balance = sum(credits) − sum(debits)`. A deposit is one credit entry. A
transfer (M15) is a debit on the source and a credit on the destination, both
under one transaction pair.

## What cannot change

| Table             | After the insert                                                  |
| ----------------- | ----------------------------------------------------------------- |
| `account_entry`   | Nothing                                                           |
| `account_balance` | Only through `post_transaction()` and `rebuild_account_balance()` |
| `transaction`     | Working columns until posted; nothing once posted                 |

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
