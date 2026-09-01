# Fees, payments and receipts

What an applicant pays is recorded itemised against a sequential receipt
number, and a gap in that sequence is visible. Everything here is in
`src/lib/payments/`; the schema is `migrations/0017_payments_and_receipts.sql`.

## The one design decision worth reading

**A receipt number is allocated as a committed row, on its own connection,
before the payment is attempted.**

The obvious alternative — `nextval()` inside the payment's transaction — cannot
work. Sequences are non-transactional: a payment that rolls back has still
consumed its number, and nothing anywhere records that it did. The sequence
then has a hole no query can explain, which is the exact failure S-502 exists
to prevent.

So the number is a row in `receipt_number`, and the sequence of rows — not the
sequence of the underlying counter — is the evidence:

| State       | Means                                                            |
| ----------- | ---------------------------------------------------------------- |
| `allocated` | Handed out, nothing settled it. Unexplained; reconciliation asks |
| `issued`    | A payment committed against it                                   |
| `abandoned` | The payment failed, and the failure is in `reason`               |
| `void`      | A receipt was issued and later withdrawn                         |

`markReceiptIssued` runs **inside** the payment's transaction, so a number is
issued if and only if the payment it belongs to committed. `abandonReceiptNumber`
runs after a failure, on its own connection, and is deliberately best-effort: it
must not replace the original error with its own. A number nobody managed to
close stays `allocated` and reports as unexplained, which is the honest outcome.

## What cannot change

| Table             | After the insert                                            |
| ----------------- | ----------------------------------------------------------- |
| `receipt_number`  | Number is fixed. State moves one way, `issued → void` aside |
| `payment`         | Only `voided_at`, `voided_by`, `void_reason`                |
| `payment_line`    | Nothing                                                     |
| `financial_event` | Nothing                                                     |
| `receipt_print`   | Nothing                                                     |

Enforced by triggers **and** by revoking the privilege from the application
role, the same belt and braces the audit log has had since 0004. The triggers
are row-level for UPDATE and DELETE: a statement-level DELETE guard refuses the
statement before it looks at any row, which breaks referential actions that
would touch nothing — the defect 0014 had to correct.

A mistake is therefore never edited. It is voided, and money going back is its
own record pointing at the original.

## Money

Amounts cross the boundary as **decimal strings**, never numbers, and all
arithmetic is in integer cents (`src/lib/payments/money.ts`). A `numeric(14,2)`
through a JavaScript float is a rounding error waiting for a large enough
figure, and the variance check on every receipt rests on the arithmetic being
exact.

## What a member is

A member is **one number and two accounts**. AB0001 is the person, their Shares
account and their MSA. Contributing to Shares is what makes someone a member;
the MSA opens beside it at the same moment.

That shapes the fee schedule: **Shares is required, the MSA deposit is
optional.** The account opens either way, and whether money goes into it at
joining is configuration. Both are the member's own money and both are
refundable; the entrance fee and Takaful are the Society's once approved.

## Variance

`expectedTotal` is the sum of the **required** components of the fee version in
force. An optional component that was not taken is not a shortfall. A payment
whose required components do not add up to that total is refused until someone
says why, and what they said is stored on the payment.

The fee **version id** is stored with the payment, so publishing new amounts
cannot reach backwards into what an applicant was charged. That is the
acceptance criterion the versioning in 0010 exists to serve, and
`payments.test.ts` proves it by raising the entrance fee after a receipt and
reading the receipt back.

## Refunds

A refund is a `payment` row with `kind = 'refund'`, its own receipt number, and
`refunds_id` pointing at the original. Per component, what is refundable is
what was paid, less what has already gone back, less anything the approval has
earned: **once the application is approved, the entrance fee and the Takaful
contribution are not returned** (FRD 7.10.6). Shares and the MSA deposit are the
member's money and always come back.

## Who does what

| Permission          | Held by                          |
| ------------------- | -------------------------------- |
| `payment.record`    | Regional Officer                 |
| `payment.refund`    | Treasurer                        |
| `payment.void`      | Treasurer                        |
| `receipt.reconcile` | Treasurer, System Administrator  |
| `payment.view`      | Everyone in the membership chain |

On top of that, segregation of duties (S-203) bars **the person who recorded a
particular payment** from refunding or voiding **that** payment. It is per
record, not per role: a Treasurer who took a payment in a regional office can
still refund every other one.

## Reconciliation

`/receipts/reconciliation` reads `receipt_number` for a period and reports three
findings: a number that never became a receipt, one that was voided, and one
that appears twice. It deliberately does not derive them from the payments — a
reconciliation that reads only the payments cannot see a number that never
reached one.

`missing` — a hole in the run of serials — looks redundant, because the table
has a unique serial and nothing may delete a row. That is why it is checked. A
control that only reports what the schema already guarantees is a control nobody
has confirmed is running.

When there are no exceptions the page says so in words. An empty table would
read the same whether the sequence is clean or the query found nothing.

## The event stream

Every payment, refund and void emits a `financial_event` inside the same
transaction — an event describing a payment that rolled back would be worse than
no event, because Phase 3 would post it. Each carries a self-contained payload
(fee version, components, amounts, method, who) so a consumer never has to join
back into tables that have moved on.

`GET /api/v1/financial-events?after=<sequenceNo>` is the whole protocol: record
the highest `sequenceNo` you have processed and pass it back. `sequence_no` may
gap where a rolled-back transaction took a value; it is a checkpoint ordinal,
not evidence. The receipt sequence is the thing whose gaps mean something.

## Reprints

S-503 asks that a reprinted receipt be identifiably a reprint, which is only
answerable if the first print is on the record. `receipt_print` logs each one,
written when the officer **clicks Print** — opening a receipt to read it is not
a reprint, and marking it as one would make the stamp meaningless within a week.
A failure to record does not stop the print: there is an applicant waiting, and
a stamp one print behind is the lesser problem.

## Reading a member's payments

The receipt that admitted someone names their **application**, not them — they
were not a member when it was taken. `paymentsForMember` therefore looks both
ways, and a query on `member_id` alone finds nothing at all for most members.

## Proving the failure path

The stranded-allocation guarantee cannot be tested by racing two officers.
When the second call happens to run after the first has committed, it is
refused by the duplicate check **before** allocating anything — no number
spent, which is better behaviour but not the behaviour under test. A test
asserting a stranded number then fails on the good outcome.

So the test opens the window deliberately: it holds the application's row lock,
waits until the ledger shows the number has actually been taken, then deletes
the application and releases. `recordPayment` unblocks, finds nothing, and
abandons its number. Waiting on the ledger rather than on a clock is what makes
it deterministic.

## An application that has been receipted

It cannot be deleted, voided receipt or not. Deleting an abandoned draft is for
a draft nobody has acted on; taking payment is acting on it, and the applicant
is holding a receipt that names the application.
