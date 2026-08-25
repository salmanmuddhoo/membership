# Product backlog — Phase 1

Decomposition of the Functional Requirements Document into epics, features and
user stories, per FRD Section 28. Sequencing follows the milestones in the
Phase 1 delivery plan.

- **Source of truth for requirements:** FRD v1.0
- **Source of truth for architecture:** [`adr/0001-azure-native-backend.md`](adr/0001-azure-native-backend.md)
- **Business decisions applied:** the fifteen confirmed on 23 August 2026

## How this backlog is elaborated

Stories for **M1–M3** carry full Given/When/Then acceptance criteria, because
those are the next things to be built. Stories for **M4–M10** are listed with
enough definition to sequence and estimate, and are refined in full at the
start of the milestone that contains them.

This is deliberate. Writing detailed criteria now for work that begins months
from now produces detail that is out of date before anyone reads it — several
of the open business values (minor MSA deposit, processing fee, nominee rules,
dormancy reactivation) land in exactly those later milestones and would rewrite
the criteria when they arrive.

## Scales

**Priority** — FRD Section 21.

| Level  | Meaning                       |
| ------ | ----------------------------- |
| Must   | Required for Phase 1 go-live  |
| Should | Important, can follow the MVP |
| Could  | Enhancement                   |
| Future | A later phase                 |

**Estimate** — Fibonacci story points, relative. Indicative until the team
calibrates on the first sprint; they are for sequencing, not for dates.

| Points | Rough shape                                                 |
| ------ | ----------------------------------------------------------- |
| 1–2    | Well understood, single component                           |
| 3–5    | Multiple components or non-trivial rules                    |
| 8      | Substantial; consider splitting                             |
| 13     | Too large — must be split before it is pulled into a sprint |

## Definition of Ready

A story may be pulled into a sprint when: the acceptance criteria are written
and agreed; its dependencies are resolved or explicitly stubbed; the
permissions it requires are known; any configuration it reads exists; and the
business values it needs are confirmed or a default is agreed.

## Definition of Done

FRD Section 23, plus this project's specifics. A story is done when:

- Acceptance criteria pass.
- Permissions are enforced on every new route and endpoint.
- An audit entry is written for every change to member, document, approval,
  configuration or payment data.
- The API surface is implemented and reflected in the OpenAPI document where
  the story exposes one.
- Validation and error handling cover the failure paths, not only the happy
  path.
- Type-check, formatting, build and the security audit all pass.
- Documentation is updated where behaviour changed.

## Epic index

| Epic    | Title                     | Milestone      | Priority |
| ------- | ------------------------- | -------------- | -------- |
| EPIC-01 | Authentication & Security | M1             | Must     |
| EPIC-02 | User & Role Management    | M2             | Must     |
| EPIC-03 | System Configuration      | M2             | Must     |
| EPIC-04 | Membership Application    | M3 → M6        | Must     |
| EPIC-05 | Document Management       | M4             | Must     |
| EPIC-06 | Approval Workflow         | M3             | Must     |
| EPIC-07 | Member Management         | M3 → M6 → M8   | Must     |
| EPIC-08 | Account Management        | M3             | Must     |
| EPIC-09 | Fees, Payments & Receipts | M5             | Must     |
| EPIC-10 | Notifications             | M9             | Must     |
| EPIC-11 | Audit & Compliance        | M1, continuous | Must     |
| EPIC-12 | Reporting                 | M9             | Should   |
| EPIC-13 | API Platform              | M1 → M9        | Must     |
| EPIC-14 | Legacy Data Migration     | M7             | Must     |
| EPIC-15 | Resignation & Dormancy    | M8             | Must     |
| EPIC-16 | DevSecOps Security Gate   | M0 ✅          | Must     |

---

# M1 — Data platform & cross-cutting core

**Goal:** a signed-in officer is resolved against the database, permissions are
enforced, and every action is audited.
**Blocked by:** the PostgreSQL instance being provisioned.

## Feature 1.1 — Database foundation

### S-101 · Serverless-safe database connectivity

