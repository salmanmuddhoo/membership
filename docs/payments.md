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

**A required component's amount is not one an officer can edit on the
application page** — the input is `readonly`, carrying whatever the fee
schedule set, so the figure the officer sees recording a payment is always
the one Configuration published. Only an optional component's amount is
editable there, and the page's **Total** figure — every component's amount,
required and optional alike, recomputed as the optional one changes — is a
display-only convenience distinct from `expectedTotal` above, which stays
required-only because that is the figure the variance check is against. This
is a page-level lock, not a service-level one: `recordPayment` still accepts
a required amount that differs from the schedule, given a reason, exactly as
before. Nothing on this page can produce that request any more, but a
correction made another way — direct API use, say — still can.

## Cash

Two configurable controls apply to cash and nothing else, both in
`applyCashPaymentRules` (`payments.ts`), checked in this order for every
cash payment regardless of which of the three application kinds it is
against — `recordPayment` and `recordAccountOpeningPayment` both call it, so
there is one place this is enforced rather than three.

**A hard ceiling first** (`payment.cash_maximum`, config_entry, default
500,000 MUR). Above it, the payment is refused outright — not a reminder, a
refusal, and nothing on the Payments page can override it. Checked before
anything else: a payment too large to take is too large to take regardless
of what the source-of-fund note says.

**Above the ceiling, the refusal is the only thing on screen.** The two
rules are independent on the server and were shown that way at first, so a
cash total of 600,000 asked the officer for a Source of Fund form _and_ told
them the payment was not authorised — work to prepare a payment that cannot
be taken however well it is answered (officer feedback). The Payments step
now hides the source-of-fund reminder, the link to the form and the Source of
fund field whenever the ceiling is crossed, leaving the refusal and a
disabled submit. The server is unchanged: it still checks the ceiling first
and refuses on its own, because a screen deciding what to show is not a
control.

**A source-of-fund requirement above a lower threshold**
(`payment.cash_source_of_fund_threshold`, default 45,000). Above it, a
receipt cannot be issued until `sourceOfFund` is non-empty and
`sourceOfFundFormConfirmed` is true. Both are plain fields on `payment` —
this module has no opinion on how `sourceOfFundFormConfirmed` became true,
only that it is.

The free-text **Source of fund** field that used to sit beside it is gone,
and with it the server's own requirement that it be non-empty (officer
feedback). The filed form already carries where the money came from, ticked
and signed by the depositor; asking the officer to type it again was asking
the same question twice, and answering it in a box nobody signed. What
remains above the threshold is the form itself. The `payment.source_of_fund`
column stays and still holds what earlier receipts recorded — a column that
changed meaning would rewrite history — and is simply written empty from
here on.

**How it becomes true** is the Cash Deposit Form, which is a page of its
own — `/applications/<id>/source-of-fund` (officer feedback, migration
0062). It began as a box on the Payments step, and that was the problem: the
applicant was asked to sign for a declaration they could not read, because
it was a line of small print beside a button. It is now laid out and worked
exactly as the printed application form is — the whole sheet on screen, the
purposes and the source-of-funds list ticked on it, signed at the bottom
with the same full-screen pad, filed when it is right. Rendered to a PDF
client-side (`src/lib/client/pdf.ts`) from the page itself, so what is filed
is the sheet that was read and signed rather than a second rendering of it,
and uploaded through the same brokered path every other document uses
(`src/lib/client/document-upload.ts`) — as `source_of_fund_form`, a document
type that deliberately carries no checklist entry of its own: it is
triggered by the payment amount, not by the applicant's KYC pack, so
`documents.ts`'s `filedDocumentFor` reads it directly rather than through
`checklistFor`.

**What the Payments step keeps is the gate.** While the form is needed and
not yet filed, the step shows one link out to it and the receipt cannot be
issued — the submit is disabled, not merely warned about. Once it is filed
the step names the file, and offers View and Delete: deleting it is the
page's own `delete-document` intent, audited and removing the file from
SharePoint, so an applicant who signed in error simply signs again. The
hidden `sourceOfFundFormConfirmed` field the server reads is set from the
filed document itself and never from anything an officer ticks — the only
evidence the form exists is the form existing.

**Who pays is not always whose account it is.** A Minor cannot pay in for
themselves and a registered entity is not a person, so the depositor named
on the receipt and on the Cash Deposit Form is the guardian and the Contact
Person respectively (`depositorFor`, `src/lib/applications/depositor.ts`) —
officer feedback: both named the child, who had signed nothing and handed
over nothing. One function, because a receipt and a form filed together that
disagree about who paid are worse than either being wrong alone. Both
documents still name the account as well: the form has a NAME at the top and
a NAME OF DEPOSITOR at the bottom, and the receipt gains an "Account of" row
whenever the two differ. For an Individual they are the same person and
nothing changes. An additional account captures nobody of its own, so the
rule is applied to the holder's founding application, which is where their
guardian or contact person was captured.

