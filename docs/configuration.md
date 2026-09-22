# Reference configuration

The values the Society changes without a release: what the application form
asks for, what it costs, which documents are needed, and who approves. This is
M2 Feature 2.2 (S-205 to S-210) and it is the substrate the membership modules
in M3 onwards read from.

Administrators reach it at **/admin/configuration**. Everything below is also
readable as one document from `GET /api/v1/config/reference`.

## Why a change here cannot be anonymous

Migration 0010 puts a trigger on every configuration table. It writes the
change to the append-only `audit_event` table and **refuses any change it
cannot attribute** — including one made by the schema owner at a psql prompt:

```
ERROR:  configuration change to account_type has no actor;
        wrap the write in withConfigurationActor()
```

The actor comes from two transaction-scoped settings, which
`withConfigurationActor()` in `src/lib/db/pool.ts` sets:

```ts
await withConfigurationActor(
  { userId: principal.userId, description: principal.email },
  async client => {
    /* ... */
  }
);
```

Auditing in the service layer would have worked until the day someone added a
table and forgot the call. This way the guarantee S-210 asks for — _every_
configuration change recorded — is a property of the database rather than of
everyone's diligence. `set_config(..., true)` scopes the setting to the
transaction, so the actor cannot leak onto the next request that borrows the
same pooled connection.

An UPDATE that changes nothing but `updated_at` is not recorded: `set_updated_at`
fires on every write, so without that check the trail would fill with rows
saying nothing happened.

## What is configured

### Membership types (S-205, FRD Section 5)

`membership_type` plus `membership_type_field`. The application form renders
from these rows, which is why Individual has an NIC and a gender and Corporate
has a registration number and a contact person instead. Each field carries a
**subject** — applicant, nominee, guardian or Takaful beneficiary — because a
minor's application collects four different people's details on one form.

A field can be hidden or made mandatory without a release. A hidden field
cannot be mandatory; the database refuses it, because capture would deadlock.

`membership_type.nominee_count` (S-602, FRD 5.3) is how many nominee
instances that type's form renders and accepts — 1 to 10, changed from the
same screen, next to a type's fields. It needs no matching schema change: the
form and the mandatory-field check both already work per row of
`application_party`, not per subject. A type that wants nominees to divide
the membership by percentage adds a mandatory `percentage` field the same way
it adds any other one — see `docs/applications.md`.

`membership_type.majority_age` and `majority_transition_type_id` (S-610,
FRD 7.10.10) are how a type's members automatically become another type's,
changed together from the same screen — set together or cleared together,
since one without the other is not something the scheduled job could act on.
Both null by default: the transition exists but does nothing until an
administrator sets both. See `docs/jobs.md`.

### Account types (S-206, S-1304, FRD 7.6, 4.3)

`account_type`. Every row with `is_membership_default` is a product a
membership approval opens — Shares and the MSA since migration 0018, one
number, two accounts. The service refuses to clear or deactivate the last one,
because an approval that opens nothing is a half-created member. Changing the
set affects approvals from that moment on; accounts already opened are
untouched.

Each type also carries what the transaction engine reads before it moves
money on an account of that type (migration 0065):

| Column                       | Means                                                                                                              | Seeded                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `minimum_balance`            | The floor. One figure, read identically by a withdrawal and a transfer out — FRD 4.3 is explicit there are not two | Shares: its opening minimum (5000); others 0 |
| `allows_deposit`             | Whether a deposit may be posted to it                                                                              | true                                         |
| `allows_withdrawal`          | Whether a withdrawal may                                                                                           | true                                         |
| `allows_transfer`            | Whether a transfer, in or out, may                                                                                 | true                                         |
| `maximum_transaction_amount` | The most one transaction may carry; null is no limit, and zero is refused (that is what the switches are for)      | null                                         |

All five are edited on Configuration → Account types and audited by the same
trigger as the rest of the row; a change applies to the next transaction, with
no release. In `AccountTypeInput` they are optional: a caller that omits one
gets the column default on create and leaves the current value alone on
update, so a test or an import with no opinion on limits need not hold one.
The configuration screen always sends all five.