**As** the platform, **I need** pooled PostgreSQL connections, **so that**
serverless request handlers never exhaust the server's connection limit.
`Must · 5 · EPIC-13`

- **Given** the app runs as serverless functions
  **When** concurrent requests each need the database
  **Then** connections are drawn from a pool and never exceed the configured limit
- **Given** the database is unreachable
  **When** a request needs data
  **Then** the request fails with a safe, non-technical error and the cause is logged server-side
- **Given** an environment has no database configured
  **When** the app starts
  **Then** it fails with a clear configuration message, not an obscure driver error

### S-102 · Migrations applied by the pipeline

**As** a developer, **I need** schema migrations applied automatically per
environment, **so that** no one applies schema changes by hand.
`Must · 5 · EPIC-13`

- **Given** a migration is merged to `main`
  **When** the pipeline runs
  **Then** it is applied to the test database and recorded as applied
- **Given** a migration has already been applied
  **When** the pipeline runs again
  **Then** it is skipped and the run succeeds
- **Given** a migration fails
  **Then** the run fails loudly, and the database is left in its prior state

### S-103 · Baseline schema — identity and access

**As** the platform, **I need** tables for users, roles and permissions,
**so that** access can be resolved from data rather than code.
`Must · 5 · EPIC-01`

- Users carry a stable internal id and the external Entra subject identifier
- A user may hold multiple roles; a role holds many permissions
- Users can be active or deactivated without deletion
- **Given** a user is deactivated **When** they sign in **Then** access is refused

### S-104 · Baseline schema — configuration

**As** an administrator, **I need** configuration stored as data,
**so that** business values change without a release (AD-05).
`Must · 3 · EPIC-03`

- Configuration entries are typed, versioned, and carry who changed them and when
- **Given** a value is changed **Then** the previous value remains readable in history

### S-105 · Baseline schema — append-only audit log

**As** an auditor, **I need** an immutable audit trail, **so that** actions can
be reconstructed (FRD Section 10).
`Must · 5 · EPIC-11`

- Records actor, timestamp, action, entity type, record id, previous and new values
- **Given** any attempt to update or delete an audit row **Then** the database refuses it
- **Given** a business change is rolled back **Then** no orphaned audit row remains

## Feature 1.2 — Identity and access at runtime

### S-106 · Bind the signed-in principal to an application user

**As** the platform, **I need** the Entra principal resolved to a user record,
**so that** permissions and audit have a subject.
`Must · 5 · EPIC-01`

- **Given** a valid session whose subject matches a user **Then** that user is attached to the request
- **Given** a valid session with no matching user **Then** access is refused and the attempt is logged
- **Given** no session **Then** the existing redirect to `/login` is unchanged

### S-107 · Resolve permissions per request

**As** the platform, **I need** the effective permission set on each request,
**so that** authorisation decisions are consistent across pages and API.
`Must · 3 · EPIC-01`

- Effective permissions are the union of all the user's active roles
- **Given** a role changes **When** the user's next request arrives **Then** the new permissions apply

### S-108 · Deny by default

**As** a security reviewer, **I need** unlisted actions denied,
**so that** a forgotten check fails closed rather than open.
`Must · 3 · EPIC-01`

- **Given** a route or endpoint declares no required permission **Then** it is denied to everyone but a system administrator
- **Given** a user lacks the required permission **Then** the response is a refusal, and it is audited

## Feature 1.3 — API foundation

### S-109 · Versioned API skeleton

**As** a future client (website, mobile), **I need** a stable versioned API,
**so that** integrations do not break when the app evolves (AD-03).
`Must · 5 · EPIC-13`

- All endpoints live under `/api/v1`
- Errors share one envelope: a stable code, a safe message, and a correlation id
- **Given** an unhandled error **Then** no stack trace or internal detail reaches the client

### S-110 · OpenAPI document

**As** an integrator, **I need** generated API documentation,
**so that** the contract is discoverable and current.
`Must · 5 · EPIC-13`

- The document is generated from the routes, not maintained by hand
- **Given** an endpoint is added without documentation **Then** the build reports it

### S-111 · Request logging and rate limiting

