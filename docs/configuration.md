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

### Account types (S-206, FRD 7.6)

`account_type`. Exactly one row is `is_membership_default` — the product a
membership approval opens, the MSA today. A partial unique index allows only
one, and the service refuses to deactivate whichever one it is. Changing the
default affects approvals from that moment on; accounts already opened are
untouched.

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

## Permissions

| Permission      | Grants                                              |
| --------------- | --------------------------------------------------- |
| `config.view`   | Read every configuration page and the reference API |
| `config.manage` | Change any of it                                    |
| `fee.manage`    | Publish fee versions                                |

`/admin/configuration/` is guarded by `config.view` as a prefix rule, so a
section added later is covered without touching the route map. Each page then
checks `config.manage` itself before it will write: seeing what the fees are is
a different thing from setting them.

`fee.manage` is held by the System Administrator for now. S-207 names the
Treasurer as its owner, and that role gains it in the milestone that gives the
Treasurer a workload.

## Roles seeded here

Migration 0006 deliberately left business roles to "the modules that define what
they may do". The workflow is that module, so `regional_officer`,
`regional_manager`, `secretary` and `president` arrive with 0010 — with no
permissions. What each may do is granted by the milestone that builds it.