### Fee schedules (S-207, FRD 7.8.1)

`fee_schedule` → `fee_schedule_version` → `fee_component`.

**Amounts are versioned, never edited in place.** Publishing a change closes
the live version and opens a new one. That is what makes "existing receipts are
untouched" a property of the schema: a receipt records the version it charged,
and that row's amounts can no longer change. Overwriting an amount would leave
the row a receipt pointed at silently meaning something else.

Each component is `required`, `optional` or `not_applicable`. The third exists
because the FRD leaves the processing fee (7.8.3) and the minor MSA deposit
(7.10.6) unconfirmed, and "the Society decided this does not apply" must be
distinguishable from "nobody has configured it yet".

Amounts are `numeric` in the database and decimal **strings** in TypeScript and
JSON. Money through a float is a rounding error waiting for a reconciliation to
find it.

**Demised claims (S-1704)** sit on the same screen: `demised.takaful_benefit`
in `config_entry`, the Takaful benefit (MUR, default 15,000) paid to the
claimant beside the balances of the member's accounts, read when a claim is
submitted and carried on the claim from then. `docs/ledger.md`, "A deceased
member's claim".

**Near-floor notice (S-1803)** sits on the same screen:
`balance.near_floor_margin` in `config_entry` (MUR, seeded 500 by 0081): a
posted withdrawal or transfer that leaves an account within this much of
its type's minimum balance sends the holder the `balance.near_floor`
advisory; 0 sends none. `docs/notifications.md`, "A member's own
transactions".

**Resignation checks (S-1703)** sit on the same screen: three switches in
`config_entry` (`resignation.check_pending_transactions`,
`resignation.check_unpaid_fees`, `resignation.check_financing`), each a
check a resignation must pass before it can be submitted and each named on
the request when it blocks. The financing one is a hook for Phase 3/4 with
nothing behind it, seeded off. `docs/ledger.md`, "Resigning".

### Payment methods (S-1307, FRD 6.6)

`payment_method`. How money moves, as a row rather than a check constraint
and a constant (migration 0067 replaced both, mapping every existing code).
Each carries what the rest of the system asks of a method:

| Column               | Drives                                                                        |
| -------------------- | ----------------------------------------------------------------------------- |
| `is_cash`            | The cash controls: the Source of Fund threshold and the ceiling (below)       |
| `requires_reference` | The reference field: shown and mandatory for this method, absent otherwise    |
| `touches_bank`       | Bank reconciliation (M19) — the money reaches a bank account                  |
| `is_system`          | Written only by the system, never offered, not editable: `migration` (0048)   |
| `is_active`          | Offered on a form. Retiring a method keeps every receipt it was used on whole |

Seeded with today's five under their existing codes, the FRD's six additions
(Juice, salary deduction, standing order, deposit at bank, internet banking,
other) and the import's own. `payment.method` and `transaction.method` are
foreign keys to `code`. A record carries the method's name beside its code
(`Payment.methodName`) so a retired method still reads on the receipt that
used it. Configuration → Payment methods.

### Bank accounts (S-1901, FRD 15)

`bank_account` (migration 0082): the Society's own accounts at the bank —
code, name, bank, the number, currency, an opening balance and the date it
stood on, active or not — audited like every other configuration table.
Its own two permissions rather than `config.view` / `config.manage`, because
an account number is not a fee schedule: `bank_account.view` reads the list
with the number masked to its last four digits (the masking is done before
the page renders, so a viewer never receives the whole number),
`bank_account.manage` sees it whole and may add or change one. The
Treasurer holds both, the Auditor the first, the System Administrator both.
Configuration → Bank accounts; `/admin/configuration/bank-accounts` is
declared with `bank_account.view` in `authorise.ts`, the longer prefix
winning over the section's `config.view` rule.

No balance is stored. `bankAccountBalances()` in
`src/lib/ledger/bank-accounts.ts` derives one when asked: the opening
balance, plus every posted transaction that names the account — credited to
a member's account means money came into the bank, debited means it left,
read off the posting's own `financial_event` row — leaving out a transfer
between two accounts here, which moves nothing at the bank. There is no
second ledger to drift from the first.