**As** an operator, **I need** API requests logged and abusive callers slowed,
**so that** the public surface cannot be trivially hammered.
`Should · 3 · EPIC-13`

## Feature 1.4 — Platform constraint proofs

### S-112 · Spike — brokered file upload within platform limits

**As** the team, **I need** proof that a tablet-sized photograph can be
uploaded, **so that** M4 is not designed against a limit we discover late.
`Must · 5 · EPIC-05`

- Demonstrates a file larger than the serverless request limit reaching storage
- The client never receives storage credentials (AD-09)
- Produces a short written recommendation for M4

### S-113 · Spike — scheduled and long-running jobs

**As** the team, **I need** proof of a scheduled job and a chunked long task,
**so that** dormancy (M8) and migration (M7) have a known-good mechanism.
`Must · 3 · EPIC-15`

---

# M2 — Administration & configuration

**Goal:** an administrator can change the entrance fee, add an account type,
alter a checklist and enable an optional workflow step — all without a release.

## Feature 2.1 — Users, roles and permissions

### S-201 · Manage roles and their permissions

**As** a System Administrator, **I need** to create roles and grant
permissions, **so that** the operating model is expressed in the system.
`Must · 5 · EPIC-02`

- Covers every role in FRD Section 6, including Regional Manager, Director and Treasurer
- **Given** a permission is removed from a role **Then** holders lose that capability on their next request
- **Given** a role is in use **When** deletion is attempted **Then** it is refused with an explanation

### S-202 · Assign roles to users

**As** a System Administrator, **I need** to assign one or more roles,
**so that** a Regional Officer can also cover Clerk duties (FRD 6.1).
`Must · 3 · EPIC-02`

### S-203 · Segregation of duties

**As** a compliance owner, **I need** conflicting actions prevented,
**so that** the officer who captures an application cannot approve it.
`Must · 5 · EPIC-02`

- **Given** a user captured an application **When** they attempt to review or approve it **Then** the action is refused and audited
- Conflicting pairs are configuration, not hard-coded
- **Given** a user holds both roles **Then** the block applies per record, not to the role itself

### S-204 · Deactivate a user

**As** a System Administrator, **I need** to deactivate a leaver,
**so that** access ends without losing their history.
`Must · 2 · EPIC-02`

## Feature 2.2 — Reference configuration

### S-205 · Membership types and their field rules

**As** an administrator, **I need** Individual and Corporate configured,
**so that** the application form adapts without code (FRD Section 5).
`Must · 5 · EPIC-03`

- Per type: which fields appear, which are mandatory, which checklist and fee schedule apply

### S-206 · Account types and the default product

**As** an administrator, **I need** account types configured,
**so that** the default MSA can change and new products need no release.
`Must · 5 · EPIC-03`

- Name, code, category, minimum opening amount, required documents, whether approval is needed, default status
- Exactly one type is marked the membership default
- **Given** the default is changed **Then** subsequent approvals open the new type

### S-207 · Fee schedules

**As** a Treasurer, **I need** fee components configured per membership and
account type, **so that** amounts change by configuration (FRD 7.8.1).
`Must · 5 · EPIC-03`

- Components: Entrance, Takaful, Shares, MSA Deposit, Processing
- Each may be required, optional or not applicable — covering the unconfirmed minor MSA deposit and processing fee
- **Given** the entrance fee is changed **Then** new applications use the new amount and existing receipts are untouched

### S-208 · Document types and dynamic checklists

**As** an administrator, **I need** checklists driven by applicant type,
**so that** requirements adapt without code (FRD 8.4.1).
`Must · 5 · EPIC-03`

- Per applicant type and per subject (applicant, nominee, guardian, beneficiary)
- Documents can be required or optional, and can carry an expiry

### S-209 · Workflow definitions

**As** an administrator, **I need** approval steps configured,
**so that** the confirmed chain runs and optional steps can be enabled later.
`Must · 8 · EPIC-06`

- Ships with the confirmed chain: Staff → Secretary → President
- Regional Manager review exists as a step, disabled by default (decision 2)
- Steps are assigned to a **role**; any holder may act (decision 4)
- An optional quorum count is supported but not enabled
- Statuses are configuration, so Abeyance can be added later (decision 8)