**The filed form follows the money.** It used to be readable only from the
Payments step of the application that took it, which meant the people it
most concerns could not see it: the Regional Manager, Secretary and
President are deciding on a cash deposit whose declaration they had no way
to open, and an approved application does not show that step at all. It now
appears in the Documents section of the application — its own item, not a
checklist entry, which it never was — and on the member's own page beside
the payment it was signed for.

**The applicant signs it, not the officer.** It is a declaration about where
the depositor's own money came from; the officer witnesses the deposit and
has nothing to declare. The name and NIC printed on it come from the
applicant party, and an additional-account application — which captures no
applicant of its own — prints its holder's name and leaves the NIC as a
ruled line, the way the paper form always did.

**The source-of-funds list is configuration**
(`payment.cash_source_of_fund_checklist`, config_entry, a JSON array of
strings, one item per line on Configuration → Fee schedules). Migration 0062
seeded a placeholder because the wording had not been given; 0063 replaced
it with the paper form's own list. Every item prints on the signed PDF,
ticked or not — a form showing only what was agreed to is not the form that
was signed. The purposes above it are fixed in the component instead: they
are that form's content, not something this system decides.

**Amounts are read off the live total** the officer is about to record
(`[data-payment-total]`) and travel to the form in its own link, so the
figure the applicant signs for and the figure on the receipt cannot
disagree. A signature is cropped to its own ink before it
is used (`src/lib/client/signature.ts`); a full-screen pad exported whole is
a small mark on a very large image, which scales down to nothing on a
signature line.

**Leaving the Payments step does not lose what was typed.** The form is
server-rendered and the link to the Cash Deposit Form is a plain link, so
coming back re-rendered the fee schedule's defaults and the officer found
their amount — and the cash method that made the form's own button appear —
reset to nothing (officer feedback). `keepPaymentDraft`
(`src/lib/client/payment-draft.ts`) holds the half-finished form in
`sessionStorage` under the application's id and puts it back before the
step's first recalculation, so the total and the cash rules above are
computed against what was actually typed. It is a draft and not a record: it
never overwrites a read-only amount, which is the fee schedule's own figure;
it does not outlive the tab or follow the officer to another application; and
it is cleared the moment the payment is submitted, from when the receipt is
the truth.

Without scripting, the checklist and signing cannot run at all — both are
client-side work with no server equivalent — so a `<noscript>` block falls
back to the plain confirmation checkbox this replaces, which still satisfies
the same server-side rule if the paper form is completed the old way.

**A reference is asked for only where there is one.** A cheque, a bank
transfer, mobile money each settle with a number worth recording; cash and
card do not, and a box for a reference under a cash payment is a question
with no answer (officer feedback). Which methods is configuration
(`payment_method.requires_reference`, S-1307, `docs/configuration.md`): each
option on the form carries the flag, the field shows for a method that has
it and is mandatory on the server for the same one, recomputed as the method
changes. Without scripting it simply stays visible. The same table's
`is_cash` is what makes the cash controls above apply — on the method, not
on a list of names in code.

## Refunds

A refund is a `payment` row with `kind = 'refund'`, its own receipt number, and
`refunds_id` pointing at the original. Per component, what is refundable is
what was paid, less what has already gone back, less anything the approval has
earned: **once the application is approved, the entrance fee and the Takaful
contribution are not returned** (FRD 7.10.6). Shares and the MSA deposit are the
member's money and always come back.

Once the application is approved and its Shares and MSA lines are on the
member's accounts (`docs/ledger.md`, S-1303), a refund of either line also
posts a **reversal** on that account, through the engine, in the same
database transaction as the refund. Before approval there is no account and
the refund is only a receipt; the approval carries both the payment and the
refund. A **void** of a receipt whose lines are already on a balance is
refused: the money is on an account, so "this was never taken" would be
untrue, and the correction is a refund.

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

Since M13 the same sequence numbers every transaction's receipt (S-1601,
`docs/ledger.md`), so the reconciliation reads both: a voided transaction
receipt is a finding that opens the transaction, and the period's total
counts a transaction by the direction of its entry.

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
a stamp one print behind is the lesser problem. A transaction's receipt is
printed and recorded the same way (`receipt_print.transaction_id`, 0075).

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

**Recording a payment does not submit it.** It briefly did — the reasoning
was that the wizard had already gated everything else, so the receipt was the
last thing standing between the application and the next person in the chain.
In practice that took the decision out of the officer's hands: they took a
payment, opened the receipt to check it, came back, and found the application
gone from their queue without having asked for that (officer feedback).
Submission is "Next: submit for processing" and nothing else, on all three
application kinds.