`transaction.bank_account_id` is mandatory, with the method reference,
wherever the method touches a bank (S-1902, `payment_method.touches_bank`):
a deposit says at capture, its method being final then; a withdrawal, a
transfer to a payee and an exit say at capture when they post at once and
at disbursement otherwise; a reversal inherits the original's. The
application asks in each form and each endpoint, and `post_transaction`
(0083) refuses to post money through a bank without both — the guarantee
underneath whatever path a transaction took. The ledger refuses anything
but an active account of the Society's.

### Approval matrix (S-1401, FRD 6.5, 9, 17)

`approval_rule`. Which chain — or none — a transaction falls under: by kind
(deposit, withdrawal, transfer, closure, resignation, demise), an amount band
(inclusive at both ends; `amount_to` null for "and above"), optionally an
account type and the role that started it, routing to a `workflow_definition`
with `entity_type = 'transaction'` or to nothing, which means "post at once".
Ordered within a kind; the first match wins (`resolveRoute`,
`src/lib/ledger/routing.ts`). No match sends the transaction to the most
demanding chain configured for its kind — an administrator who forgot a band
gets a review, never a silent post.

The threshold FRD 9 wants configurable **is** the band on the rule, edited
here, not a second number the rule would have to be kept in step with. The
defaults are FRD 6.5's table: deposits, withdrawals and transfers post up to
100,000 and go Secretary → President above it; closures, resignations and
demised claims always go Secretary → President. The 100,000 is a placeholder
for the Society to confirm (open point 15).

The chains themselves are ordinary workflow definitions — one per kind,
seeded — and Configuration → Workflows edits their steps with no new screen;
`activeChain` reads them live, so a disabled Secretary step means the next
large deposit waits at the President. A rule that has routed a transaction
cannot be deleted, because the trail names it; deactivate it instead.

### Document checklists (S-208, FRD 8.4.1, 7.10.5)

`document_type`, `document_checklist`, `document_checklist_item`. An item is a
(document, subject) pair, so an Individual application requires an ID card for
the applicant _and_ one for the nominee. Corporate applicants require no ID
card — a registered entity does not have one, and requiring it would block
capture. The signed application form is required for every type (FRD 8.5).

### Workflows (S-209, FRD 7.4.2, 7.4.3)

`workflow_definition` → `workflow_step`, and `workflow_status`.

A step is assigned to a **role**, never a person (decision 4): any holder may
act, so the chain does not stall when one officer is away. The confirmed chain
ships enabled — Regional Officer → Secretary → President. The **Regional
Manager** oversight ships as a step with `is_enabled = false` (decision 2):
present so an administrator can switch it on, rather than absent and forgotten.
`activeChain()` skips disabled steps, so enabling it changes behaviour with no
code change.

A step whose `from_status` equals its `to_status` is a **gate**: it must be
acted on before the chain proceeds but does not move the record. The Regional
Manager review is one. FRD 7.4.3 confirms no status for it, and inventing one
would put a state in the model the business has not agreed to.

**Execution honours the gate (S-611).** Enabling Regional oversight is not
only a label change: `assertMayAct` (`workflow.ts`) refuses the Secretary the
`secretary_review` step until a `regional_review` transition already exists
for the application, read from `application_transition` rather than a status
of its own — the same table every step already writes to, gate or not.
Disabling it drops the step from `activeChain()` entirely, so nothing waits
on it and Secretary review is reachable straight from submission, with no
code change either way. `regional_review` and `secretary_review` share the
`application.review` permission (S-209 above), which is deliberate — both
are a review in the everyday sense — so the step's own configured **role**
(`workflow_step.role_id`, exposed as `roleCode`) is what actually separates
them: a Secretary cannot act on the Regional Manager's step, or the reverse,
even though both hold the permission. Regional oversight is audited under
its own action, `membership.application.regional_reviewed`, distinct from
Secretary review's — migration 0024 seeds the segregation rules this makes
possible, barring whoever gave an application its regional oversight from
also reviewing or approving it centrally.