### S-210 · Configuration changes are audited

**As** an auditor, **I need** every configuration change recorded,
**so that** a change in fees or workflow is traceable.
`Must · 3 · EPIC-11`

---

# M3 — Walking skeleton: application to member

**Goal:** capture an Individual application, take it through Secretary and
President, and see a Member and their MSA account created.

## Feature 3.1 — Application capture

### S-301 · Create a draft Individual application

**As** a Regional Officer, **I need** to capture an applicant's details,
**so that** the application exists in the system. _(FRD MEM-US-001)_
`Must · 8 · EPIC-04`

- Fields render from the membership type configuration (S-205)
- **Given** required fields are missing **When** submission is attempted **Then** each is identified and nothing is submitted
- **Given** a mobile number is entered **Then** it is stored in full international form, `+230…` — required for the WhatsApp notification in M9 and impossible to backfill reliably later

### S-302 · Save as draft continuously

**As** a Regional Officer working on a tablet, **I need** my work saved as I
go, **so that** a dropped connection loses nothing (decision 14).
`Must · 5 · EPIC-04`

- **Given** the browser is closed mid-capture **When** the officer returns **Then** the draft is intact

### S-303 · Unique application reference

**As** staff, **I need** a unique reference per application, **so that** it can
be quoted and traced.
`Must · 2 · EPIC-04`

## Feature 3.2 — Submission and approval

### S-304 · Submit for central processing

**As** a Regional Officer, **I need** to submit a completed application,
**so that** it enters review with status New. _(FRD MEM-US-006)_
`Must · 5 · EPIC-06`

- **Given** the application is submitted **Then** status becomes New and it is locked from regional edits
- **Given** it is locked **When** the originating officer edits it **Then** the attempt is refused

### S-305 · Secretary review

**As** the Secretary, **I need** to review and either forward or return an
application, **so that** only complete ones reach the President. _(WF-US-001)_
`Must · 5 · EPIC-06`

- Forward → status Submit for Approval; return → back to staff with a mandatory comment
- **Given** the reviewer captured the application **Then** the action is refused (S-203)

### S-306 · President decision

**As** the President, **I need** to approve or reject, **so that** only
approved applicants become members. _(WF-US-002)_
`Must · 5 · EPIC-06`

- **Given** approval **Then** status becomes Approved and member creation is triggered
- **Given** rejection **Then** a comment is mandatory, status becomes Rejected, and it returns to the originating staff

### S-307 · Status history

**As** an auditor, **I need** every transition recorded with actor, timestamp
and comment, **so that** the approval chain is reconstructable.
`Must · 3 · EPIC-11`

## Feature 3.3 — Member and account creation

### S-308 · Create the Member record on approval

**As** the system, **I need** to create a Member with a unique Member ID,
**so that** an approved applicant becomes a member. _(FRD 7.5)_
`Must · 5 · EPIC-07`

- Format `ABM-000001`, unique for the lifetime of the system
- **Given** creation fails part-way **Then** nothing is half-created and the failure is visible

### S-309 · Auto-create the default MSA account

**As** the system, **I need** the default account opened automatically,
**so that** no one opens it by hand. _(ACC-US-002, decision 1)_
`Must · 5 · EPIC-08`

- The product is whichever type is configured as default (S-206)
- **Given** approval **Then** exactly one MSA is created, linked to the member, and audited

### S-310 · Member profile view

**As** staff, **I need** to view a member and their accounts,
**so that** the created record can be confirmed and used.
`Must · 5 · EPIC-07`

---

# M4–M10 — outline

Listed for sequencing and estimation. Acceptance criteria are written at the
start of each milestone, when the relevant business values are confirmed.

## M4 — Documents, print–scan–upload, SharePoint · EPIC-05

| ID    | Story                                                          | Pri    | Pts |
| ----- | -------------------------------------------------------------- | ------ | --- |
| S-401 | Generate the pre-filled printable application form             | Must   | 8   |
| S-402 | Archive the exact signed PDF rather than re-rendering (AD-10)  | Must   | 5   |
| S-403 | Capture a document with the tablet camera _(DOC-US-001)_       | Must   | 8   |
| S-404 | Upload an existing scanned file _(DOC-US-002)_                 | Must   | 3   |
| S-405 | Create the member's SharePoint folder structure _(DOC-US-004)_ | Must   | 5   |
| S-406 | Store document metadata in the platform (FRD 8.3)              | Must   | 5   |
| S-407 | Drive the checklist from Missing to Verified _(DOC-US-003)_    | Must   | 5   |
| S-408 | Never mark a failed upload as uploaded; retry safely           | Must   | 5   |
| S-409 | Replace a document, preserving version history                 | Should | 3   |
| S-410 | Document expiry and reminders                                  | Should | 3   |

## M5 — Fees, payments & receipts · EPIC-09

| ID    | Story                                                                                | Pri    | Pts |
| ----- | ------------------------------------------------------------------------------------ | ------ | --- |
| S-501 | Record a payment against an application by fee component _(MEM-US-005)_              | Must   | 8   |
| S-502 | Allocate sequential receipt numbers so gaps stay visible (AD-11) _(PAY-US-001)_      | Must   | 8   |
| S-503 | Produce a printable/exportable receipt                                               | Must   | 5   |
| S-504 | Emit a structured financial event per payment (AD-06)                                | Must   | 5   |
| S-505 | Refund against the original receipt when an application is not approved (FRD 7.10.7) | Must   | 5   |
| S-506 | Receipt reconciliation view with gap and duplicate exceptions                        | Must   | 5   |
| S-507 | Processing fee as a separately reportable component (decision 5)                     | Should | 3   |

## M6 — Full membership depth · EPIC-04, EPIC-07

| ID    | Story                                                                                        | Pri   | Pts |
| ----- | -------------------------------------------------------------------------------------------- | ----- | --- |
| S-601 | Corporate application capture (FRD 5.2)                                                      | Must  | 8   |
| S-602 | Nominee capture with configurable count and optional percentages (decision 7) _(MEM-US-008)_ | Must  | 8   |
| S-603 | Two attesting witnesses verified before the Secretary may verify                             | Must  | 3   |
| S-604 | Minor application with a validated Guardian member link _(MEM-US-007)_                       | Must  | 8   |
| S-605 | Block submission without a valid Guardian (FRD 7.10.2)                                       | Must  | 3   |
| S-606 | Successor Guardian nomination (FRD 7.10.3)                                                   | Must  | 5   |
| S-607 | Takaful Ta'awuni beneficiary nomination (FRD 7.10.4)                                         | Must  | 5   |
| S-608 | Pre-Board completeness gate (FRD 7.10.8)                                                     | Must  | 5   |
| S-609 | Board decision record with sign-offs (FRD 7.10.9, decision 4)                                | Must  | 5   |
| S-610 | Minor reaching majority — configurable transition                                            | Could | 5   |

## M7 — Legacy migration · EPIC-14

Phase-wise per your direction: **members first, finance later**. Source data is
cleansed by Al Barakah before import; see the legacy register analysis for the
five blockers and the field gaps.

| ID    | Story                                                          | Pri  | Pts |
| ----- | -------------------------------------------------------------- | ---- | --- |
| S-701 | Agree and freeze the cleansed source extract                   | Must | 3   |
| S-702 | Column mapping and validation rules for members                | Must | 8   |
| S-703 | Staging import with dry-run _(MIG-US-001)_                     | Must | 8   |
| S-704 | Exception report for records failing validation                | Must | 5   |
| S-705 | Preserve legacy member code as a cross-reference               | Must | 3   |
| S-706 | Mark migrated members as a distinct state (incomplete records) | Must | 5   |
| S-707 | Promote to production after business sign-off (decision 3)     | Must | 3   |
| S-708 | Log the import as a traceable audit event (FRD 7.12)           | Must | 3   |
| S-709 | Later pass — shares, savings, Haj and loan balances            | Must | 8   |
| S-710 | Reconcile imported totals against the agreed control figures   | Must | 5   |