The "Applications" nav item carries a live badge (`pendingActionCount`,
`workflow.ts`) for whichever of Regional oversight, Secretary review and
President decision a signed-in person's own role covers — a count read
fresh on every page render, not a number stored and incremented by hand.

`quorum_count` is 1 everywhere today, changed from **Workflows** with
`setStepQuorum` (S-209). Execution honours it (S-609): above 1 on
`president_decision`, a single decision no longer completes the step —
`decideApplication` waits for that many distinct people to approve (a
reject still ends it immediately, whatever else is recorded) — so turning on
a board quorum needs no migration and no code change, only this setting.

Statuses are configuration (decision 8). **Abeyance** ships `is_active = false`:
the FRD names it, the business has not confirmed it for phase 1, so it is
switched off rather than missing. A status an enabled step transitions into
cannot be deactivated — the chain would otherwise move a record into a state
the configuration says does not exist.

### Readiness (S-1801, S-1802, FRD 9)

FRD 9's rule is that no officer is ever blocked by a value nobody set. Every
milestone's migration seeds its own defaults, and `src/lib/config/readiness.ts`
is how that is proved: one list of every Phase 2 setting — the amounts on
Fee schedules (cash maximum, Source of Fund threshold and checklist, Takaful
benefit, near-floor margin, the three resignation checks), the approval
matrix and the chain for each of the six kinds, each active account type's
floor, cap and allowed operations, the payment methods offered, the
notification wording by subject (receipt, the three exits, a member's
transactions, staff), the transactions a member may start from the app, and
the retention periods — with what each stands at,
whether a person has changed it since it was seeded and, if so, who and
when. `readiness.test.ts` asserts that on a fresh database nothing reads as
missing and everything reads as still at default.

Configuration → Readiness shows the same list, read-only, to anyone with
`config.view`, with a summary of how many are changed, at default and
missing and a link from each row to where it is changed. **Still at
default** is information, not an error: a seeded value is a working one,
and the list exists for the go-live walk-through, where an administrator
reads down it and confirms each figure is the Society's rather than the
FRD's placeholder. **Missing** is the one state that is a problem — a kind
with no active rule (everything falls to its most demanding chain), a chain
with no enabled step, an event with no active wording, no payment method
offered — and on a migrated database it should never appear.

Who last changed a setting comes from two trails: `config_entry_history`
for the plain values (`changed_by` is null on a seed, a user on a change
through the application) and `audit_event` for the configuration tables,
whose trigger records a migration with no `actor_user_id` and a person with
one. A change made by a migration therefore still reads as default, which
is right: nobody at the Society made it.

## Permissions

| Permission            | Grants                                              |
| --------------------- | --------------------------------------------------- |
| `config.view`         | Read every configuration page and the reference API |
| `config.manage`       | Change any of it                                    |
| `fee.manage`          | Publish fee versions                                |
| `bank_account.view`   | See the Society's bank accounts, numbers masked     |
| `bank_account.manage` | See them whole, and add or change one (S-1901)      |

`/admin/configuration/` is guarded by `config.view` as a prefix rule, so a
section added later is covered without touching the route map. Each page then
checks `config.manage` itself before it will write: seeing what the fees are is
a different thing from setting them.

`fee.manage` is held by the System Administrator for now. S-207 names the
Treasurer as its owner, and that role gains it in the milestone that gives the
Treasurer a workload.

### Member app (S-2102, FRD 10)

`member_api.enabled_operations` (migration 0085): which of deposit,
withdrawal and transfer a member may start from the app, empty by default.
Configuration → Member app sets it (`config.manage`);
`enabledMemberOperations()` reads it through the cache. The same migration
seeds the Member role — a system role assigned to nobody, with no
permission — so the approval matrix can name it as an initiating role and
send a member's own transaction to a chain; `docs/member-app.md`,
"Transactions from the app".

## Roles seeded here

Migration 0006 deliberately left business roles to "the modules that define what
they may do". The workflow is that module, so `regional_officer`,
`regional_manager`, `secretary` and `president` arrive with 0010 — with no
permissions. What each may do is granted by the milestone that builds it.
`member` arrives with 0085 and stays without permissions for good: it is the
role the member app acts in, for the approval matrix to name, not a role a
person holds.