## M8 — Resignation & dormancy · EPIC-15

| ID    | Story                                                              | Pri    | Pts |
| ----- | ------------------------------------------------------------------ | ------ | --- |
| S-801 | Capture a resignation request with reason _(RES-US-001)_           | Must   | 5   |
| S-802 | Obligation checks that block closure                               | Must   | 5   |
| S-803 | Secretary review and President approval of resignation             | Must   | 5   |
| S-804 | Scheduled dormancy detection on the confirmed rule _(DOR-US-001)_  | Must   | 8   |
| S-805 | Configurable reactivation, defaulting to staff action (decision 6) | Must   | 5   |
| S-806 | Approaching-dormancy report                                        | Should | 3   |

## M9 — Notifications, reporting & public API · EPIC-10, 12, 13

| ID    | Story                                                                  | Pri    | Pts |
| ----- | ---------------------------------------------------------------------- | ------ | --- |
| S-901 | Provider-independent notification service with templates (decision 11) | Must   | 8   |
| S-902 | Email channel for the events in FRD Section 9                          | Must   | 5   |
| S-903 | WhatsApp channel — membership approved (decision 11)                   | Must   | 8   |
| S-904 | Notification delivery log and retry                                    | Must   | 3   |
| S-905 | Membership, document and account reports                               | Should | 8   |
| S-906 | Payments, receipts and dormancy reports                                | Should | 5   |
| S-907 | Operations and audit reports                                           | Should | 5   |
| S-908 | Public application API for Albarakah.mu _(MEM-US-002)_                 | Must   | 8   |
| S-909 | API credentials, throttling and abuse protection                       | Must   | 5   |

## M10 — Hardening, UAT & go-live

| ID     | Story                                                 | Pri  | Pts |
| ------ | ----------------------------------------------------- | ---- | --- |
| S-1001 | Independent security review or penetration test       | Must | 8   |
| S-1002 | Performance check under regional-office conditions    | Must | 5   |
| S-1003 | Backup and restore rehearsal                          | Must | 5   |
| S-1004 | Provision real staff accounts and roles (decision 15) | Must | 3   |
| S-1005 | Staff training and user documentation                 | Must | 8   |
| S-1006 | Production cutover with a rollback plan               | Must | 5   |

---

# Traceability

Every user story named in FRD Section 22 is covered.

| FRD story     | Backlog             |
| ------------- | ------------------- |
| MEM-US-001    | S-301               |
| MEM-US-002    | S-908               |
| MEM-US-003    | S-401               |
| MEM-US-004    | S-403, S-404, S-407 |
| MEM-US-005    | S-501, S-502        |
| MEM-US-006    | S-304               |
| MEM-US-007    | S-604, S-605        |
| MEM-US-008    | S-602, S-603        |
| WF-US-001     | S-305               |
| WF-US-002     | S-306               |
| ACC-US-001    | S-206, S-207        |
| ACC-US-002    | S-309               |
| DOC-US-001    | S-403               |
| DOC-US-002    | S-404               |
| DOC-US-003    | S-407               |
| DOC-US-004    | S-405               |
| RES-US-001    | S-801, S-802, S-803 |
| DOR-US-001    | S-804               |
| MIG-US-001    | S-703, S-704        |
| PAY-US-001    | S-502               |
| DEVSEC-US-001 | M0 — delivered      |

# Open values that later stories depend on

Each is absorbed by configuration, so none blocks the start of development.
They must be confirmed before the milestone that consumes them.

| Value                                          | Needed by    | Default if unconfirmed         |
| ---------------------------------------------- | ------------ | ------------------------------ |
| Minor MSA deposit                              | M5 · S-501   | Not required                   |
| Processing fee amount and applicability        | M5 · S-507   | Zero / not applicable          |
| Nominee count and percentage rules             | M6 · S-602   | Single nominee, no percentages |
| Dormant reactivation rule                      | M8 · S-805   | Flag for staff action          |
| KYC and audit retention periods                | M10          | Retain indefinitely            |
| Whether Abeyance and Manager review are wanted | Post-go-live | Available but disabled         |
