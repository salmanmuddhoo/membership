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
| EPIC-14 | Legacy Data Migration     | M7 ✅          | Must     |
| EPIC-15 | Resignation & Dormancy    | M8 → M17       | Must     |
| EPIC-16 | DevSecOps Security Gate   | M0 ✅          | Must     |

---

# M1 — Data platform & cross-cutting core ✅

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

# M2 — Administration & configuration ✅

**Goal:** an administrator can change the entrance fee, add an account type,
alter a checklist and enable an optional workflow step — all without a release.

## Feature 2.1 — Users, roles and permissions ✅

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

## Feature 2.2 — Reference configuration ✅

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

# M3 — Walking skeleton: application to member ✅

**Goal:** capture an Individual application, take it through Secretary and
President, and see a Member and their MSA account created.

## Feature 3.1 — Application capture ✅

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

## Feature 3.2 — Submission and approval ✅

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

## Feature 3.3 — Member and account creation ✅

### S-308 · Create the Member record on approval

**As** the system, **I need** to create a Member with a unique Member ID,
**so that** an approved applicant becomes a member. _(FRD 7.5)_
`Must · 5 · EPIC-07`

- Format `AB0001`, unique for the lifetime of the system — the Society's own
  format, and the number both of the member's accounts carry
- **Given** creation fails part-way **Then** nothing is half-created and the failure is visible

### S-309 · Auto-create the member's accounts

**As** the system, **I need** the member's accounts opened automatically,
**so that** no one opens them by hand. _(ACC-US-002, decision 1)_
`Must · 5 · EPIC-08`

- A membership opens **two** accounts: Shares, which is what makes someone a
  member, and an MSA beside it. Both carry the member's number
- Which types open is configuration, read at approval time (S-206), so a
  further product can be added without a release
- **Given** approval **Then** exactly one account of each configured type is
  created, linked to the member, and audited

### S-310 · Member profile view

**As** staff, **I need** to view a member and their accounts,
**so that** the created record can be confirmed and used.
`Must · 5 · EPIC-07`

---

# M4 — Documents, print–scan–upload, SharePoint ✅

**Goal:** an application's documents are captured, stored in SharePoint, and
driven from Missing to Verified — with the signed physical form archived
exactly as it was signed.

**Blocked by:** nothing. The brokered upload was proved in M1 (S-112); the
checklists it drives were configured in M2 (S-208).

**Outstanding outside the repository:** the Microsoft 365 app registration.
Uploads answer 503 with a readable message until `GRAPH_*` is configured, and
the document-expiry job needs a schedule (`docs/jobs.md`).

## Feature 4.1 — The printable form

### S-401 · Generate the pre-filled printable application form

**As** a Regional Officer, **I need** a printable form filled in from what I
captured, **so that** the applicant signs a document that already matches the
record. _(FRD 8.5)_
`Must · 8 · EPIC-05`

- Renders from the membership type's field configuration, so a field an
  administrator adds appears on the printed form without a release
- Carries the Declaration and the four signature blocks: applicant, nominee,
  witness 1, witness 2 (FRD 5.4)
- **Given** the application is still a draft **Then** the form is watermarked
  as a draft, so an unsigned print cannot be mistaken for the real one
- **Given** a field is empty **Then** the space is printed blank rather than
  omitted, so the applicant can complete it by hand

### S-402 · Archive the signed PDF rather than re-rendering it

**As** an auditor, **I need** the exact file that was signed, **so that** what
we hold is what the applicant agreed to. _(AD-10)_
`Must · 5 · EPIC-05`

- The uploaded scan is stored byte-for-byte and never regenerated
- **Given** the captured data changes after signing **Then** the archived scan
  is untouched and the difference is visible
- A checksum is recorded at upload and can be re-verified later

## Feature 4.2 — Capture

### S-403 · Capture a document with the tablet camera

**As** a Regional Officer at a regional office, **I need** to photograph a
document, **so that** capture needs no scanner. _(DOC-US-001, FRD 8.6)_
`Must · 8 · EPIC-05`

- Multi-page capture assembled into one document
- **Given** the connection drops mid-upload **Then** the upload resumes rather
  than restarting, using the brokered upload session proved in M1
- **Given** the photograph is unreadable **Then** it can be retaken before it
  is committed to the record

### S-404 · Upload an existing scanned file

**As** staff, **I need** to upload a file from the device, **so that** a
document already scanned does not have to be photographed again. _(DOC-US-002)_
`Must · 3 · EPIC-05`

- Accepts PDF and common image types; rejects anything else with a reason
- **Given** the file exceeds the platform's request limit **Then** it still
  uploads, because the browser sends it to Microsoft directly

## Feature 4.3 — SharePoint and metadata

### S-405 · Create the member's SharePoint folder structure

**As** the system, **I need** the folder structure created automatically,
**so that** documents land where the Society expects them. _(DOC-US-004, FRD 8.1, 8.2)_
`Must · 5 · EPIC-05`

- Follows the standard structure of FRD 8.1, created on demand rather than in
  advance
- **Given** the folder already exists **Then** creation is a no-op, so a retry
  cannot produce a duplicate
- **Given** SharePoint is unavailable **Then** the failure is explicit and the
  document is not recorded as stored

### S-406 · Store document metadata in the platform

**As** staff, **I need** each document's details held in the platform, **so
that** documents are searchable without opening SharePoint. _(FRD 8.3)_
`Must · 5 · EPIC-05`

- Type, subject, uploader, timestamp, verification state, expiry, checksum and
  the SharePoint location
- **Given** a document is moved in SharePoint **Then** the stored location can
  be repaired without losing its history

### S-407 · Drive the checklist from Missing to Verified

**As** the Secretary, **I need** to see and change each document's state,
**so that** completeness is a fact rather than a judgement. _(DOC-US-003, FRD 8.4)_
`Must · 5 · EPIC-05`

- States: Missing, Uploaded, Under Review, Verified, Rejected, Expired
- The checklist is the one configured for the applicant type in M2 (S-208)
- **Given** a document is rejected **Then** a reason is mandatory and the
  applicant's staff can see it
- **Given** every required document is Verified **Then** the application
  reports as document-complete; nothing else may assert that

### S-408 · Never mark a failed upload as uploaded

**As** staff, **I need** a failed upload to say so, **so that** nobody relies
on a document that is not there.
`Must · 5 · EPIC-05`

- The checklist item advances only after SharePoint confirms the commit
- **Given** the upload fails at any point **Then** the item stays Missing and
  the error is shown
- **Given** the same document is retried **Then** it does not create a second
  copy

## Feature 4.4 — Lifecycle

### S-409 · Replace a document, preserving version history

**As** staff, **I need** to replace a document, **so that** a better scan can
supersede a poor one without losing the original. _(FRD 8.8)_
`Should · 3 · EPIC-05`

- The previous version stays retrievable and is marked superseded
- **Given** a document was Verified **When** it is replaced **Then** it returns
  to Under Review, because the verification was of the old file

### S-410 · Document expiry and reminders

**As** the Secretary, **I need** expiring documents flagged, **so that** a
member's file does not quietly go stale. _(FRD 8.4)_
`Should · 3 · EPIC-05`

- Applies only to document types configured to track expiry (S-208)
- **Given** a document passes its expiry **Then** its state becomes Expired and
  the checklist is no longer complete
- Detection runs as a scheduled job, on the runner proved in M1 (S-113)

---

# M5 — Fees, payments & receipts ✅

**Goal:** what an applicant pays is recorded against a sequential receipt, and
a gap in that sequence is visible.

**How it works:** `docs/payments.md`. The one decision worth reading is why a
receipt number is a committed row rather than a `nextval()`.

**Still unconfirmed, and shipped as configuration:** the minor MSA deposit
(S-501) is configured not applicable, and the processing fee (S-507) is
configured zero and not applicable. Both are a fee-version change away from
being switched on — no release, no migration — so neither held the milestone
up. Neither can be charged until someone publishes an amount, which is the
correct behaviour for a figure nobody has confirmed.

### S-501 · Record a payment against an application by fee component

**As** a Regional Officer, **I need** to record what was paid, itemised,
**so that** the receipt matches the fee schedule. _(MEM-US-005, FRD 7.8.1)_
`Must · 8 · EPIC-09`

- Components and amounts come from the fee schedule version in force (S-207)
- The version charged is recorded against the payment, so a later fee change
  cannot alter what this applicant paid
- **Given** a component is configured not applicable **Then** it cannot be paid
- **Given** the amount tendered does not match the schedule **Then** the
  difference is stated and must be acknowledged before recording

### S-502 · Allocate sequential receipt numbers so gaps stay visible

**As** the Treasurer, **I need** receipt numbers with no reuse and no silent
gaps, **so that** the sequence is evidence. _(PAY-US-001, AD-11, FRD 7.8.2)_
`Must · 8 · EPIC-09`

- Allocation is not a bare sequence: a rolled-back transaction must leave a
  visible gap rather than consuming a number invisibly
- **Given** a number is allocated **Then** it can never be reused, including
  after a failure
- **Given** a gap exists **Then** it is reportable with the reason, if known

### S-503 · Produce a printable receipt

**As** a Regional Officer, **I need** a receipt to hand over, **so that** the
applicant has proof of payment. _(FRD 7.8.2)_
`Must · 5 · EPIC-09`

- Carries receipt number, member or applicant reference, components, amounts,
  currency, date, method and the staff member who processed it
- **Given** the receipt is reprinted **Then** it is identifiably a reprint

### S-504 · Emit a structured financial event per payment

**As** the future accounting integration, **I need** each payment as a
structured event, **so that** Phase 3 can consume it without re-deriving it.
_(AD-06)_
`Must · 5 · EPIC-09`

- Append-only, with the fee version, components and receipt number
- **Given** a payment is refunded **Then** a compensating event is emitted; the
  original is never edited

### S-505 · Refund against the original receipt when an application is not approved

**As** the Treasurer, **I need** to refund a rejected applicant, **so that**
the Society keeps only what it is due. _(FRD 7.10.7)_
`Must · 5 · EPIC-09`

- Refund references the original receipt and its components
- **Given** the application was approved **Then** the entrance fee and Takaful
  contribution are non-refundable, per FRD 7.10.6
- **Given** a partial refund **Then** each component refunded is itemised

### S-506 · Receipt reconciliation view with gap and duplicate exceptions

**As** the Treasurer, **I need** the sequence audited, **so that** an anomaly
is found by the system rather than by an auditor. _(FRD 7.8.2)_
`Must · 5 · EPIC-09`

- Lists gaps, duplicates and voided receipts for a period
- **Given** no exceptions **Then** the view says so explicitly, rather than
  showing an empty table that could mean either thing

### S-507 · Processing fee as a separately reportable component

**As** the Treasurer, **I need** the processing fee reported separately,
**so that** it reconciles apart from the other components. _(decision 5, FRD 7.8.3)_
`Should · 3 · EPIC-09`

- Uses the same receipt mechanism with its own component code
- **Depends on** the confirmed amount and applicability. Default until then:
  configured, zero, not applicable — which is what M2 already ships

---

# M6 — Full membership depth ✅

**Goal:** Corporate and Minor applications work end to end, with nominees,
witnesses, guardians and the board decision the FRD describes.

**Done:** S-601 to S-611 — Corporate capture, configurable nominee count and
percentage splits, the four-signature verification gate, the Guardian link
(searchable, and findable before the parent is even a member), the successor
guardian/beneficiary subjects, the pre-Board completeness gate, the Board
quorum sign-off, the minor-majority transition, and Regional oversight
actually gating the chain once enabled, all the way through to an approved
member. Every M6 story is built.

### S-601 · Corporate application capture ✅

**As** a Regional Officer, **I need** to capture a corporate applicant,
**so that** entities can join. _(FRD 5.2)_
`Must · 8 · EPIC-04`

- Fields come from the Corporate membership type configured in M2
- **Given** the corporate checklist **Then** a Certificate of Registration,
  Memorandum and Written Resolution are required, and no ID card is

Already built by the config-driven capture pipeline (M2/M3): the Corporate
fields, checklist and fee schedule were seeded in migration 0010, and nothing
in `capture.ts` knows a membership type by name. Confirmed end to end —
capture through an approved member, with the right documents asked for and
none extra — in `workflow.test.ts`'s "S-601: a Corporate application, end to
end".

### S-602 · Nominee capture with configurable count and optional percentages ✅

**As** a Regional Officer, **I need** to capture the nominees the rules allow,
**so that** the nomination is valid. _(MEM-US-008, decision 7, FRD 5.3)_
`Must · 8 · EPIC-04`

- Count is configuration; the schema already supports several (S-301)
- **Given** percentages are enabled **Then** they must total 100 before
  submission
- **Depends on** the confirmed count and percentage rule

New `membership_type.nominee_count` (migration 0021, default 1, 1–10),
changed from **Membership types** admin without a release. `insertApplication`
creates that many `nominee` rows; `problemsBlockingSubmission` loops over
every row for a subject, so a type with several nominees configured gets a
set of missing-field checks per row, each naming its own nominee.

**Only the first nominee is mandatory, relaxed on officer feedback.** "One
or more Nominees where configured" is _at least_ one, not every slot a type
allows — `problemsBlockingSubmission` and `CaptureFields.astro` both skip
mandatory-field enforcement past ordinal 1, so a second or third nominee may
be left blank without blocking submission; the form marks them "(optional)"
instead of the usual red asterisk. Percentages need no flag of their own: a
type that adds a mandatory `percentage` field to the nominee subject gets
its split totalled at submission — refused unless it comes to exactly 100 —
but only once every _mandatory_ nominee has entered a value, so an optional
nominee left blank altogether never enters the total. See
`docs/applications.md`.

### S-603 · Two attesting witnesses verified before the Secretary may verify ✅

**As** the Secretary, **I need** both witnesses present on the scan, **so
that** the nomination is legally valid. _(FRD 5.4)_
`Must · 3 · EPIC-04`

- **Given** fewer than four signatures are confirmed **Then** the Signed
  Application Form cannot be marked Verified

The printed form's four signature blocks (Applicant, Nominee, Witness 1,
Witness 2 — `SIGNATURES`, shared between `print.astro` and `documents.ts`)
are a fixed, universal check, not something configuration decides.
Reviewing a `signed_form` document shows a checkbox per block;
`reviewDocument` (`documents.ts`) refuses to mark it Verified until all four
are checked, naming which are missing. New `document.confirmed_signatures`
column (migration 0020). See `docs/documents.md`.

### S-604 · Minor application with a validated Guardian member link ✅

**As** a Regional Officer, **I need** to link a minor to their guardian,
**so that** the guardian's responsibility is recorded. _(MEM-US-007, FRD 7.10.2)_
`Must · 8 · EPIC-04`

- The guardian must be an existing active member, found by Member ID or NIC
- **Given** the named guardian is not a member **Then** capture explains that
  they must join first

`problemsBlockingSubmission` (`capture.ts`) resolves the guardian block's
Member No. or NIC against `member`, joined back to whichever application's
applicant party carries that NIC (NIC is not a column on `member` itself).
Not found is a "Needs attention" item on the capture page itself — not only
at submit time. See `docs/applications.md`.

**The guardian does not have to be an approved member yet to be found,
linked, or submitted with.** A parent and their minor can register at the
same visit, the parent first. `GET /api/v1/applications/guardian-search`
searches active members **and** Individual applications still being
captured; picking a result fills in the guardian's surname, name, NIC,
Member No. and mobile the same way typing them would — and, since the
search is the only intended way to fill them, `CaptureFields.astro` renders
those fields read-only. Relationship is read-only too, worked out
automatically from the minor's own gender rather than typed. Submission
itself accepts either kind of match, on officer feedback that requiring the
parent's own approval first forced a second visit for no reason their
status actually changed — what it still refuses is a guardian nobody can
find, a member who is not active, or an application already rejected (a
dead end). See `docs/applications.md`.

### S-605 · Block submission without a valid Guardian ✅

**As** the Society, **I need** a minor's application to be unsubmittable
without a guardian, **so that** the rule cannot be bypassed. _(FRD 7.10.2)_
`Must · 3 · EPIC-04`

- **Given** no valid guardian link **Then** submission is refused and says why

Same check, in the same list `submitApplication` already refuses on. See
`workflow.test.ts`'s "S-604/S-605: a Minor application with a valid
guardian, end to end" for a refusal that becomes a decided member once a
real guardian exists.

### S-606 · Successor Guardian nomination ✅

**As** a Regional Officer, **I need** to record a successor guardian, **so
that** the minor is covered if the guardian cannot act. _(FRD 7.10.3)_
`Must · 5 · EPIC-04`

- Captured as its own subject, with its own checklist items (already
  configured in M2)

Already configured (migration 0010): the successor guardian is the minor
type's own `nominee` subject, distinct from an Individual or Corporate
nominee. Exercised by the same end-to-end test as S-604/S-605.

### S-607 · Takaful Ta'awuni beneficiary nomination ✅

**As** a Regional Officer, **I need** to record the Takaful beneficiary,
**so that** the fund knows who benefits. _(FRD 7.10.4)_
`Must · 5 · EPIC-04`

Already configured (migration 0010): its own `beneficiary` subject on the
Minor type, with its own checklist requirement. Exercised by the same
end-to-end test as S-604/S-605.

### S-608 · Pre-Board completeness gate ✅

**As** the Secretary, **I need** completeness checked before the board sees
it, **so that** board time is not spent on incomplete files. _(FRD 7.10.8)_
`Must · 5 · EPIC-06`

- Documents Verified, payment recorded, guardian valid where applicable
- **Given** anything is outstanding **Then** it is listed and the application
  cannot be forwarded

`boardReadiness` (`workflow.ts`) re-checks the three things submission
cannot guarantee stay true — documents actually Verified (not merely
filed), the payment still live (not voided or refunded since), and a
guardian still resolving the same way submission accepted them — and
`reviewApplication` refuses a `forward` outcome naming every outstanding one
together. Return for correction is untouched. See `docs/applications.md`.

### S-609 · Board decision record with sign-offs ✅

**As** the Board, **I need** the decision recorded with who signed off,
**so that** the approval is attributable. _(FRD 7.10.9, decision 4)_
`Must · 5 · EPIC-06`

- Uses the quorum already supported by the workflow configuration (S-209)
- **Given** a quorum above one **Then** that many distinct role holders must
  act before the step completes

New `application_step_signoff` (migration 0022), append-only like
`application_transition`. At quorum 1 — every step ships this way —
`decideApplication` transitions on a single decision exactly as before this
story. Above 1 it accumulates distinct approvals until quorum is met before
the step actually completes; a single reject vetoes immediately regardless
of quorum or how many approvals are already in, since an attributable
decision is one person's, not a vote nobody can trace. `signoffsFor` reads
who has acted so far; `[id].astro` shows it only when a step's quorum is
actually above 1. See `docs/applications.md`.

### S-610 · Minor reaching majority — configurable transition ✅

**As** an administrator, **I need** the majority transition configured, **so
that** a minor becomes a full member without manual tracking. _(FRD 7.10.10)_
`Could · 5 · EPIC-07`

- Scheduled detection, on the job runner from M1
- **Depends on** what the Society requires at majority — an MSA deposit is an
  open point in FRD 7.10.6

Unblocked once M5 confirmed the minor MSA deposit is not required — nothing
financial changes at majority under that default, so what remained was the
type change itself. New `membership_type.majority_age` and
`majority_transition_type_id` (migration 0023), both null by default —
inert until an administrator sets both from **Membership types**. The
`minor-majority-transition` scheduled job (`transitionMinorsAtMajority`,
`src/lib/members/majority.ts`) reads a member's applicant `date_of_birth`
against their type's configured age and moves them into the configured
type, auditing every move with a null actor and a job-naming description —
the same shape `document-expiry` (S-410) already established. See
`docs/jobs.md`.

### S-611 · Regional oversight actually gates the chain, once enabled ✅

**As** a Regional Manager, **I need** to review an application before it
reaches the Secretary, **so that** regional oversight means something once
switched on. _(FRD 7.4.2, decision 2)_
`Must · 5 · EPIC-06`

- **Given** Regional oversight is enabled **Then** submission reaches the
  Regional Manager first, and the Secretary cannot act until they forward it
- **Given** Regional oversight is disabled **Then** submission reaches the
  Secretary directly, exactly as before it existed
- The Regional Manager, Secretary and President each see how many
  applications are waiting on them, as a live count on the Applications menu

S-209 (M2) shipped `regional_review` as a step present in the chain but
`is_enabled = false` — configuration an administrator could see, with
nothing yet behind it to enforce. Officer feedback asked for the enforcement:
switching the step on with no code following it left "regional oversight" as
a label, not a control.

`regional_review` is a **gate** (`from_status` equals `to_status`, S-209) —
acting on it never moves the record, so nothing about the record's own
status can say whether it has already happened. `assertMayAct`
(`workflow.ts`) answers that by reading `application_transition` instead:
Secretary review refuses until a `regional_review` transition already
exists for the application. Read from the active chain rather than a
hardcoded step pair, so a gate added later needs no new code — disabling
Regional oversight simply drops it out of `activeChain()`, and the check
finds nothing to wait on.

**A shared permission stopped being enough to tell two steps apart.**
`regional_review` and `secretary_review` both need `application.review`
(migration 0011) — both are a review in the everyday sense — so a
permission check alone could no longer say whose turn it was. `WorkflowStep`
gained `roleCode` (the role a step is actually configured for), and
`assertMayAct`/`availableActions` both check a principal's own role codes
against it: a Secretary cannot act on the Regional Manager's step even
holding the permission, and the reverse. Regional oversight is audited as
its own action, `membership.application.regional_reviewed`, so migration
0024 could seed the segregation rules the shared permission would otherwise
have missed — whoever captured an application may not give it regional
oversight, and whoever gave it regional oversight may not also review it
centrally or approve it, mirroring 0009's original captured/reviewed/approved
rules.

`reviewApplication` (S-305) took an optional `stepCode`, defaulting to
`'secretary_review'`, rather than becoming a second function — Regional
oversight's forward/return is the identical shape, just against a different
step and without S-608's Board-readiness re-check (verifying a filed
document is the Secretary's own review, which has not happened yet this
early). The "Applications" nav badge (`pendingActionCount`) is the same
config-driven counting, live rather than stored, for whichever step a
person's role covers. See `docs/applications.md` and `docs/configuration.md`.

**Follow-up, officer feedback:** a Regional Manager is already higher in the
hierarchy than the oversight step exists to provide — when they captured the
application themselves, there is no subordinate's work left to look over, so
`submitApplication` now writes the `regional_review` transition itself
(attributed to the capturing Regional Manager, with a comment saying why) in
the same transaction as the capture step's own, whenever Regional oversight
is enabled and the CAPTURING user (not necessarily whoever clicks Submit —
FRD 7.4.2 lets a Clerk submit on their behalf) holds the step's configured
role. Read fresh from `activeChain` and that user's own `user_role` rows, not
a hardcoded role name, so this only ever engages once an administrator has
actually enabled Regional oversight and stays correct if the role assigned
to that step is ever reconfigured. Every other reader of the chain
(`availableActions`, `pendingApplicationIds`, `reviewStageLabel`) already
answers "has Regional oversight happened yet" from the same
`application_transition` evidence, so the application simply appears in the
Secretary's queue immediately, with nothing further to change.

**Regression fix:** that bypass was unreachable for a Regional Manager who
holds only that role, not Regional Officer too — `assertMayAct`'s own role
check on the capture step ("that step acts on Regional Officer") refused
them before ever reaching it, leaving the application stuck at 'draft' with
nothing recorded — reported as "he can't send it to the next in chain."
`assertMayAct` now also lets a principal act on the capture step when they
hold the role configured for `regional_review` (`mayActAsCapturer`), on the
same "already higher in the hierarchy" reasoning — read from the
workflow's own step list, not the active/enabled chain, since a Regional
Manager's standing to capture and submit does not depend on whether
Regional oversight happens to be switched on. Scoped to the capture step
only, and to the specific role configured above it, so a Secretary or
President holding `application.capture`/`application.submit` still cannot
act on someone else's capture.

---

# M11 — Opening an account without a fresh membership

**Goal:** a member (or, later, someone who is not yet on the system at all)
can open an account type membership did not already open for them — HSA,
Investment, or anything else an administrator adds — through the exact same
approval chain a membership application already uses.

**Shipping in phases, each its own reviewable change**, the way S-611's own
follow-up did: the schema first, since every later phase depends on it and
it changes nothing on its own; the capture flow, document/signature/payment
shape and officer-facing pages after.

### S-612 · Additional-account applications, phase 1: schema ✅

**As** an existing member, **I need** to open an account type my membership
did not already open for me, **so that** I do not need a fresh membership
application to add HSA, Investment, or any other product. _(officer
feedback)_
`Must · 5 · EPIC-04`

- **Given** Regional oversight is enabled for membership applications
  **Then** it governs an additional-account application too — one setting,
  not two to keep in step
- Any active, non-membership-default account type is a valid selection, one
  or more at once — nothing names HSA or Investment specifically
- **Depends on:** which non-member holder concept a later phase uses for
  someone who is not yet a member at all — open, not needed by this phase

`membership_application` gained `application_kind` (`'membership'` |
`'additional_account'`), `existing_member_id`, and `membership_type_id`
became nullable — enforced together by a single check constraint,
`membership_application_kind_shape` (migration 0025), so a row can never
half-belong to both shapes. A new `application_account_selection` table
records which account type(s) an additional_account application opens,
since "HSA or Investment or both" is a set, not a single column.

**The point of staying in the same table**: `workflow_step`,
`segregation_rule` and every audit action already key on `entity_type =
'membership_application'` (S-209, S-611). An additional-account application
inherits `activeChain`, `assertMayAct`, Regional oversight and its
segregation rules with **zero changes** to `workflow.ts` — the same payoff
S-611 gave a gate added to an existing chain, now given to an entirely
different kind of application sharing that chain. A second
`workflow_definition` an administrator would have to configure twice, and
could let drift apart, was the alternative this avoids.

Nothing yet creates a row with `application_kind = 'additional_account'` —
every existing application defaults to `'membership'`, unaffected, so this
migration changes no behaviour on its own. `capture.test.ts` exercises the
constraint directly against the database rather than through application
code that does not exist yet.

### S-613 · Additional-account applications, phase 2: the capture entry point

**As** a Regional Officer, **I need** to start an additional-account
application by finding the member and choosing what to open, **so that** an
existing member does not need a fresh membership application for HSA,
Investment, or any other product. _(officer feedback)_
`Must · 5 · EPIC-04`

- **Given** a search term matching a member's name, NIC or Member No.
  **Then** only active members are offered — an additional account is
  something an active member does
- **Given** at least one account type is selected **Then** the application
  is created immediately, the same way picking a membership type does —
  there is no long form to wait on a first keystroke from first
- **Given** a membership-default account type (Shares, the MSA) **Then** it
  is refused — those open only on a membership's own approval (S-308, S-309),
  never through this flow

`searchExistingMembers` (`capture.ts`) mirrors `searchGuardianCandidates`'s
own shape (S-604) — matched by surname, name, NIC or Member No., active
only — left joined to `membership_application`/`application_party` rather
than inner joined, so a legacy member M7 imports without an application
(`member.application_id` is nullable for exactly that) is still found by
Member No. once that milestone lands, not silently excluded.
`startAdditionalAccountApplication` creates the `membership_application` row
(`application_kind = 'additional_account'`) and its
`application_account_selection` rows inside one transaction, refusing an
inactive member, an empty selection, or a membership-default account type
before anything is written.

### S-613, phase 3 · `loadApplication` reads both kinds correctly ✅

`Application` became a discriminated union —
`MembershipApplication | AdditionalAccountApplication`, split on
`applicationKind` — rather than adding nullable fields to one shape. Every
existing reader of `Application` narrows automatically once it checks
`applicationKind`, which is what turns "did I forget a spot this needed to
handle the other kind" into a compile error instead of a silent wrong read.
`loadApplication` left-joins `membership_type` and `member` (exactly one is
ever populated, enforced by `membership_application_kind_shape`, migration 0025) and, for an `additional_account` row, also reads its
`application_account_selection` rows joined to `account_type`.

**Every existing page that reads an `Application` is scoped to
`'membership'` on purpose, for now.** `[id].astro` and `print.astro` — both
built entirely around a membership type's field configuration and its
four-signature form — treat an `additional_account` row as "not found"
rather than attempt to render it: nothing about the record is wrong, these
pages simply do not know how to work it yet. `saveDraft` and
`problemsBlockingSubmission` (`capture.ts`) and `createMemberFromApplication`
(`members/create.ts`) each refuse or short-circuit for the other kind, so a
mistake in the wiring that eventually connects an additional-account
application to the workflow engine fails loudly rather than saving a
non-existent field, reporting a phantom missing field, or creating a member
nobody asked for.

**Still ahead**: the officer-facing pages an additional-account application
actually needs — reviewing it, a single-signature form in place of the
four-signature one, payment against each selected account type's
`minimum_opening_amount` rather than a membership fee schedule, and the
approval path that opens the selected account(s) under `existingMemberId`
instead of creating a member. Each is its own increment, the same way this
one was.

### S-613, phase 4 · The document checklist reads account types, not a membership type ✅

`documents.ts`'s `resolveOwner` inner-joined `membership_type` to find an
application's checklist — for an `additional_account` row, whose
`membership_type_id` is always null (migration 0025), that join silently
matched zero rows and `checklistFor` reported "That application no longer
exists," even though it did. The application was never missing; the
checklist source was just the wrong table.

`resolveOwner` now reads `application_kind` first and resolves the checklist
from whichever table actually applies: a membership type's own checklist for
`'membership'`, or — new — the union of the selected account types' own
checklists (`account_type.checklist_id`, migration 0010) for
`'additional_account'`. `config.checklistForAccountTypes` (`reference.ts`)
does the union: a document required by any selected account type is
required on the application (`bool_or` across the selected types), and one
two account types both ask for is not listed twice.

**Still ahead**, unchanged from phase 3's list above; this phase only fixed
the checklist source.

### S-613, phase 5 · The entry point actually exists — search, select, create ✅

Phase 2 was titled "the capture entry point," but only ever shipped
`searchExistingMembers` and `startAdditionalAccountApplication`
(`capture.ts`) — nothing under `src/pages` called either, so there was no
way for an officer to reach them. `/applications/new-account` is that page:
search for an active member (mirrors the guardian search on the capture
form, S-604, against a new `/api/v1/applications/existing-member-search`
endpoint), select one or more account types (`listAccountTypes`, active and
not membership-default), submit. A new "Open an account for an existing
member" link sits under Start an application on `/applications`.

Making the application reachable surfaced two more spots with the same
inner-join bug phase 4 closed in `documents.ts` — `listApplications` and
`deleteDraftApplication` (`capture.ts`) both joined `membership_type`, so an
`additional_account` row (`membership_type_id` always null) would have
vanished from the officer's own applications list, and an abandoned draft
of one could not have been deleted. Both are left joins now;
`listApplications` also names the row by the existing member and the
account type(s) selected (`"Account: HSA + Investment"`) rather than a
membership type it does not have.

**Still no review page.** The list links a membership application's
reference to `/applications/<id>` as before; an `additional_account` row's
reference is plain text — `[id].astro` does not know how to show it yet
(phase 3), so a dead link would be worse than none. Creating one redirects
back to the list with a confirmation instead. **Still ahead**, unchanged:
the officer-facing review page, the single-signature form, payment against
`minimum_opening_amount`, and the approval path that opens the account(s).

### S-613, phase 6 · Paying to open an account ✅

Officer direction: the amount due is simply each selected account type's
own `minimum_opening_amount` (`account_type`, migration 0010) — nothing new
for an administrator to configure. That is not a fee schedule by another
name: `payment_line.component_code` is deliberately a closed set of five
FRD-defined codes (migration 0017) an open-ended, admin-created account type
cannot be squeezed into, and `payment.fee_version_id` was `not null` —
recording a payment against an `additional_account` application, which has
no fee schedule at all, was impossible at the schema level.

Migration 0026 makes `fee_version_id` nullable and adds
`payment_account_line` — `payment_line`'s counterpart, snapshotting the
account type and amount charged the same reason `payment_line` already
keeps `scheduled_amount` beside `amount`. `Payment` gained `accountLines`,
empty for every existing payment. New, parallel functions —
`amountDueForAdditionalAccount` and `recordAccountOpeningPayment`
(`payments.ts`) — sit beside `amountDueForApplication`/`recordPayment`
rather than branching inside them, the same reason
`startAdditionalAccountApplication` sits beside `startApplication`: the
input shape genuinely differs, and every caller already knows which kind of
application it holds.

Recording one this way satisfies `submissionReadiness`'s payment gate
(`workflow.ts`) with **no change to `workflow.ts` at all** —
`paymentsForApplication` was already generic — which is the same "no code
change" payoff S-612's schema decision gave `activeChain`. The printed
receipt (`receipts/[id].astro`) now reads either `lines` or `accountLines`,
whichever the payment actually has.

**Refunding an account-opening payment is refused for now** — the itemised,
component-by-component refund exists only for a fee-schedule payment; voiding
the whole receipt outright (`voidPayment`, unaffected by any of this) still
covers a mistake in the meantime. **Still ahead**: the officer-facing review
page itself (nothing yet calls either new function), the single-signature
form, and the approval path that opens the account(s) on decision.

### S-613, phase 7 · The approval path — opening the account(s) ✅

`openAccountsForApplication` (`members/create.ts`) is
`createMemberFromApplication`'s counterpart as `decideApplication`'s decide
callback (`workflow.ts`) — and, proved by an end-to-end test mirroring M3's
own walking-skeleton test, driving an additional_account application through
`submitApplication` → `reviewApplication` → `decideApplication` needed
**zero changes to `workflow.ts`**, the same "share the exact same settings"
payoff S-612's schema decision was chosen for.

Unlike a membership approval, nothing here creates a member —
`existingMemberId` already is one. What it opens comes from the
application's own `selectedAccountTypes` (S-612), not
`is_membership_default`, and each selected type is re-read fresh at approval
time rather than trusted from capture — the same reason
`createMemberFromApplication` re-reads the membership default fresh (S-206):
an administrator may have deactivated one since. A member who already holds
one of the selected account types is refused with a plain message before the
insert, rather than left to `account_one_per_type_per_member_idx`
(migration 0018) to surface as a raw constraint violation to whoever is
approving.

**Still ahead**: the officer-facing review page itself — every piece it
needs (checklist, payment, workflow actions, and now approval) exists in
`capture.ts`/`documents.ts`/`payments.ts`/`workflow.ts`/`members/create.ts`,
but nothing yet calls them from a page. And the single-signature form.

### S-613, phase 8 · The officer-facing review page ✅

`/applications/<id>/account` — a separate page from `[id].astro`, not a
retrofit of it (the decision recorded back in phase 3): that page is built
entirely around a membership type's field configuration and its
four-signature form, neither of which this kind has. What this page needs
instead is smaller, since there is no applicant to capture: it opens
straight on Documents, Payment and the review chain.

Every section calls a function phases 1–7 already built and tested —
`checklistFor`, `beginUpload`/`commitUpload`/`reviewDocument` (documents.ts),
`amountDueForAdditionalAccount`/`recordAccountOpeningPayment` (payments.ts),
`availableActions`/`submitApplication`/`reviewApplication`/
`decideApplication` (workflow.ts, with `openAccountsForApplication` as the
decide callback) — so this phase is genuinely just wiring a page to what
already exists, the payoff every prior phase's own scoping was chosen for.
The document-upload and payment-total scripts are copied from `[id].astro`
rather than shared via a new component: refactoring the biggest, most
heavily-relied-on page in the app to extract a component was judged a
larger, riskier change than the size of this one justifies on its own.

`/applications` now links an `additional_account` row's reference to this
page instead of showing it as plain text. `[id].astro`'s own guard, which
used to throw for a mismatched kind on the reasoning that nothing could
ever reach that state, now redirects a stale bookmark or hand-edited URL to
the page that actually knows it — a reload after its own POST still throws,
since `applicationKind` cannot change under it.

**Still ahead**: the single-signature form, in place of the four-signature
one `[id].astro`'s own print page carries — nothing in this flow prints or
signs anything yet, since there is no form built around the fields it
would need. Refunding an account-opening payment (phase 6) is the other
open item; voiding the receipt outright still covers a mistake.

---

# M12 — Opening an account for someone who is not a member

**Goal:** someone not yet on the system at all can open an HSA, Investment,
or any other account through the exact same approval chain a membership
application already uses — the "later" M11 named and deferred.

**Officer feedback, business direction**: an accounts-only applicant never
becomes a Member. They get their own kind of record, and their own account
numbering (HSA0001, INV0001-style) rather than sharing one AB number the way
a member's Shares and MSA already do (migration 0018). What they are asked
to provide reuses the Individual membership application's own fields and
documents — no new form to design, and familiar to the officers who already
capture one.

**Shipping in phases, each its own reviewable change**, the way M11 itself
did: the schema first, since every later phase depends on it and it changes
nothing on its own.

### S-614 · Non-member account applications, phase 1: schema ✅

**As** someone not yet on the system, **I need** to open an HSA or
Investment account by providing my own details, **so that** I do not need
to become a full Member to do it. _(officer feedback)_
`Must · 5 · EPIC-04`

- **Given** the applicant's own details and KYC documents **Then** they are
  captured the same way an Individual membership application already
  captures them — chosen at capture, the same field and checklist
  configuration, not a new form
- **Given** approval **Then** a customer is created, never a member, and the
  selected account(s) are numbered HSA0001/INV0001-style rather than
  sharing one number the way a member's accounts do

`membership_application.application_kind` gained a third value,
`'customer_account'` — captures an applicant (`membership_type_id` set, the
same as `'membership'`) and selects account type(s)
(`application_account_selection`, already generic since S-612), but creates
neither a member nor opens an account under an existing one on approval.
`membership_application_kind_shape` (migration 0025) grew a third branch
rather than a parallel constraint, the same table every application kind
now shares.

A new `customer` table is deliberately as bare as `member` (S-308) — no
name or NIC of its own, both read from `application_party` against the
application a customer came from, exactly how a member's own name already
is. `account` gained a nullable `customer_id` beside its existing
`member_id`, and `account_no` — dropped for members in migration 0018
because two shared accounts inviting one number to disagree with itself was
worse than not storing it — is reintroduced here nullable, for exactly the
opposite reason: a customer's accounts have no shared number to lean on, so
each needs its own. `account_owner_shape` enforces exactly one of
`member_id`/`customer_id`, with `account_no` set if and only if the account
is a customer's.

Numbering itself is `next_customer_account_number(account_type_id)`, a
per-type counter table rather than a Postgres sequence per type — account
types are administrator-created and open-ended (S-206), so a fixed sequence
per type cannot exist ahead of time. Its prefix (`HSA`, `INV`, ...) is a new
`account_type.number_prefix` column an administrator sets the same way they
set every other fact about an account type, nullable until a customer flow
actually needs one — nothing here names HSA or Investment specifically,
the same reasoning S-612 gave for account type selection itself.

Nothing yet creates a row of any new shape — every existing application
defaults to `application_kind = 'membership'`, and no account exists
without a `member_id` yet, so this migration changes no behaviour on its
own. `capture.test.ts` exercises every new constraint directly against the
database, the same way S-612's own phase 1 did.

**Still ahead**: the capture entry point (the "are you an existing member?"
branch on Applications → Open an account, and the applicant-details form
behind "no"), the document checklist and payment for this kind, the
approval path that creates the customer and numbers the account(s), and the
officer-facing review page — each its own increment, the way every phase of
M11 before this one was.

### S-614, phase 2: the capture engine itself ✅

`CustomerAccountApplication` joined `Application`'s union in `capture.ts` —
the union of what the other two kinds each need: `parties` and a
membership type to source field configuration from, the same as
`MembershipApplication`; `selectedAccountTypes`, the same as
`AdditionalAccountApplication`. `startCustomerAccountApplication` mirrors
`startAdditionalAccountApplication`'s own account-type validation (active,
not membership-default) and `insertApplication`'s own empty-party seeding,
against the Individual membership type specifically — business direction,
not a choice this function offers.

`saveDraft` and `problemsBlockingSubmission` each carried a guard reading
`applicationKind !== 'membership'`, added in S-613 when `additional_account`
was the only other kind and had no fields to save or validate. Widened to
name `additional_account` specifically rather than exclude everything but
`membership` — a `customer_account` application captures an applicant the
same way a membership application does, so it saves and validates the same
way too. The same shape of gap existed in `payments.ts`:
`amountDueForApplication` would have read a `customer_account`
application's `membership_type_id` (there to source field configuration,
not to be charged against) and quietly charged the Individual type's own
fee schedule — entrance fee, Takaful, Shares — instead of what is actually
due to open the selected account(s). Both directions are guarded now:
`amountDueForApplication` refuses a `customer_account` application by name,
and `amountDueForAdditionalAccount`/`recordAccountOpeningPayment` (S-613
phase 6) accept it alongside `additional_account`, since both are charged
identically — each selected account type's own `minimum_opening_amount`.

**Still ahead**: the actual entry point (nothing yet calls
`startCustomerAccountApplication` from a page — the exact gap S-613 phase 2
first shipped, corrected in its own phase 5), the document checklist for
this kind (a customer_account row also needs the Individual type's own KYC
checklist, not only the selected account types' — `documents.ts`'s
`resolveOwner` does not know that yet), the approval path that creates the
customer, and the officer-facing review page.

### S-614, phase 3: the entry point, the checklist union, and the officer page ✅

Built together this time, unlike S-613's own split across phases 2/4/5/8 —
the lesson from that flow was to not ship a backend an officer cannot
reach.

`/applications/new-account` (S-613 phase 5's own page) now asks "is this
for an existing member?" before anything else. Yes is the unchanged member
search and account-type picker; No drops the member search and, on submit,
calls `startCustomerAccountApplication` and lands the officer straight on
the new application rather than back on the list — there is an applicant to
capture here, which an additional_account application never had.

`documents.ts`'s `resolveOwner` gained a third `ChecklistSource`,
`membership_type_and_account_types`, and `checklistForNonMemberAccount`
(reference.ts, renamed in phase 4 below) merges what a non-member applicant
must provide with `checklistForAccountTypes` the same way
`checklistForAccountTypes` itself merges several account types' checklists
— a document required by either side is required on the application, and
where both sides configure the same document type, required wins.

`openAccountsForCustomerApplication` (members/create.ts) is the third decide
callback beside `createMemberFromApplication` and `openAccountsForApplication`
— it creates the bare `customer` row (migration 0027) and numbers each
selected account through `next_customer_account_number`, refusing up front,
by name, an account type with no `number_prefix` configured rather than
surfacing that function's own database exception to whoever is approving.
`account_type.number_prefix` is now settable from Configuration → Account
types, in plain language ("Number prefix for a non-member's account") —
migration 0027 added the column but nothing before this phase could set it,
which would have made every customer_account approval fail regardless of
capture.

The officer-facing page is new, at `/applications/<id>/customer` — not a
retrofit of `[id].astro` (built entirely around a membership's four-signature
form) or of `account.astro` (built with no capture step at all), but the
two engines those already prove out, combined: `[id].astro`'s capture step,
reusing the Individual type's own field configuration exactly as a
membership application's capture does, and `account.astro`'s
documents/payment/review sections, reusing `amountDueForAdditionalAccount`
and `openAccountsForApplication`'s own account-opening machinery — both
already widened for this kind in earlier phases. No print step: printing is
built around a membership application's four-signature form (`print.astro`),
which this flow does not use; capture leads straight into documents instead.
`[id].astro`'s own kind-routing redirect now sends a `customer_account`
application here the same way it already sent `additional_account` to
`account.astro`.

`DecisionResult`'s `member.accounts` gained an optional `accountNo`, set
only by `openAccountsForCustomerApplication` — a member-owned account
carries none of its own (the member's own AB number already identifies it,
migration 0018), but a customer's does (migration 0027), and the officer
page shows it once approved rather than the meaningless empty `memberNo`
this kind returns instead.

**Still ahead**: the single-signature form and itemised refunds for
account-opening payments (both already deferred from M11); an admin listing
for customers, parallel to Members, if one turns out to be needed once this
is in use.

### S-614, phase 4: a non-member checklist of its own, and customers on the Members page ✅

Two gaps found in use, both closed here.

**Not every document a member's own checklist asks for belongs on a
non-member's.** Phase 3 unioned Individual's own checklist (`checklist_id`
— a nominee's own ID card, the signed application form) straight into a
customer_account application's own, because at the time that was the only
KYC pack there was to reuse. `membership_type` now carries a second,
independent reference, `non_member_checklist_id` (migration 0028) — what a
non-member applicant must provide, configured separately from what a member
of the same type must provide, from Configuration → Membership types
("Documents required from a non-member applicant", shown only on
Individual's own row — the only type this flow ever captures against,
capture.ts's own business decision, not something this control makes
configurable). Seeded with a starting pack of its own (`non_member_kyc`:
ID card, proof of address) rather than left null, so a non-member's own
identity is checked for something from the first approval, not only once an
administrator notices a gap. `checklistForMembershipType` stayed exactly
what it was — a member's own checklist, read by `checklist_id`; the new
`checklistForNonMemberApplicant` reads the other column, and
`checklistForNonMemberAccount` (renamed from
`checklistForMembershipTypeAndAccountTypes`) unions that with the selected
account types' own, unchanged.

**A non-member is a real record, not a hidden one.** `listMembers`
(members/create.ts) now unions `member` and `customer` rows into the one
list the Members page already showed, each carrying a `kind` — `loadMember`
returns `'member'`, and a new `loadCustomer` (the counterpart to
`loadMember`, for someone who was never a member) returns `'customer'`. A
customer has no AB number of their own to search or sort by, so the list's
"ID" column reads their held account number(s) instead (HSA0001-style,
comma-joined if they hold more than one), and its "Type" column reads the
account type(s) they hold rather than a membership type they do not have.
`/members` tags a customer's row "Non-member" rather than leaving the
distinction to be inferred from the ID's own shape; `/members/<id>` tries
`loadMember` first (the far more common case, not a priority judgement) and
falls back to `loadCustomer`, rendering the same Accounts and Payments
sections either way — a customer's own payment is found through their
application (`paymentsForApplication`), since payment carries no
customer-equivalent of `member_id` yet.

### S-614, phase 5: a routing bug fixed, and a non-member's own path to membership ✅

**Bug, found in use**: `/applications` linked every non-membership
application to `/applications/<id>/account` — a two-way ternary written
back when `additional_account` was the only other kind (S-613), never
widened for `customer_account` (S-614 phase 2). Opening a draft
customer_account application from the list sent it to a page built to
refuse anything but `additional_account`, which threw and answered 500.
Fixed the same way `[id].astro`'s own redirect already was in phase 3:
three branches, one per kind.

**A non-member can apply to become one.** `startMembershipApplicationFromCustomer`
(capture.ts) is a new way in beside `startApplication`/`startApplicationWithValues`
— always against Individual, the only type a customer_account application
is ever captured against, so its own field values line up with Individual's
exactly. Copies the customer's existing `application_party` rows into a
freshly started Individual application rather than starting empty; refuses
a customer who no longer exists or is not active, the same shape of guard
`startAdditionalAccountApplication` puts on the member it opens an account
for. `/members/<id>` gained an "Apply to become a member" action, shown
only on a customer's own page, posting straight to
`startMembershipApplicationFromCustomer` and landing on the ordinary
`/applications/<id>` capture page — from there it is exactly a membership
application, edited, submitted and approved through the same chain any
other one goes through. Approval creates a new Member; it does not touch
the customer record or reassign the account(s) they already hold, which
would be its own, separate decision this does not make.

### S-614, phase 6: the account moves too, two renames, and a universal query fix ✅

**The account moves with them.** Phase 5's "does not touch the customer
record or reassign the account(s)" was the honest state of that phase, not
the final word — this phase does the transfer. `membership_application`
gains `source_customer_id` (migration 0029), set by
`startMembershipApplicationFromCustomer` and read by
`createMemberFromApplication` (members/create.ts) at approval: every
account the customer held moves to the new member — `member_id` set,
`customer_id` and `account_no` cleared (a member-owned account carries no
number of its own, the same rule every other member-owned account already
follows) — alongside whichever type(s) open on approval as usual (Shares,
the MSA). The customer record itself is marked `status = 'converted'`
rather than deleted: the account(s) it once held are the historical link
back to it, and a converted customer refuses a second application
(`startMembershipApplicationFromCustomer`'s own "must be active" guard).
`/members/<id>` stops offering "Apply to become a member" once converted,
and reads "Moved to their new membership when it was approved" in place of
"No account has opened yet."

**Renames**: "Start capture" → "Member Registration"; "Open an account for
an existing member" → "Open other account" (`/applications`).

**Sizing**: the "Start an application" card and the `/applications/new-account`
page it links to read as two different sizes for the same reason two pages
usually do — different outer page widths (`max-w-5xl` against `max-w-2xl`).
The card is now wrapped at the same `max-w-2xl` the destination page
already uses, rather than widening a two-field form to fill a five-column
table's own width.

**A universal query fix.** `pendingActionCount` (workflow.ts) — the sidebar
badge `DashboardLayout` computes on every dashboard page for anyone with
`application.view` — reads the active workflow chain
(`activeChain`/`listWorkflows`, reference.ts) fresh on every call, and nets
two queries against `workflow_definition` and `workflow_step` neither of
which changes mid-request. `availableActions` and `reviewStageLabel`
(workflow.ts) each read the same chain again on an application's own page,
and `/applications` reads it a third time directly — none aware the other
callers just asked the same question. `listWorkflows` now keeps what it
read for a few seconds on the warm instance, cleared by the three
functions that can actually change it (`setStepEnabled`, `setStepRole`,
`setStepQuorum`) so an administrator's own change is never read back
stale — proved by an existing S-209 test that already toggles a step and
reads the chain again in the same request. Not the kind of cache
`resolvePrincipal` deliberately does without (S-107's "no cache to
invalidate" is about permissions, a security boundary); workflow step
routing is operational configuration, where a few seconds of staleness
after a rare administrative change is a reasonable trade against paying
for the same two queries three to five times on every click.

### S-614, phase 7: save on Next instead of while typing, and one width for every capture form ✅

**Saves once, on Next — not continuously while typing.** S-302, decision 14
made autosave continuous (a pause after typing, a backstop interval, every
way of leaving the page) so an officer on a tablet never lost work to a
dropped connection. In practice a network call on every keystroke read as
the application being slow. The three capture pages that autosaved this way
(`applications/new.astro`, `applications/[id].astro`,
`applications/[id]/customer.astro`) now save exactly once, when Next is
clicked, in one request that carries everything on the form — the
`intent=autosave` endpoint each posts to is unchanged, only what triggers it.
The noscript fallback button (for a reader without scripting, who never sees
a scripted Next at all) is unaffected.

**One width for every capture form.** `new.astro`, `[id].astro`,
`[id]/customer.astro`, `[id]/account.astro` and `new-account.astro` had
drifted to four different outer widths (`max-w-4xl`, `max-w-3xl`,
`max-w-2xl`) for no reason tied to what each form holds — a two-field
"which account type" form read as a noticeably smaller box than the
membership capture form next to it. All five, plus the `applications` list
page they lead from, now share `max-w-5xl`.

**"Start an application" matches the table below it, and its two actions
share a line.** The `max-w-2xl` wrapper phase 6 put around the "Start an
application" card (to match `new-account.astro`'s width at the time) is
gone now that every width is `max-w-5xl` — the card reads at the same width
as the "Applications" table underneath it, rather than narrower. "Member
Registration" and "Open other account" moved from a stacked layout with a
divider between them onto one row, the second pushed to the right-hand
edge.

### Performance pass: fewer round trips per click ✅

Every page felt slow for one reason more than any other: a serverless
function on Vercel talking to a database in another region, one query at a
time. An application page ran twenty to thirty queries, most of them one
after another, several of them the same question asked twice. This pass
takes the query count down and runs what remains side by side, without
changing what any page shows.

**Reference configuration is cached** (`src/lib/config/cache.ts`): membership
types and their fields, account types, document types and checklists, fee
versions, workflow statuses and the workflow chain (whose own cache from
phase 6 folds into this one). A few seconds on the warm instance, cleared by
`withConfigurationActor` (db/pool.ts) after any configuration write — the
one door every such write already had to go through, so no setter can
forget. The promise is cached, not the value, so concurrent callers in one
request share a single query. Permissions stay uncached (S-107).

**One read per application instead of one per step.** `gatePassed` ran a
query for every workflow step asked about, from `availableActions`,
`reviewStageLabel` and `assertMayAct` alike; `passedSteps` (workflow.ts)
reads the steps an application has passed once and `unmetGates` consults
that set in memory. `pendingActionCount`'s per-step counts go out together.
`loadApplication` reads the row and its parties together; the payment line
reads in payments.ts likewise.

**The three application pages read in one round.** Checklist, blocking
problems, available actions, history, stage label, payments and the amount
due all depend only on the application, so they go out in one `Promise.all`
rather than in sequence, and `boardReadiness` now accepts what the page has
already read instead of repeating three of those queries itself. The
"Applications" badge count is started by the middleware
(`locals.pendingActions`) before the page's own reads, so it overlaps them;
`DashboardLayout` awaits it.

**A warm connection between clicks.** The pool's idle timeout goes from 10 s
to 60 s with TCP keepalives, so an officer's next click reuses the
connection rather than paying TCP + TLS + authentication to the database's
region again (docs/database.md). Tunable with `DATABASE_IDLE_TIMEOUT_MS`.

**Five times less script per page.** `BaseLayout` imported the whole of
Preline (385 kB) for a dropdown, an overlay and a theme toggle; it now
imports those three plugins. `vercel.json`'s catch-all `Cache-Control:
max-age=0` no longer applies to the hashed `/_astro/` assets, which are
immutable and are now sent as such.

Not done here, because it needs a fact this repository does not record: the
Vercel function region. If the database is in, say, South Africa North and
the function runs in the default `iad1`, every query crosses the Atlantic
twice — pinning the region next to the database is the single largest
remaining lever, and a one-line `regions` entry in `vercel.json`. (It is:
see "Performance pass 2" below.)

**Prefetch was configured but silent.** `prefetch: true` in astro.config.mjs
only makes the `data-astro-prefetch` attribute available on a link — it does
not turn prefetching on for any link by itself, and nothing in the project
carried that attribute, so it had been doing nothing since it was added. Now
`{ prefetchAll: true, defaultStrategy: 'tap' }`: every same-origin link
prefetches with no per-link markup, and `tap` (touchstart/mousedown) rather
than the default `hover` — an officer on a tablet has no hover to fire it,
only what `tap` listens for, and it still lands before the click's own
request goes out. A prefetch is a real request through the same middleware
and page code the click would run, so it also warms the reference cache and
the database connection moments before the real navigation needs them.
Two links do something other than navigate on GET — `/auth/logout` clears
the session, `/auth/login` sets OAuth state cookies — and opt out with
`data-astro-prefetch="false"`; touching down on "Sign out" must never end
the session by itself. Verified in a real browser: a `mousedown` on an
ordinary link produces a `<link rel="prefetch">`, the same event on "Sign
out" produces none.

### S-614, phase 8: printing and signing a non-member's own account application ✅

**A non-member opening an HSA or Investment account had nowhere to print
the form, or sign it.** Migration 0028 (phase 4) deliberately left
`signed_form` off the non-member checklist, reasoning that the flow "has no
print step of its own" — true at the time, and no longer: officer feedback
is that it needs one. Migration 0030 adds `signed_form` back
(`non_member_kyc`, required); `print.astro` now accepts a `customer_account`
application the same way it already accepts a `membership` one (same field
configuration, same parties, same four signature lines), with the heading
and declaration wording swapped for an account rather than a membership
one; `customer.astro`'s own step numbering gained the `PRINT_STEP` between
capture and documents that `[id].astro` already had, so Next from capture
goes to the print page first, and the print page's own Next leads into
documents, mirroring `[id].astro` exactly. The timeline's "Application
signature" step and the "Signatures confirmed present on the scan" checklist
UI were already generic across every application kind — the checklist item
was the only thing missing for either to do anything on this flow.

**Signing happens on the page, not only on paper afterward.** Each
signature box on the print page is now a `<canvas>` an officer or applicant
can draw into with a finger or stylus, layered over the same ruled line
that was already there — the line stays the fallback for an actual pen, or
for a reader without scripting, so nothing is lost for either. Print
(choosing "Save as PDF" in the browser's own print dialog) carries the ink
straight into the file, which the officer then uploads on the documents
step the same way any signed form already gets filed. Nothing is
persisted server-side by the signing itself — the canvas is pixels on the
page until printed, the same as a signature on paper is ink until scanned.

**The user menu shows a role, not an address.** `Principal` gains
`roleNames` (principal.ts, alongside the existing `roles` codes, read from
the same query) — the "Signed in as" panel in the header now reads e.g.
"Regional Officer" instead of the signed-in email, which told a colleague
nothing an internal tool needed to say out loud.

### Performance pass 2: the database's own region, batched writes, real upload progress ✅

**The database is in Azure South Africa North; the function now runs
next to it.** Every earlier round of query-batching was working against a
fixed cost per round trip this pass finally has a number for: `vercel.json`
now pins the deployment to `cpt1` (Cape Town) instead of Vercel's US-East
default, which is what the two reported cases — opening a fresh
`customer_account` application, and opening an existing one from the
`Applications` table — were mostly paying for for. Confirm after deploy
(the `x-vercel-id` response header's prefix names the region a request
actually ran in) — region pinning is a Pro-plan feature, so this has no
effect on a Hobby-plan deployment, only a Vercel dashboard message saying
so.

**Starting an application wrote its rows one at a time.**
`insertApplication` (shared by every membership application, so also by
`startApplicationWithValues`'s own first save), `startAdditionalAccountApplication`,
and `startCustomerAccountApplication` each looped a sequential `INSERT`
per party or per selected account type — three, four, sometimes more round
trips to create one row of actual content. Each now does it in one
statement, built from `unnest()`'d arrays. `startApplicationWithValues`'s
own per-party `UPDATE` and `saveDraft`'s per-party upsert — the save that
runs on every Next an officer clicks through the capture step, not just at
creation — batch the same way. `checklistFor` (documents.ts) had two
further reads that did not depend on each other but ran in sequence;
they now go out together.

**Uploading felt stalled because nothing moved on screen for it.** A
photo under about 8 MB uploads in one chunk (S-112's own chunking is
sized for resilience against a dropped connection, not tuned here), and
`fetch()` reports nothing until that whole chunk has landed — several
seconds of "Sending… 0%" that reads as stuck even when the transfer is
going fine. The three pages that drive an upload now use
`XMLHttpRequest`'s `upload.progress` event instead, which reports as the
bytes actually go.

**Signing on a phone dragged the page instead of drawing.** The signature
boxes added in phase 8 lived inside `print.astro`'s own layout, which is
built in millimetres for the A4 page it becomes and does not fit a phone
screen — on one narrower than about 700px the whole page was wider than
the viewport and panned under a finger before it ever reached a `<canvas>`
that could stop it. Signing now opens a full-screen box fixed to the
actual device viewport, not to anything in the page's own layout, with a
bigger canvas to draw in; "Use this signature" places the result where the
line was, in the space that box makes for it. The page itself also gained
a phone-width layout (`@media screen`, print output unchanged) so the
rest of the form does not pan either.

**10,000 external users reading their own balance, a phase from now.**
Investigated, not built — there is no balance endpoint yet, and the
identity a member's own mobile app would sign in with is undecided.
What is already true: `docs/api.md` names this exact phase (AD-03) as the
reason `/api/v1` is a versioned contract rather than an implementation
detail, so a member-facing endpoint is additional surface on the existing
framework, not a new one — `defineEndpoint`'s permission check, rate
limiting and audit trail all apply the same way, scoped to "this caller's
own balance" rather than an internal permission. Three things worth
deciding before that phase starts, none of them urgent today: (1) member
identity is a different problem from staff sign-in (S-106's Entra flow
assumes a pre-provisioned internal account) and needs its own design; (2)
`DATABASE_POOL_MAX` (3 per warm instance) scales with Vercel's own
instance count, which is fine until concurrent instances × 3 approaches
the Postgres tier's `max_connections` — Azure's built-in PgBouncer (port
6432, docs/database.md) is the documented answer once real traffic gets
there, not a bigger pool; (3) a balance is a natural fit for the same
short-TTL cache pattern already serving reference configuration
(config/cache.ts) if a few seconds of staleness is acceptable, which
would keep most reads off the database entirely.

### Signature modal: reachable buttons, and bulk deleting drafts ✅

**The signing box's own buttons could end up out of reach.** The
full-screen signing box from phase 8 blocked all touch scrolling on
itself (`touch-action: none`) to stop a drag meant for the pen from
moving the page — reasonable for the canvas, wrong for the bar above and
below it carrying Cancel, Clear and Use this signature: on a phone whose
address bar changes the actually-visible height after the box opens,
those bars could end up sized or positioned outside what was on screen,
with no way to scroll to them because scrolling was exactly what had
been switched off everywhere in the box, not just on the canvas.
Touch-blocking now applies to the canvas alone; the box sizes itself
with `100dvh` (falls back to `100vh` where unsupported) instead of
trusting `inset: 0` alone to track a moving toolbar; and the box can
still be scrolled as a last resort if a bar ever does end up outside the
visible area for a device this does not already fix.

**Selecting several drafts and deleting them together.** The applications
table gains a checkbox per draft row (the only status `deleteDraftApplication`
already accepted) and a "select all" in the header; a bulk action bar
reports the count and submits them all under the same `delete` intent the
single-row button already used — one checkbox or twenty is the same
action, not a separate one. Each draft is still deleted as its own
transaction, in order, with its own checks (not submitted, no receipt, no
filed documents): a batch is several independent deletions succeeding or
failing on their own terms, not rows removed in one statement, and a
failure part-way through is reported by reference with what stopped it
rather than silently rolled into "something went wrong."

**Sorting the table.** Every column header is now a button that reorders
the rows already on the page — client-side, since the list this page
reads is already capped and already loaded, and asking the server for
the same hundred rows in a different order would be a round trip spent on
nothing new. Clicking again reverses the order; an arrow marks which
column and which direction. Selected checkboxes survive a sort — the
rows are moved, not rebuilt.

### Draft privacy, a persistent signature, and the Members page's own account buttons ✅

**A draft was visible to every officer who could see the list, not just the
one who started it.** Officer feedback: "only the officer that filled in
that form should see those draft status applications." `listApplications`
(capture.ts) gains a `viewerUserId` option that hides a `draft` row unless
the viewer captured it — every other status stays exactly as visible as it
already was to anyone holding `application.view`, since a draft is the
only status that is still one officer's own work rather than something the
Society has been handed. Hiding it from the list is not enough on its own:
`[id].astro`, `customer.astro`, `account.astro` and `print.astro` each
gain the same check on the record they load, so a colleague who already
has the URL cannot open someone else's draft by typing it in either —
answered as an ordinary "not found," the same as an id that does not
exist, rather than a "forbidden" that would confirm a draft is there to
someone not meant to see it.

**A signature drawn on the print page vanished if the officer stepped
back to fix something on capture.** The canvas was deliberately never
persisted server-side (S-613 phase 8) — pixels on the page until printed,
the same as ink is pixels on paper until scanned — but "until printed" was
also, accidentally, "until the tab navigates," and Back is a navigation an
officer needs for an ordinary correction, not a reason to redo every
signature already collected. Each signed box now also saves its data URL
to `sessionStorage`, keyed by the application and who signed, and restores
it automatically when the print page loads — surviving Back-and-return the
same tab already supports, gone the moment the tab actually closes, which
is the same lifetime the signature already had.

**The Members page led with an id nobody needed first, and could not show
what a name search actually turns up until the officer followed a link
away.** Officer feedback: drop the Type and From columns outright, move
the id to the end of the row, and make it look like the account it names
rather than a bare code — grey for an HSA account, blue for Investment,
a third colour shared by Shares and the MSA, styled by the account type's
own code and name (Configuration → Account types) rather than a fixed set
this page would otherwise have to know by name. The row itself is now the
link to the member's full record — applicant details, and, new on that
page, a Nominee section (or, for a minor, the successor guardian and
Takaful beneficiary) read from the same application the applicant details
already come from, which that page had never shown before. Clicking an
account's own button instead opens a small panel giving that account's
opening deposit and when it was made, fetched from a new endpoint
(`GET /api/v1/accounts/{id}/deposit`) only once a box is actually opened —
groundwork for the transaction history (deposit, withdrawal, transfer)
this is not yet: `depositForAccount` (payments.ts) reads what the account's
own opening payment recorded, traced back through whichever application
opened it, since the account row itself keeps no link to that payment.

**Starting a fresh application lost the "← All applications" link the
moment the page scrolled.** `new.astro` and `new-account.astro` — every
entry point into capture, membership or an additional account alike — now
wrap it in the same sticky `#application-nav` bar the id pages already
use, rather than a plain link at the top of the page.

### Nine items of officer feedback: permissions, uploads, viewing, and configuration ✅

**Who may turn a non-member customer into a membership applicant was tied
to application.capture — anyone who could capture any application could
convert any customer, whether or not that was the intent.** A new
`member.convert` permission (migration 0031) governs "Apply to become a
member" on its own, configurable on Configuration → Roles under the
Members group like anything else with that prefix; granted by default only
to Regional Officer, matching what application.capture already allowed
there, so nothing changes on deploy until an administrator touches it.

**The Members page's account buttons, and what they open.** HSA is now
blue, Investment a light rose, matched the same way as before (the account
type's own code and name, not a fixed set). Clicking one now opens a
popup — a `<dialog>`, closed only by its own Close button, not by a stray
click on the backdrop — listing every credit and debit recorded against
that account, not only the opening deposit: `depositForAccount` becomes
`transactionsForAccount` (payments.ts), reading both the opening payment
and any refund paid back against it from `payment_line`/
`payment_account_line` in one query each, since a refund already inserts
its own row on its own `payment` (kind = 'refund') there. The endpoint
moves with it, `GET /api/v1/accounts/{id}/transactions`.

**Filing an identity card and a utility bill at the same time only kept
one of them.** Each checklist box's own upload ran independently and
correctly, but the FIRST one to finish reloaded the page immediately
(`window.location.reload()`) — which aborted every other upload still in
flight rather than waiting for it. `[id].astro`, `customer.astro` and
`account.astro` each now count uploads in flight and hold the reload back
until every one of them has finished.

**A filed document could be deleted from an application that had already
moved on.** Officer feedback: only 'draft' and 'returned' (sent back for
exactly this kind of correction) should still allow it — every other
status is a submitted record, view only. The Delete button is now gated
on the same `isEditable` the rest of each page already reads (added to
`account.astro`, which had none); `removeFiledDocument` (documents.ts)
carries the same rule server-side, so a direct POST cannot reach around
the hidden button either.

**Viewing a filed document meant downloading it first.** `window.open(url)`
handed the browser a SharePoint download link — a save-to-disk prompt on
some devices before the file could even be looked at. Replaced with an
in-app viewer: an `<img>` for a photo, a PDF's own browser-native
`<iframe>` viewer for one of those, both fed the same pre-authenticated
URL as before; HEIC (no browser renders it inline) and anything
unforeseen fall back to "can't be previewed here" with a link to open it
directly. `getDocumentViewUrl` (documents.ts) and
`/api/v1/documents/view-url` now also return `contentType`, read from
`document_version` where it was already stored, to decide which.

**An approved application stayed on the Applications page after it was
already a member.** `listApplications` now excludes `status = 'approved'`
unconditionally — not just as the default view, but even when asked for
by name — since from approval onward the record lives on the Members
page and this list is not the place to keep a stale duplicate of it. The
status filter drops "Approved" as an option to match: it would otherwise
always read "no applications match."

**Creating a staff account listed every role as its own checkbox, which
got bulky as roles accumulated.** The "Add a staff account" section now
offers a multi-select dropdown instead — `<select multiple>`, still
driven by the same `listRoles()` read the checkboxes were, so a role
added or removed on the Roles page is reflected here with no code change
either way. The per-account "Roles" editor further down the same page is
unchanged; only account creation had the bulk complaint.

**"Show deactivated accounts" was offered even when there were none to
show.** Now shown only when `deactivatedCount > 0`, or while actually
viewing that (empty) list — the way back to the working list has to stay
reachable even then.

**There was no way to start a new document checklist — only to add
documents to one a migration had already seeded.** `createChecklist`
(reference.ts) creates an empty one, the same way `createAccountType` and
`createRole` already do for their own configuration; a new "Add a
checklist" section on Configuration → Document checklists calls it. It is
immediately selectable wherever a checklist is chosen — Account types'
own "Documents required to open" and Membership types' own checklist
picker both already read `listChecklists()` fresh, the same list this
page shows — so nothing else needed to change for the new checklist to
reach either KYC section.

### Two popups, actually centred and actually visible ✅

**A filed image or PDF showed as broken in the new document viewer.**
`vercel.json`'s Content-Security-Policy allowed `<img>`/`<iframe>` sources
from `'self'` only — never updated for the viewer dialog's own `<img>`/
`<iframe>` pointing at SharePoint's `@microsoft.graph.downloadUrl`, which
the browser silently refused to load. `img-src` and `frame-src` both gain
`https://*.sharepoint.com`, the same host `connect-src` already trusted for
the upload transfer itself.

**Neither popup was actually centred.** Tailwind v4's preflight resets
`margin: 0` on every element, including `<dialog>` — which is exactly what
a browser's own centring trick for `showModal()` depends on
(`margin: auto` with `inset-block: 0`). Both dialogs (the Members page's
transactions popup, and the document viewer) now position themselves
explicitly — `fixed`, `top-1/2 left-1/2`, shifted back by half their own
size — rather than relying on a default the framework's own reset was
quietly cancelling.

**The transactions popup looked like a stray white box, not part of the
app.** Restyled to match the light-grey card look every other section on
this app already uses (`bg-neutral-100`/`dark:bg-neutral-950`), sized like
a form rather than stretching to fill the screen.

**Two more items reported as "not there" were assumed to be Production not
having been promoted — half right.** The coloured account buttons were
already correct on `main`, and remain unexplained as a report against the
Test URL specifically (see the next entry). `member.convert` was not a
promotion problem at all: the next entry corrects this.

---

### Migration 0030 had never once applied, and a submitted application's documents stayed editable ✅

**`member.convert` really was missing from the Test deployment — not a
promotion gap, a migration that had failed on every single apply since the
PR that introduced it.** `migrations/0030_non_member_signed_form.sql`'s
`insert into document_checklist_item` carried no `on conflict` guard, and
on the real Test database an administrator had already added the same row
by hand from Configuration → Document checklists — the same "no print
step" gap 0030 exists to formalise — ahead of the migration reaching it.
A failed migration rolls back and stops the run, so every migration after
0030 silently never applied either, 0031 (`member.convert`) included, on
every deploy from the PR that introduced 0030 through the one before this.
The insert now carries
`on conflict (checklist_id, document_type_id, subject) do nothing`;
`scripts/verify-migrations.sh` grandfathers this one file by name, since
it never recorded a checksum anywhere for a checksum to drift from — the
harm that check exists to prevent cannot happen to a migration nothing
ever recorded; and `scripts/migrate.test.ts` proves it against the real
migration files with the same pre-existing row planted first, not a
synthetic stand-in.

**A document missing from a submitted application could still be filed —
the signed form among them — even though nothing else about the
application could be touched.** `removeFiledDocument` already refused to
remove a filed document once an application left `draft`/`returned`
(previous entry), but `beginUpload` and `commitUpload` never checked at
all: a required document nobody had filed by the time an officer
submitted stayed uploadable indefinitely afterwards, which is how a
signature meant only for print ended up editable on a submitted
application, with no way back into review once it was. Both now carry the
same guard, checked twice — once before a SharePoint folder or upload
ticket is created, again at commit in case the application was submitted
in the gap between a slow upload starting and finishing — and the Upload
control (`[id].astro`, `account.astro`, `customer.astro`) is now hidden
the same way the Delete control already was, rather than appearing and
then failing.

---

### Nine more items of officer feedback: fees, documents, receipts and one routing bug ✅

**"Start an application" hidden without `application.capture` was already
correct on `main` — the account buttons reported alongside it were not,
and this entry's own first pass got that wrong too.** `applications/
index.astro`'s "Start an application" section was genuinely already
`{canCapture && ...}`. The account buttons were a different kind of bug
entirely: `members/index.astro`'s markup was correct — every account
already rendered as its own coloured `<button>` — but `bg-blue-600`,
`bg-rose-200`, `bg-amber-400` and `bg-slate-500` (and every `amber-*`
status badge elsewhere in the app: applications, receipts
reconciliation, the cash-payment reminder above) compiled to nothing.
`global.css`'s `@theme` block resets Tailwind's entire default palette
(`--color-*: initial`) and re-declares only a curated set — gray,
indigo, neutral, mint, orange, red, zinc — and blue, rose, amber and
slate were never added to it, even after code elsewhere started using
them. A `bg-<colour>-<shade>` class with no matching `--color-<colour>-
<shade>` compiles to an empty rule, not a build error and not a wrong
colour — so every one of those elements had been rendering with no
background at all, invisibly, since whichever commit first used a colour
missing from the theme. All four are now defined, copied verbatim from
Tailwind's own default palette the same way gray/indigo/neutral/mint/
orange/red/zinc already were.

**A filed document's name was whatever a phone or a scanner called it,
not what it was or whose it was.** `beginUpload` (documents.ts) now names
it "<document type> - <reference>" — the application's own reference, or
the member's number once one exists (S-308: the application's reference
becomes that number on approval, so the two are never a mismatched pair)
— keeping only the original file's extension. `sanitiseFileName` still
does the cleaning; it is applied to the new name, not the old one.

**Entrance Fee and Takaful Contribution were editable, and Shares and the
MSA deposit could be paid under the fee schedule with just a reason.**
Officer feedback narrows this to two rules: Entrance and Takaful are
fixed — any other amount is refused outright, no reason can change that
— and Shares, the MSA deposit, and every additional-account opening
amount are a _minimum_ — less is refused outright, more needs no
justification at all. `recordPayment` and `recordAccountOpeningPayment`
(payments.ts) each replace their old single "variance from the total
needs a reason" check with this per-component rule; `FIXED_FEE_COMPONENTS`
and `FLOOR_FEE_COMPONENTS` name which components get which. The
"Reason, if the amount differs" field is now shown only when some other
required component (none exists today) could still need it, and is gone
entirely from the account-opening forms, where every component is a
floor.

**A large cash payment carried no record of where the money came from.**
`payment.cash_source_of_fund_threshold` (migration 0032, a `config_entry`
row — Configuration → Fee schedules → Cash payments) sets a configurable
amount, defaulting to Rs 45,000; a cash payment strictly above it now
needs a "Source of fund" note before a receipt can be issued, and the
form reminds the officer to also complete the paper Source of Fund form,
which lives outside this application entirely. `payment.source_of_fund`
(same migration) stores what was given.

**Clicking a non-member on the Members page led with an explanation of
what the button does, not just the button.** "Starts a membership
application with their details already filled in." is gone from
`members/[id].astro`; the button's own label already says what it does.

**The application was reachable by anyone who found the link, including
a search engine.** `<meta name="robots">` already said `noindex, nofollow`
on every page; `public/robots.txt` (disallow everything) and an
`X-Robots-Tag` response header (`vercel.json`) now say the same thing to
a crawler that never renders the page at all, and to the `/api/v1/*`
responses the meta tag was never on in the first place.

**A printed receipt named who issued it, not what they were issuing it
as.** `payment.recorded_by_role` (migration 0033) snapshots the issuing
officer's role(s) at the moment a payment or refund is recorded — the
same reason `fee_version_id` and `payment_line.scheduled_amount` are
snapshotted rather than read live: a role held today should not silently
rewrite what a receipt already printed. `receipts/[id].astro` shows it
next to the name.

**Clicking a timeline chevron on a non-member's account application did
nothing — it looked like it does on every other kind of application, and
was not.** `ApplicationTimeline`'s step links were all built from
`/applications/<id>`, which is correct for a membership application but
not for a `customer_account` one, which lives at `/applications/<id>/
customer` — reaching it via the membership path 302s there (S-614) but
drops the `?step=` query on the way, landing back on whatever step the
redirect's target defaulted to instead of the one actually clicked. The
component now takes an optional `basePath`; `customer.astro` passes its
own, and every chevron reaches the step it names.

---

### Five more items of officer feedback: SharePoint cleanup, a payment error that lost data, and two configuration gaps ✅

**Removing a filed document by mistake left the file sitting in SharePoint
forever.** `removeFiledDocument`'s own guarantee — versions are never
deleted — exists to keep a _superseded_ filing retrievable; a mistaken
upload was never a real filing, so there is nothing there worth keeping.
It now deletes the SharePoint item after the database row is safely marked
Missing (that ordering, not the reverse, so a Graph outage never blocks the
undo — it only leaves a file to clean up later, best-effort, logged rather
than thrown). The other half of this item — filing a fresh document after
a remove had no way to view it — turned out to already work correctly
(the upload flow reloads the page, and the checklist's View button reads
straight off what is actually filed); no separate bug was found there.

**A payment-step error threw away every amount the officer had already
typed.** The three payment forms (`[id].astro`, `account.astro`,
`customer.astro`) always re-rendered from the fee schedule's own defaults
on `record-payment`, error or not. Each now captures the submitted amounts,
method, method reference, source of fund and variance reason before calling
`recordPayment`/`recordAccountOpeningPayment`, and re-renders the form from
those on failure — nothing is lost, and the officer only has to fix what
was actually wrong.

**A large cash payment's paper Source of Fund form could be typed about
but never actually confirmed.** `payment.source_of_fund_form_confirmed`
(migration 0034) is a new mandatory checkbox alongside the existing
source-of-fund note, required — server-side, in `requireSourceOfFundIfCash`
— under the same condition as the note itself: cash, strictly over the
configured threshold. The checkbox's own `required` attribute follows the
same client-side toggle the reminder text already used, so it is never in
the way of an ordinary payment.

**Configuration had no way back out of an account type or a checklist
created by mistake — only deactivation, which keeps a choice nobody can
actually offer forever.** `deleteAccountType` and `deleteChecklist`
(config/reference.ts) add a genuine delete to each, refused by name
wherever the row is still in use — an account already opened, an
application that selected it, a payment line that charged it, a customer
account-number counter, or (for a checklist) a membership type or account
type still pointing at it — rather than surfacing the database's own
foreign-key error. Neither Account types nor Document checklists
(admin/configuration/) had a Delete control before this; both do now,
behind a confirmation dialog that names what only works if nothing already
uses it.

**The Members page had no way to see what a member or a held account
actually holds.** A new "Total funds" column sums Shares, the MSA deposit,
and any HSA/Investment/other account a member or non-member customer
holds — never Entrance, the processing fee or Takaful, which are the
Society's own one-time charges with no account behind them and so never
appear in `payment_line`/`payment_account_line` under those components.
Netted against any refund the same way `transactionsForAccount` already
treats one account's own history. Gated on `payment.view`, the same
permission the account buttons and receipts already require.

---

### Seven more items: a member's own documents, two missing counts, an applicant's name, and two access-control questions ✅

**The print page's signature box, on inspection, was already exactly this.**
Officer feedback asked for a full-screen signing box with Clear and Save,
closing back to the document on save — `print.astro`'s `.sig-modal` already
does all of it (a fixed, full-viewport overlay; Clear resets the canvas;
"Use this signature" writes the drawing onto the signature line and closes
the modal), built across two earlier rounds (mobile drag, then unreachable
buttons). No change made; flagged rather than silently closed, the same
lesson the account-button colours taught two rounds ago — a report that
sounds like a live bug is not always the same bug as last time's.

**A member's own page had nowhere to see what had been filed for them —
every document lived only on whichever application filed it, and a member
can hold more than one (the founding membership application, plus any
additional_account application approved since, S-612).**
`documentsForMember` (documents.ts) walks every application that has ever
filed something for a member and groups what it finds — the same
`existing_member_id` trace `transactionsForAccount` already uses to find
which application opened an account. A draft additional_account application
is excluded outright: S-614's own privacy rule keeps a draft to its
capturing officer, and a member's own page is not the exception. A customer
has only ever the one application, so no grouping is needed there. Both
pages reuse the existing document-viewer dialog and script verbatim.

**The Applications page had no sense of how many applications there
actually are — only however many rows a capped query happened to fetch.**
`countApplications` (capture.ts) is a real `count(*)`, not `.length` on a
`limit`-bounded list — excludes draft (an officer's own work in progress)
and approved (already on the Members page) the same way `listApplications`
itself does, and respects the same status filter when one is set. Shown as
a badge beside the "Applications" heading; hidden when the filter is
Draft specifically, where it would otherwise always read 0 beside a table
that is, in fact, showing rows.

**A membership type that captures two nominees writes a row for both the
moment the form is drafted — one exists whether or not the officer ever
filled it in, and Nominee 2 showed up on the member's page as a heading
over nothing.** The member detail page now filters out a party with
nothing entered before it counts occurrences for the "Nominee 2" label, not
after — so a member with only Nominee 1 filled in reads "Nominee", not
"Nominee 1" for the one that remains.

**The payment receipt named the application or the member, never the
person who actually paid.** `PAYMENT_SELECT` (payments.ts) now resolves the
applicant's own name three ways, most specific first: the paid
application's own applicant party (a membership or customer_account
application captures one directly); failing that, an additional_account
application names an existing member instead of capturing an applicant of
its own (S-613), so it falls through to that member's founding application;
failing that, `member_id` set directly (no insert populates it today, but
the column and the fallback exist for when one does). `receipts/[id].astro`
now reads "Jane Doe · AB0001" rather than just the reference or number.

**Two questions, answered rather than built: can access be restricted to
an IP allow-list, or to a time-of-day window, both configurable by a system
administrator?** Both are technically straightforward — `middleware.ts`
already runs on every request before a page is reached, and already
extracts the client's own address (`clientAddress`, currently used for the
audit trail only, explicitly never for a decision) from `x-forwarded-for`.
Not built: the real risk with either is locking out every officer,
including whoever configured it, from a single wrong entry — an office on a
shared or dynamic ISP address (common locally) could be refused without
warning, and Mauritius keeps no DST, so a time window has one fixed offset
to get right rather than two. Put to the operator rather than assumed;
answer was to leave both for now.

---

### The signature popup really was broken on mobile — the wrong bug this time ✅

**Two rounds ago this same modal was checked against a report and found
already correct; it was not this time.** On a phone whose browser chrome
(address bar, home indicator) was showing, `height: 100dvh` — sized to
whatever is actually visible, the fix this modal already had — should have
been enough, but an embedded or older mobile browser with no `dvh` support
fell back to the line before it, `height: 100vh`, which on mobile Safari
means the viewport with that chrome hidden: taller than what was actually
on screen. The bottom bar carrying "Use this signature" ran off the bottom
of a box the officer could not tell was oversized, and the only way to
reach it was to pinch the whole page out until the box shrank enough to
show it — which read, and was reported, as the popup sitting "above the
form" rather than replacing it.

`print.astro`'s `.sig-modal` now sizes itself with `position: fixed;
inset: 0` alone — no height named at all, so there is no vh/dvh figure to
get wrong on any browser; the browser stretches it to whatever is actually
visible, chrome included, on its own. The canvas's own `min-height: 40vh`
is gone too — a `min-height` is a floor `flex: 1` may not shrink below, so
on a short viewport it was pushing the bar after it out past the bottom
independently of how the modal itself was sized; `flex: 1 1 0` with
`min-height: 0` lets the canvas give up space first if the two bars ever
need more of it than a short screen has to spare. `overscroll-behavior:
contain` stops a scroll that runs past the top or bottom of the modal from
chaining into the page behind it, which read the same way — the form
"showing through" what was meant to be a full-screen takeover.

---

### Pinch-zoom was still breaking the signature box, and the print form itself ✅

Fixing the box's own sizing (previous entry) was not the whole story: the
page around it could still be pinched in or out, and a `position: fixed`
element is pinned to the browser's LAYOUT viewport during a pinch-zoom, not
the zoomed-in visual one. Left pinched-in from reading the form, the box
rendered at its full size in that layout viewport but only a slice of it
fell inside what pinch-zoom was actually showing on screen — reachable, if
at all, by dragging the page sideways to bring "Use this signature" into
view from off the right edge. The same zoom made the print form itself feel
"resizable" rather than the fixed sheet it is meant to be.

`print.astro` now serves its own `<meta name="viewport">`
(`maximum-scale=1.0, user-scalable=no`) instead of the app-wide one every
other page still gets — nothing on a form meant to be signed and printed
benefits from zooming into it, and the box drawn on top of it needs the
viewport to hold still to stay usable. `Meta.astro` and `BaseLayout.astro`
both take an optional `viewport` override for this, defaulting to the
existing app-wide value everywhere else.

---

### Six more items: signatures, documents, the timeline bar, and full screen ✅

- **The line under Applicant and Nominee now carries their actual name and
  today's date**, not the instruction "Name and date" — the system already
  has both, so there is nothing left for the signatory to write in by hand
  there. Witness 1 and Witness 2 sign for the society, not for anyone this
  form has a record of, so their lines are untouched.
- **The signature canvas now survives a rotation.** Turning the device
  mid-signature used to leave the drawing surface sized for whichever
  orientation was current when the modal opened; `resize` and
  `orientationchange` now re-measure it and redraw whatever was already on
  it at the new size, in both directions.
- **The DRAFT watermark is gone** from the printable form, on officer
  request.
- **A member's Documents section is now just a name and a View button** —
  the status badge, filed-by, verified-by, version count, expiry and
  rejection reason (the working detail that belongs to reviewing a document,
  not to glancing at what is on file for someone) are gone from this
  summary. It also now names **who captured the founding application** —
  the Regional Officer, per the FRD's capture step — next to "joined" and
  the application reference (`loadMember`, a join to `app_user` no
  different from the one `loadApplication` already does for the same
  field).
- **The timeline and the Back / All applications / Printable form bar below
  it now read as one card**, not two — a white one over a grey one, with a
  gap between. The bar takes the timeline's own background and border
  colour, docks flush against its bottom edge, and the two share a single
  rounded corner radius. `ApplicationTimeline.astro` and all three pages
  that render it changed together, since the coupling (this bar always
  follows that component) is what the fix relies on.
- **A full-screen toggle** sits next to the theme switch in the header
  (`FullscreenToggle.astro`, the ordinary Fullscreen API) — more screen for
  the application and less for the browser around it on a small device,
  which is most of them in the field. Removed entirely, not just hidden,
  where the API does not exist. **Superseded two entries down** — replaced
  with an installable PWA before this reached anyone.

---

### The merged timeline card stopped being sticky past its own height ✅

The previous entry's fix for the "two cards, not one" look — wrapping
`ApplicationTimeline` and the nav bar in a shared `<div>` so a zero-gap,
matching-colour seam could sit between them — broke the thing it was
sitting on top of: `position: sticky` sticks only within its element's own
**containing block**, and that wrapping div's height was nothing more than
the timeline and the bar themselves. Once the page scrolled past that (a
few hundred pixels), both ran out of room to stick within and scrolled
away with the rest of the page — sticky for a moment, then gone, which is
what "should be sticky ... always visible when scrolling" was reporting.

The wrapper is gone. Timeline and nav bar are siblings again, directly
inside the page's own full-height container, so they have the whole page
to stick within like every other sticky element here. The zero-gap seam
between them now comes from `mb-0` on the timeline section instead —
Tailwind wraps its `space-y-*` utility's own margin in `:where()`
specifically so an ordinary class can always override it, which is what
lets one `mb-0` cancel the gap without a wrapper doing it structurally.
Checked by rendering the actual compiled CSS in a browser and scrolling
past ten screens of content — stuck at the top throughout, not just for
the first few — rather than trusting the specificity argument alone.

---

### Full screen swapped for an installable app ✅

Told the full-screen toggle (previous entries) was not wanted — a phone
that can install the app onto its home screen gets the browser chrome out
of the way permanently, which is what full screen was reaching for one tap
at a time. `FullscreenToggle.astro` and its two icons are gone.

In its place: a web app manifest (`public/manifest.webmanifest`, icons
generated from the existing favicon at the sizes Android and iOS actually
ask for, plus a padded maskable variant so a circular home-screen mask
doesn't clip the wreath) and a minimal service worker
(`public/sw.js`) — required by Chrome and Android before either will offer
"Add to Home Screen" at all, even though nothing here works offline or
caches anything; a stale cache of a form an officer is filling in is worse
than no offline mode. `BaseLayout.astro` registers it; `Meta.astro` links
the manifest and carries the two `*-mobile-web-app-capable` tags iOS and
Android each read on their own.

---

### Three officer-feedback items: the hidden admin menu, filing the signed form automatically, and a cash ceiling ✅

**The sidebar's own menu had no scroll of its own.** `<nav>` inside the
fixed-position sidebar had no `overflow-y-auto`, so once a System
Administrator's own menu (Roles, Staff accounts, Configuration, Reset test
data, Migration, Audit log, Reports, Notifications, API, API credentials)
overflowed a shorter screen, the tail of it was clipped with nothing to
scroll — reachable only by zooming the whole page out, which is what "I
have to zoom out to see it" was actually describing. `overflow-y-auto` and
`min-h-0` on the nav (the latter needed because a flex child does not
shrink below its content's own height by default, which is what was
pushing the overflow onto the fixed parent instead of into a scrollbar).
Reproduced and fixed the only way worth doing either: at a short viewport,
screenshotted with the fix reverted (the tail of the menu genuinely
unreachable) and again restored (the same items now scroll into view).

**The signed application form files itself.** `docs/documents.md` has the
detail; in short, once the Applicant has signed on screen at step 2, Next
renders the page into a PDF and files it, so step 3 opens with nothing left
to upload for it. Built on two new small client-side modules
(`src/lib/client/pdf.ts`, `src/lib/client/document-upload.ts`) rather than a
server-side renderer — a headless browser in a Vercel function is heavy, and
a second place that has to agree with what the officer actually saw on
screen is worse than none. `html2canvas-pro` rather than the base
`html2canvas`: the latter's colour parser predates `oklch()`, which is how
Tailwind v4 — every page here, print.astro included — expresses its
palette, and it throws rather than renders. Found by actually generating a
PDF and reading the error, not by inspecting the dependency list.

**A hard ceiling on cash, and the paper Source of Fund form becomes an
on-screen one.** `docs/payments.md`'s own "Cash" section has the detail.
`payment.cash_maximum` (default 500,000, config_entry, the same pattern
`payment.cash_source_of_fund_threshold` already used) is checked ahead of
everything else in `applyCashPaymentRules`, refusing a cash payment above it
outright — the officer is not authorised, and nothing on the Payments page
can override that. Above the older, lower threshold, the confirmation
checkbox is replaced by `CashSourceOfFundForm.astro`: a checklist
(`payment.cash_source_of_fund_checklist`, the Society's own wording, seeded
with one placeholder item since a compliance checklist is not this
codebase's to invent) the officer works through and signs, filed to
SharePoint through the same PDF-and-upload path the signed form now uses.
Shared, not copied three times, even though the payment form's surrounding
markup already was (`[id].astro`, `account.astro`, `customer.astro`) —
signing on screen is exactly the kind of fiddly, easy-to-drift-in-one-copy
logic that is worth a shared component even where the codebase otherwise
tolerates duplication.

Verified against a real database on all three application kinds — a plain
membership application, an existing member's additional account, and a
non-member's own — not assumed identical because the diffs matched: each
walked end to end with a real signature and a real generated PDF captured
off the wire, ending in an issued receipt.

---

### Seven more from the branch: what submits an application, what a status says, and printing what was filed ✅

**Recording a payment stopped submitting the application.** The previous
round made the receipt submit for processing by itself, on the reasoning
that nothing else stood between it and the next person. What the branch
actually experienced: take the payment, open the receipt to check it, come
back — and the application has left their queue without anyone having
decided that. Removed from all three kinds; `docs/payments.md` records why
the earlier reasoning did not survive contact with the officers using it.
The explicit Submit path is untouched, and the end-to-end test that used to
accept "submitted either way" now expects the button.

**An NIC in flight is an NIC taken.** The duplicate check looked only at
approved identities — `member` and `customer` — on the reasoning that an
application still in progress was not yet "on file". It is: two applications
carrying the same NIC collide at approval instead, which is later and
worse. `findNicHolder` now also names the application already carrying it
(any status but `rejected`, which is the one outcome that genuinely frees
it again), excluding the application being checked and the source customer
an S-614 conversion legitimately shares an NIC with.

**A status names a stage, never a person.** "Submit for Approval" said no
more about the President holding a file than `new` said about the Secretary,
so `reviewStageLabel` answers for every non-capture stage in the chain
rather than only `new`; a draft still names nobody, because "Draft" already
says whose it is. And the line is gold and bold for whoever's own role is
holding it — read off `pendingApplicationIds`, the same query that already
sorts those rows to the top and feeds the nav badge, so the highlight cannot
disagree with the count.

**Print, on what was filed.** A document can be printed from the viewer, on
an application's KYC step and on a member's page alike. It needed a
same-origin route to the bytes (`GET /api/v1/documents/content`): the viewer
renders SharePoint's own pre-authenticated URL, and a cross-origin frame
will not take `window.print()` — nor will SharePoint let a script fetch the
file to re-host it, sending no CORS headers. The viewer and its Print now
live in one `DocumentViewer.astro` rather than in four copies that had
already drifted apart in their comments.

**A member's application reference opens what the reviewers said.** Where
the Secretary or the President wrote a comment on the way to approval, the
reference on the member's page is a link to a small closable dialog holding
them; where neither wrote anything, it stays plain text rather than
promising a box with nothing in it.

**Filing the signed form is its own button, and keeps one version.** Filing
rode on "Next: upload documents →", so an officer merely passing back
through step 2 filed a second copy nobody asked for. It is now a button of
its own, and where a signed form is already on file, filing removes it
(`POST /api/v1/documents/remove`, wrapping the same `removeFiledDocument`
the Remove button already ran) before uploading the replacement — otherwise
SharePoint's `rename` conflict behaviour leaves a pile of near-identical
copies a digit apart and "the signed form" stops naming one thing. Removal
runs first, so a failure there never creates the second copy. The one
document type that works this way, deliberately: a re-signature withdraws
the earlier signature rather than scanning it more clearly.

---

### A regression to own, the Cash Deposit Form as it is on paper, and four smaller fixes ✅

**The payment script had been deleted, and two reports were the same bug.**
Extracting the document viewer into a shared component (previous entry) took
the payment script with it on all three application pages — the script
extraction matched on a blank line and ran past the end of the block it meant
to remove. What the branch saw was two separate faults: the total stopped
updating as an amount was typed, and the Source of Fund form "disappeared".
Both were `recomputeTotal`, which computes the one and unhides the other.
Restored from the commit before, byte for byte rather than retyped, and the
diff against that commit is empty for every line of it. The lesson is
recorded here rather than in a comment: an automated edit that finds its
boundaries by counting blank lines has no way to tell a block's end from a
paragraph break, and the typecheck passed both times because the deleted code
had no callers left to complain.

**The Source of Fund form is the Society's own Cash Deposit Form.** Migration
0062 seeded a placeholder list because the wording had not been given; it has
now, and 0063 replaces it with the paper form's own — Trade/Business, Sale of
Property, Cash Gift, Other — leaving a Society that has already written its
own list alone. The generated PDF is laid out as the paper one is, down to
the bordered name/amount/date/purpose block and the Anti-Money Laundering
declaration, so the filed copy and the pad on the counter read the same.
"Relationship with A/C holder" is the one line deliberately dropped, per the
branch. The applicant signs it, not the officer: it is a declaration about
whose money this is.

**A signature is now cropped to its ink.** A full-screen pad exported whole
is a small mark on a very large transparent image, which scales to nothing on
a signature line — which is exactly how the first filed Cash Deposit Form
came out. `trimmedSignature` (`src/lib/client/signature.ts`) crops first, and
treats an untouched pad as nothing signed. Both pads use it.

**View could not show a PDF.** The viewer pointed its frame at SharePoint's
own pre-authenticated URL, which comes back as
`Content-Disposition: attachment` — so the frame downloaded the file instead
of rendering it. It now uses the same-origin `/api/v1/documents/content` the
Print button already had. Images still come straight from SharePoint: `<img>`
ignores the disposition header, and there is no reason to pay for the bytes
twice.

**The printed form's action bar.** Print moved to the top right, in the
header's own column rather than floated over the corner, where it covered
the reference. Back sits hard left, "Upload to sharepoint" — renamed from
"File this signature again" — centred on the page, and Next hard right, laid
out as three grid columns so the middle button stays centred whatever the
two either side are called.

**The login background.** `public/background.jpg` was replaced by
`Background.jpg`; the page still asked for the lowercase name, which serves
locally on a case-insensitive disk and 404s on the deployed one.

---

### The Cash Deposit Form becomes a page, and four fixes to how documents are worked ✅

**A form nobody could read is not a form they signed.** The Cash Deposit Form
was a box on the Payments step: the applicant was handed a screen showing a
button and a line of small print, and asked to sign. It is now a page of its
own, `/applications/<id>/source-of-fund`, laid out and worked exactly as the
printed application form is — the whole sheet, the purposes and the
source-of-funds list ticked on it, signed at the bottom with the same
full-screen pad (Clear, Use this signature), filed when it is right. What
stays on the Payments step is only the gate: one link out while the form is
needed, with the receipt held until it is filed — the submit disabled, not
merely warned about — and, once it is, the file named with View and Delete
beside it, so an applicant who signed in error signs again. The amount
travels to the form in its link, off the same live Total the receipt will
carry, so the figure signed for and the figure receipted cannot differ.

**Printing an image sent three or four sheets to the printer.** The browser
prints raw bytes at natural size, so a phone photograph of an A4 page came
out split — 4 pages for a 900×3600 scan, measured, and 1 once wrapped. The
print frame now puts an image inside a minimal page of ours that tells it to
fit. A PDF still goes to the endpoint directly: it carries its own page
boundaries.

**Verifying a document threw the reviewer back to the top of the page.** Six
documents meant scrolling back down five times. Each form posts to its own
document's anchor, so the response lands on the item just decided — no
script, and better than restoring a pixel offset, since deciding a document
changes its own height. The reason box is revealed by Reject and nothing
else; verifying never needed one. The Verify/Reject controls moved into
`DocumentReviewForm.astro` rather than a fourth copy of this logic — and,
having deleted a payment script by matching on blank lines last time, this
extraction matched on the markup itself.

**A minor's form says so.** "MINOR" is stated at the top of the printed
sheet, where whoever picks it up reads it first: that form is worked
differently — a guardian signs alongside — and nothing on it said so.

**"Printable form" is gone from the timeline bar.** Not needed: the wizard's
own signature step leads there.

### The cash ceiling, a lost amount, a pad with no way out, smaller scans ✅

**Over the ceiling, the refusal is all there is.** A cash total above
MUR 500,000 used to ask for a Source of Fund form and say the payment was
not authorised, in the same breath — preparing a payment that cannot be
taken however well it is answered. The reminder, the link to the form and
the Source of fund field are now hidden once the ceiling is crossed; what is
left is the refusal and a disabled submit. The server still refuses on its
own: a screen deciding what to show is not a control.

**The amount survives the round trip to the Cash Deposit Form.** Going to
the form and back re-rendered the Payments step from the fee schedule's
defaults, so the typed amount — and the cash method that made the form's
button appear at all — were gone on return. The half-finished form is kept
in `sessionStorage` per application and restored before the step's first
recalculation, and cleared the moment a payment is recorded.

**The signing pad had only Cancel.** On a 2x screen the canvas's own height
attribute is twice the viewport, and a flex item will not shrink below its
content — so the bottom bar, Clear and "Use this signature" both, was pushed
off the bottom of the page with no way to reach it. One `min-height: 0`; the
bars no longer shrink either.

**A photographed document is shrunk before it is filed.** Re-encoded on the
device to JPEG at a 2400px long edge, which is more than enough to read a
form and a fraction of what a phone camera produces — measured, a 1.1 MB
scan filed as 725 KB. The file goes up untouched when there is nothing to
gain, and nothing in it can fail an upload.

**A corporate application's form says so**, the way a minor's already did.

### A guardian's own page, a PDF on a phone, and four smaller fixes ✅

**A guardian's page names the children.** "Guardian of" lists everyone this
member or customer is recorded as the guardian of, each a link to their own
page — the approved ones and the applications still on the way through,
since the guardian is equally responsible for either. Matched on the two
things a guardian is ever identified by, the Member No. or the NIC typed
into the minor's own guardian block, so a guardian recorded before they were
themselves a member is still found once they are one.

**A filed PDF opens on a phone.** View gave an empty box on a tablet: no
mobile browser renders a PDF inside a frame. Where the browser says it has
no viewer, the dialog offers Open document instead and the device's own
full-screen reader takes it — better for reading an A4 form than a box in a
dialog. Print goes with the frame, since what cannot be rendered cannot be
printed either.

**The author of an application cannot verify its documents.** Segregation
only asked who filed each document, which left the capturing officer free to
sign off a scan a colleague had uploaded. The refusal is in the service; the
controls are hidden from them as well.

**The Source of fund field is gone from the Payments step.** The filed form
carries the reason, ticked and signed. The column stays for what earlier
receipts recorded.

**A payment reference is asked for only for cheque, transfer and mobile
money.** Cash and card settle with nothing to write down.

**Open other account lands on Applicant details**, not on the signature step
— and, for a minor or a corporate holder, shows the parent/guardian and the
nominee there, so the officer can see who stands behind the account without
opening the holder's page in another tab.

### Total funds, who the depositor is, and a way off Vercel ✅

**Total funds counted only the first deposit** for a non-member who had
opened a second account. The customer arm of the sum read the one
application that created the customer; a second account is its own
application with its own id, so its money counted as nothing. Joined through
`account.opened_by_application_id` now, exactly as the member arm already
was — and the member arm's own cases were checked rather than assumed: a
member opening an account after joining, a customer converting to a member,
and a migrated opening balance all already summed correctly, each covered by
a test.

**The depositor is the guardian, or the contact person.** A Minor cannot pay
in for themselves and a registered entity is not a person. One rule
(`depositorFor`) serves the receipt and the Cash Deposit Form, so the two
cannot disagree; both still name the account as well as who paid.

**The Source of Fund form reaches the people it concerns** — the chain
deciding on the application, and the member's own payment history. It was
readable only from the Payments step of the application that took it.

**An Azure-only path off Vercel is written down** (`docs/deployment-azure.md`):
the adapter swap, the services, the domain, and every environment variable
with its secret and dev-only status. Two things it surfaced are worth
knowing on their own: `package.json`'s `start` script is `astro dev`, which
would serve production from the dev server on a host that honours `npm
start`; and every security header this app sets lives in `vercel.json`, so
moving off Vercel drops the CSP and HSTS silently unless they move into
`src/middleware.ts` first.

### Two hosts, one repository ✅

**Test stays on Vercel; production goes to Azure.** `astro.config.mjs` picks
its adapter when the build runs — the node adapter by default, Vercel's when
`VERCEL=1` (which Vercel sets itself) or `DEPLOY_TARGET=vercel`. The default
is the Azure build deliberately: a pipeline that loses its variable then
still builds production correctly and breaks Test instead.

**The `start` script no longer runs the dev server.** It was `astro dev`,
which Vercel never invokes but App Service would have, serving production
from the development server.

**The security headers moved out of `vercel.json` and into
`src/middleware.ts`**, so both hosts get them. Applied around the existing
guard, so a redirect to `/login` and an API refusal carry them too; HSTS only
over HTTPS. A test reads the list out of the source — the wiring was proved
against a running server, this is what stops a header quietly disappearing.

**CI builds both targets**, since `verify:routes` reads what the Vercel
adapter emits and an adapter that stops compiling should fail there rather
than in the deployment pipeline.

**`docs/deployment-azure.md` was rewritten for someone who has never opened
the Azure portal** — numbered steps, what each thing is for, what you should
see after each one, and a symptom-to-fix table.

---

# M7 — Legacy migration ✅

**Goal:** the existing register becomes members in this system, phase-wise —
**members first, finance later**, per your direction.

**Needs first:** the cleansed extract from Al Barakah. The legacy register
analysis records five blockers and the field gaps; none is this system's to
fix, and the import cannot start until the source is agreed and frozen.

**Shipped, first increment** (business direction: added directly, no review
or approval, every row Approved): a System Administrator's own "Migration"
menu (`system.migrate_members`) downloads an Excel template — one sheet per
membership type that does not need a guardian already on file — and imports
a filled-in one, creating each row as an approved member with the legacy
code kept as a cross-reference (S-705) and the same accounts an ordinary
approval opens. Covers the shape of S-702 (mapping is the live field
configuration, not hardcoded), S-703 (validate before anything is written,
the full outcome reported), S-704 (every rejected row named with why), S-705
and S-706.

**Shipped, second increment** (officer feedback): the template's AB Number
column carries the member's own number from the legacy register into
`member.member_no` directly, rather than reassigning the next one off the
sequence — the sequence is advanced past it so an ordinary approval never
collides with a number the register already used (S-705's own acceptance
criterion). Importing a legacy code already on file updates that member's
applicant details and joined date instead of being refused as a duplicate,
so a detail typo'd the first time can be corrected on a later upload. S-709's
opening balances — Shares, the MSA deposit, and any other account type a row
names one for — are recorded as one payment against the member's founding
application, method `migration` so it reads as what it is (S-708) rather
than a counter transaction nobody took; a balance not yet known is simply
left blank and added on a later upload, per this milestone's own "members
first, finance later" order.

**Shipped, third increment** (officer feedback): not everyone in the legacy
register is a Member. A row naming an AB Number is one — Shares and the MSA
always come as a pair (S-309), so the AB Number alone says so; a row naming
none, only an account of its own (HSA, Investment, …), is a non-member and
imports as a customer instead (S-614's own distinction), `customer.legacy_code`
(migration 0049) its own cross-reference the same way a member's already
is. Every such account — a member's own included, correcting the second
increment's own gap — carries its own legacy number rather than reading the
member's, and its balance is mandatory wherever its number is given: naming
an account without knowing what is in it is not the same "not yet known" a
wholly unmentioned one is.

**Shipped, fourth increment** (officer feedback): Legacy Member Code is now
optional for a member row — an AB Number is already the system's own
unambiguous reference, so it is used as the legacy code when the column
itself is left blank, and stays mandatory only where there is no AB Number
to fall back to (a non-member row). Nominee 1 and Nominee 2 columns appear
on any sheet whose type configures a `nominee` subject, mirroring the live
capture form's own S-602 relaxation exactly: the first nominee is mandatory,
a second never is, and a re-import that leaves Nominee 2 blank leaves
whatever is already on file for it alone rather than clearing it. Minor is
eligible now — its guardian resolves the same way problemsBlockingSubmission
already does (an existing member, or an Individual application still on its
way to becoming one), so a guardian has to already be on file before their
minor is imported, and its own Takaful beneficiary is left for the member's
record to fill in later, the same way Employment Details already is. NIC,
mobile and account number are each checked unique to one member or
non-member — against the rest of the batch and against everyone already on
file, migrated or not.

**Shipped, fifth increment** (officer feedback): the Minor sheet asks only
for the Guardian Member ID now — surname, name, NIC and mobile are pulled
straight from the guardian's own record on import instead of retyped, the
same S-604 resolution as before, just no longer asking the officer to
repeat what the guardian's own record already says. Relationship to the
minor has no such source and is left for the member page's own edit
affordance. The Takaful beneficiary, left for later in the fourth
increment, is now captured in full alongside the guardian — every
beneficiary field a type configures, always mandatory where the row is a
member's.

**Shipped, sixth increment** (officer feedback): Nominee 1 is now mandatory
for a non-member row exactly the same as a member row — the fourth
increment's own "at least one Nominee" relaxation was member-only by
accident of the AB-Number-needed check sitting next to it, not by actual
business direction; a customer (non-member) row on a sheet whose type
configures a `nominee` subject now writes its Nominee 1/2 the same way a
member row does.

**Shipped, seventh increment** (officer feedback): the Individual sheet now
carries the applicant's own Occupation and Employment status as optional
columns — the two Employment Details fields the legacy register actually
holds — imported onto the same `employment` party the member page reads and
edits (Employment status a dropdown restricted to the configured choices,
the same guarantee the capture form's own `<select>` gives; Employer name
and Monthly income are not migrated, there being nothing in the register to
fill them from). At the same time a Nominee's Telephone and Email columns
are dropped from every sheet — not carried in the register either — while
Nominee Mobile and every other nominee field stay. Both changes are keyed
by field key in `migration/members.ts`, so a relabel in configuration does
not shake them loose.

**M7 is closed.** S-708 and S-710 shipped in the third increment (the batch
audit event and balance reconciliation), and the business has since decided
that **S-701 and S-707 are not needed**: the import works against whatever is
uploaded and reports every rejected row, so a separately agreed and frozen
extract, and a formal promote-after-sign-off step, are process the Society
does not want.

**S-709 is delivered**, and more generally than its title reads. The import
template carries a `Shares Balance` and an `MSA Deposit Balance` column, and
generates a `<Account Type> Balance` column for **every account type the
Society configures** — so a Haj savings account gets one the moment an
administrator adds that account type, with no change here. A row naming an
AB Number must fill both `Shares Balance` and `MSA Deposit Balance` (0
where there is nothing; a 0 records no payment line and uses no receipt
number), and the header cells carry that as a note; a non-member's row
leaves them blank. Balances are
written as one opening payment per member (`recordMigrationOpeningBalances`),
itemised exactly as an ordinary payment is.

**Loan balances, which S-709's title also names, are not imported — and could
not be.** Phase 1 models no financing at all: there is no loan, no repayment
schedule and no liability anywhere in the schema, and the word appears nowhere
else in this backlog. A loan balance is not an account balance, so there is
nothing for the import to write it to. That is a scope boundary rather than a
gap in the importer, and it belongs to whatever phase introduces financing.

### S-701 · Agree and freeze the cleansed source extract — not needed

**As** the project, **I need** one agreed source file, **so that** an import
can be repeated and reconciled against something fixed.
`Must · 3 · EPIC-14`

- Recorded with a checksum, so "the file we imported" is unambiguous

### S-702 · Column mapping and validation rules for members

**As** the project, **I need** each source column mapped and validated,
**so that** what fails is known before anything is written.
`Must · 8 · EPIC-14`

- Mapping is configuration, not code, so a re-cleansed source needs no release
- Mobile numbers convert to international form on the way in, using the same
  rule as capture — an unconvertible number is an exception, never a guess

### S-703 · Staging import with dry-run

**As** the project, **I need** to import into staging and see the outcome
before committing, **so that** a bad import is discovered before it matters.
_(MIG-US-001)_
`Must · 8 · EPIC-14`

- **Given** a dry run **Then** nothing is written and the full outcome is
  reported
- Runs on the job runner from M1, resumable and checkpointed

### S-704 · Exception report for records failing validation

**As** the project, **I need** every rejected record with its reason, **so
that** Al Barakah can correct the source.
`Must · 5 · EPIC-14`

- Exportable, one row per problem, identifying the source record

### S-705 · Preserve the legacy member code as a cross-reference

**As** staff, **I need** the old code kept, **so that** a member can be found
by what the Society has always called them. _(FRD 7.12)_
`Must · 3 · EPIC-14`

- Searchable, and distinct from the Member ID this system allocates
- The member number sequence must be advanced past anything the register
  already contains, so no imported member can collide with a new one

### S-706 · Mark migrated members as a distinct state

**As** staff, **I need** migrated records identifiable, **so that** an
incomplete legacy record is not mistaken for a complete application.
`Must · 5 · EPIC-14`

- **Given** a migrated member **Then** the missing fields are listed rather
  than silently blank

### S-707 · Promote to production after business sign-off — not needed

**As** the project, **I need** an explicit sign-off before production import,
**so that** the decision is deliberate and recorded. _(decision 3)_
`Must · 3 · EPIC-14`

### S-708 · Log the import as a traceable audit event

**As** an auditor, **I need** the import recorded, **so that** it is
distinguishable from ordinary data entry. _(FRD 7.12)_
`Must · 3 · EPIC-11`

- Source checksum, counts, who authorised it, when

### S-709 · Later pass — shares, savings and Haj balances ✅ (loans: no such concept in Phase 1)

**As** the Society, **I need** balances imported once members exist, **so
that** the financial position follows the people.
`Must · 8 · EPIC-14`

### S-710 · Reconcile imported totals against the agreed control figures

**As** the Treasurer, **I need** imported totals to match agreed figures,
**so that** the import is provably complete.
`Must · 5 · EPIC-14`

- **Given** any control total differs **Then** the import is reported as failed
  reconciliation, whatever the record counts say

---

# M8 — Resignation & dormancy — Phase 2 ✅ dormancy shipped as M22

**Deferred to Phase 2, and now built there.** Resignation (S-801 to S-803)
is superseded in full by M17's S-1703, per the Phase 2 FRD's Section 2 — the
stories below are kept for the record and are not to be built as written.
Dormancy (S-804 to S-806) is not in the Phase 2 FRD; Phase 2 made the status
real and blocking (S-1701, S-1501), and M22 is what sets it. Phase 2 open
point 3 is closed by the default the backlog assumed.

**Shipped as M22** (S-804, S-805, S-806). Activity is anything that moved
money on a member's accounts — a posted ledger entry or a fee payment —
with the day they joined as the floor (and, since officer feedback, never
before the day the record came into this system: a migrated member's old
Joined Date made one with nothing to carry dormant the first night;
migration 0093 reactivated those, audited); one SQL expression
(`LAST_ACTIVITY_SQL`, `src/lib/members/dormancy.ts`) says so for the job
and the report alike. The nightly **`dormancy-detection`** job marks an
active member dormant after `dormancy.months` of nothing (migration 0086,
seeded 12; Configuration → Fee schedules; 0 turns it off): dated, audited
as `member.dormancy_detected` with the job as the actor, and the member
told by `member.dormant` (email and WhatsApp wording, editable). A second
run finds nothing. **Reactivation** is the backlog's default until the
Society confirms a rule: an officer holding `member.reactivate` (Account
and Regional Officers, the Regional Manager, the Secretary), on the
member's page, with a reason that goes on the trail
(`member.reactivated`) and to the member; `dormancy.reactivation` names
the rule (`staff`, the only one there is) so another later is a value, not
a release. Reactivation is itself no activity: a member who comes back and
does nothing goes dormant again. The **Dormancy** report (Membership;
`member.view`) lists who is dormant and, by default, the active members
within a chosen number of months of the threshold, with their last
activity, months since, and the day they go — or went — dormant; it is
the dormancy report S-906 left out until there was something to show.
Both settings are on Readiness.

**Goal:** a member can resign through the approval chain, and dormancy is
detected rather than noticed.

**Needs confirming first:** the reactivation rule (S-805). Default until then:
flag for staff action.

### S-801 · Capture a resignation request with reason

**As** staff, **I need** to record a resignation request, **so that** it
enters the approval chain. _(RES-US-001, FRD 7.9)_
`Must · 5 · EPIC-15`

### S-802 · Obligation checks that block closure

**As** the Treasurer, **I need** outstanding obligations to block closure,
**so that** the Society is not owed by a closed member. _(FRD 7.9)_
`Must · 5 · EPIC-15`

- **Given** any outstanding balance **Then** approval is refused with the
  amounts listed

### S-803 · Secretary review and President approval of resignation

**As** the Society, **I need** resignations to follow the same chain as
applications, **so that** one governance model covers both. _(FRD 7.9)_
`Must · 5 · EPIC-06`

- Uses the workflow configuration from M2, with its own definition
- Segregation of duties applies as it does to applications

### S-804 · Scheduled dormancy detection ✅

**As** the Society, **I need** dormancy detected automatically, **so that**
the rule is applied evenly. _(DOR-US-001, FRD 7.11)_
`Must · 8 · EPIC-15`

- Threshold is configuration
- Runs on the job runner from M1, resumable over a large membership

### S-805 · Configurable reactivation ✅

**As** an administrator, **I need** the reactivation rule configured, **so
that** it can change without a release. _(decision 6)_
`Must · 5 · EPIC-15`

- **Depends on** the confirmed rule. Default until then: flag for staff action

### S-806 · Approaching-dormancy report ✅

**As** staff, **I need** to see who is close to dormancy, **so that** they can
be contacted first.
`Should · 3 · EPIC-12`

---

# M9 — Notifications, reporting & public API

**Goal:** members hear from the Society, staff can report on it, and
Albarakah.mu can submit applications.

**Shipped, second increment** (S-902, S-903, S-904, and S-901's remaining
screen): the channels are real, the events are wired, a failed send is retried
and a failure is visible.

**Migration 0053 had never once applied anywhere.** PostgreSQL concatenates
two string literals separated by a newline, but the `E''` prefix is only legal
on the FIRST literal of such a group — `'plain'` then `E'escaped'` on the next
line is a syntax error — and four of the five seeded templates were written
that way. Rejected at parse time by every PostgreSQL, on every database,
whatever is already in it: so unlike 0030 (the same class of bug) this could
not even in principle have applied somewhere and recorded a checksum, M9's two
tables existed nowhere, and nothing after 0053 could ever have been reached.
`scripts/migrate.test.ts` already covered it — it applies the real migration
files — so the suite was red. The bodies are joined with `||` instead, where
each operand may carry its own prefix, and `verify-migrations.sh` grandfathers
the file with that evidence, since a new migration cannot fix a file that will
be re-attempted and fail forever.

**S-902, S-903.** Email leaves through the Society's Microsoft 365 mailbox,
reusing the registration documents already use (`GraphCredentials` is split
from `GraphConfig` because a mailbox has no document library); both channels
also speak to a plain HTTP gateway, posting the shape the member app's
one-time codes already post so one gateway can carry both. A channel nobody
has configured now **refuses** — it used to write to the server log and report
success, which is `'sent'` against a notification nobody received — and the
log channel is unavailable in production. Events are raised in `workflow.ts`
after the commit, never inside it; only a return is news to the applicant, and
a sign-off that has not reached quorum notifies nobody. Migration 0054 adds
`account.*` wording, because welcoming an existing member to Al Barakah, or
telling a non-member their membership has been approved, are both wrong in a
way the member notices. Contact details come from the application — there is
no email or mobile column on `member` — and a minor's guardian is written to,
under the minor's name.

**S-904.** `next_attempt_at` (0055) is what makes a retry safe: the sender
asks one indexed question, what is due now, and the backoff is arithmetic
rather than state a job would lose on restart. 5m, 15m, 1h, 6h, 24h, giving up
after six attempts — a little over thirty hours, so an overnight outage still
delivers next morning. Giving up marks the row `abandoned` rather than
deleting it. A row still `pending` was never marked either way, so it is
picked up on age after ten minutes' grace, which tells an orphaned send from
one still in flight. What is re-sent is the text stored on the row, never a
re-render: editing wording must not change what a member was already told.
The delivery log is **/admin/notifications**, behind its own permission (0056)
rather than `audit.view`'s. Found while building it: the retry path resolved
channels straight from configuration and silently ignored a registered one, so
the first attempt and the retry could disagree about the provider; resolution
now happens in exactly one place.

**S-901's own screen** is Configuration → Notification wording. It refuses a
placeholder the event does not fill in, naming the ones it does: a slot with
no value renders as nothing, so `{{member_number}}` for `{{member_no}}` would
reach a member as "Your member number is ." with nothing saying why. A test
holds the seeded wording and the code to that same contract.

**Still to do in M9:** S-905 to S-907 (reports) and S-908, S-909 (the public
application API).

**Shipped, first increment** (S-901): the notification service exists and is
provider-independent. `notification_template` is a configuration table like
any other — an administrator writes the wording, the trigger from migration
0010 records who changed it, and a write that cannot name its actor is
refused. `notification` is the outbox: one row per intended send, carrying
the subject and body **as they were rendered at the time**, so editing a
template never rewrites what a member was already told. `notify()` picks up
whichever channels an event has an active template for, skips a channel the
recipient has no address for, and never throws — an approval that succeeded
is not reported as failed because a relay was down. Until a real provider is
registered the channel writes to the server log, which exercises the whole
path; S-902 and S-903 register email and WhatsApp behind the same interface,
and S-904 adds the retry schedule and the staff-facing delivery log. Still to
do for S-901 itself: the administrator's own editing screen. _(All of which
the second increment above has since done.)_

### S-901 · Provider-independent notification service with templates ✅

**As** the Society, **I need** notifications independent of any one provider,
**so that** changing provider is configuration. _(decision 11)_
`Must · 8 · EPIC-10`

- Templates are configuration; channel is a detail behind one interface

### S-902 · Email channel for the events in FRD Section 9 ✅

**As** a member, **I need** to be told what happened to my application,
**so that** I am not left waiting. _(FRD Section 9)_
`Must · 5 · EPIC-10`

### S-903 · WhatsApp channel — membership approved ✅

**As** a member, **I need** approval by WhatsApp, **so that** I hear promptly.
_(decision 11)_
`Must · 8 · EPIC-10`

- Sends to the international-form number captured in M3, which is why that
  conversion happened at capture rather than being deferred

### S-904 · Notification delivery log and retry ✅

**As** staff, **I need** to see whether a notification arrived, **so that** a
silent failure is not mistaken for a member ignoring us.
`Must · 3 · EPIC-10`

- **Given** a send fails **Then** it is retried on a schedule and the failure
  is visible until it succeeds or is abandoned

**Shipped** (S-905, S-906, S-907): nine reports, at **Reports**, in three
groups — Membership, Finance and Operations.

One shape for all of them, so the page renders any report without knowing
which and adding one is a definition rather than a screen. Every report offers
the same table on screen and the same download as Excel: a report that cannot
leave the screen is half a report, because the committee papers and the
auditor both want a file and the alternative is somebody retyping figures.

**Access is the existing access.** A report names an EXISTING data permission
— `member.view`, `payment.view`, `audit.view` — and `report.view` only reaches
the page. Reporting is a second way to read data that is already governed, so
giving reports their own permissions would build a parallel scheme that
drifts: the day somebody forgot to bar a role twice is the day a report became
the way round it. The check is made again on the report's own page and on its
export, so a URL typed by hand is not a way past it.

**S-907's named report** is Access and actions: the audit trail summarised by
actor and action, with refusals counted. The audit log page already lists
every entry; what a report adds is the shape — who is doing the most, and
whether anybody is being refused repeatedly. Alongside it, Scheduled work
shows whether the jobs actually ran, which `docs/jobs.md` notes nothing
currently notices.

**The dormancy report S-906 names arrived with M22**, once a rule decided
dormancy and a job applied it: a report over a state the system did not
have would have shown an empty table reading as "nobody is dormant" rather
than "this is not built yet", which is worse than not offering it.

### S-905 · Membership, document and account reports ✅

`Should · 8 · EPIC-12`

### S-906 · Payments and receipts reports ✅ (dormancy waits on M8)

`Should · 5 · EPIC-12`

### S-907 · Operations and audit reports ✅

`Should · 5 · EPIC-12`

- Includes an access-and-actions report over the audit trail, which is what
  makes the trail useful rather than merely present

**Shipped** (S-908, S-909): Albarakah.mu can submit an application, and the
endpoint it submits to is protected.

A third kind of caller exists now — a machine holding a credential, after
staff with a cookie and the member app with a token.
`defineIntegrationEndpoint` is its wrapper: same descriptor, same envelope,
same log line. Nobody is present when it calls, so the checks a person's own
caution would cover are structural. The credential is read from the database
on every request and never cached, so revoking one stops it on its very next
call. Refusals are recorded rather than only logged, by reason, because a
credential being tried and failing is the signal that someone is probing.
Every way of being wrong returns the same 401, so a list of client ids cannot
be sorted into real and invented. The limit is per credential at its own
ceiling, with an address that has not yet authenticated limited separately
and hard.

The secret is 32 random bytes, stored only as a SHA-256 and shown once. A
credential the system could show again is one a copy of the database hands
over; re-issuing takes a moment.

The submission itself goes through `startApplication` and `saveDraft` — the
same services an officer's screen uses — so the field configuration, the
phone normalisation and the reference allocation cannot diverge from the
branch's. It lands in `received`, where a member-app submission lands, because
a website can neither file the signed form nor take the payment: the officer
completes the checklist and submits it into the chain. Fields are validated
against the type's live configuration; a rejected submission leaves nothing
behind, and a number with an application already open is refused before
anything is created — otherwise a website with a wrong form would fill the
officer's queue with drafts nobody asked for.

### S-908 · Public application API for Albarakah.mu ✅

**As** an external applicant, **I need** to apply from the website, **so
that** joining does not require visiting an office. _(MEM-US-002, FRD 7.3)_
`Must · 8 · EPIC-13`

- Creates a draft application through the same service the staff screens use,
  so the two cannot diverge
- **Given** a public submission **Then** it enters the same chain, with the
  same required documents

### S-909 · API credentials, throttling and abuse protection ✅

**As** the Society, **I need** the public endpoint protected, **so that** it
cannot be used to flood or probe the system.
`Must · 5 · EPIC-13`

- Rate limiting reuses the mechanism from M1 (S-111)
- **Given** the limit is exceeded **Then** the caller is refused with a
  retry-after, and the refusal is recorded

---

# M10 — Hardening and go-live

**Goal:** the system is ready to be relied on.

**Needs confirming first:** KYC and audit retention periods. Default until
then: retain indefinitely, which is safe but not compliant with a stated
policy — so this is the one open value that should not stay open. It is no
longer a blocker on code, though: S-1003 makes the periods configuration, so
the Society states its policy by entering it.

**Started** (S-1001, S-1002, S-1003, S-1005). What is code or writing is done;
what needs the Society, an external tester or Azure is named as such.

**S-1001** — `docs/security-review.md` records a manual review of the whole
application: what was examined, what was found sound, and what only an
external test can cover. It found one real defect, now fixed. `CaptureFields`
rendered search results by interpolating an applicant's own typed name into
`innerHTML`, and anyone who can start an application can type one — a member
of the public through the app's own sign-up, and the website through S-908. It
fired in a member of staff's browser with that officer's access.
`src/lib/access/html-sinks.test.ts` fails the build if any HTML sink comes
back, and was itself checked by reintroducing the original line. The external
test is still needed for the deployed environment, the tenants, authenticated
business-logic abuse and denial of service.

**S-1002** — `docs/restore.md` has the procedure, and
`pnpm figures:capture` / `pnpm figures:verify` turn a drill into a pass or a
fail: twenty control figures including the money total and the high-water
marks for member number, receipt serial and financial event sequence, because
a restore that lost a day still has plausible counts. **The drill itself has
not been run**, so the recovery time is unknown — that is the story's actual
acceptance criterion and it needs Azure.

**S-1005** — `docs/runbook.md`: the shape of the system, first moves on any
report, symptom-by-symptom diagnosis, the routine jobs, what each secret
breaks when rotated, escalation, and an explicit list of what is deliberately
not automated.

**S-1003** — the mechanism, with every period unset. `retention_policy`
(migration 0061) carries one row per class of record that can be disposed of;
**Configuration → Retention** sets a period against each, behind its own
`retention.manage` permission rather than `config.manage`, and shows beside it
**how many records that period would dispose of today** — a number of months
has no visible consequence until somebody can see what it destroys. The
`retention-disposal` job honours whatever is set, in bounded passes, auditing
every disposal under `retention.disposed` without recording what it disposed
of. Unset means retain indefinitely, so merging this changed the behaviour of
nothing.

Three classes can be disposed of: the notification log (the row goes — it is
the personal data), an application that was not approved (the applicant's
details, documents and SharePoint files go; the reference and the date it was
refused stay), and a draft nobody submitted (it goes entirely, through the
officer's own delete path and its refusals).

**Two are deliberately absent, both recorded in `docs/retention.md`.** A
member's own KYC documents cannot be anchored yet: the period runs from the end
of the relationship, and resignation and closure are M8. And the audit trail
cannot be disposed of at all — migration 0004's trigger refuses UPDATE, DELETE
and TRUNCATE on `audit_event` and migration 0005 revokes the privileges too.
Honouring a period on audit records means narrowing both of those deliberately,
which is a decision for the Society with its cost stated, not a consequence of
a backlog line mentioning audit. It is put to them rather than taken.

**Still needing the Society:** the retention periods themselves and the audit
question above (S-1003), S-1004's real staff accounts, and the external test.

### S-1001 · Penetration test and remediation — review done, external test outstanding

`Must · 8 · EPIC-01`

### S-1002 · Backup and restore, proved by an actual restore — procedure and verification ready, drill outstanding

**As** the Society, **I need** a restore that has been performed, **so that**
the backup is known to work rather than assumed to.
`Must · 5 · EPIC-01`

- **Given** a restore drill **Then** the recovered system is verified against
  known figures, and the time taken is recorded

### S-1003 · Retention and disposal policy applied — mechanism done, periods outstanding

**As** the Society, **I need** records disposed of once they are past their
retention period, **so that** nothing is held longer than the policy allows.
`Must · 5 · EPIC-11`

- **Given** no period is set **Then** nothing is disposed of, which is the
  state this ships in
- **Given** a period **Then** the screen shows how many records it would
  dispose of before it is saved
- **Given** a disposal **Then** it is recorded in the audit trail, naming what
  went and never copying it

### S-1004 · Provision real staff accounts and roles — the test for it exists

**As** the Society, **I need** the real people set up with the right roles,
**so that** go-live is not the moment access is first tested. _(decision 15)_
`Must · 3 · EPIC-02`

`docs/functional-testing.md` and the suite behind it (`pnpm e2e`) walk the
whole application-to-member journey against a deployment as **five different
people**, because segregation of duties means they have to be: the officer who
captures may not review, and the Secretary may not approve. So provisioning the
accounts is what makes the suite runnable, and the suite is what proves the
provisioning. It also prints what each role can and cannot open, which is the
answer to "did we grant that correctly" that nothing else gives.

Still needs the Society: the accounts themselves, in the Test Entra tenant.

### S-1005 · Operational runbook and handover ✅

`Must · 5 · EPIC-01`

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

# Product backlog — Phase 2

Decomposition of the Phase 2 Functional Requirements Document — Customer
Transactions — into milestones and user stories, in the same shape as Phase
1's. Sequencing is by dependency, and the first milestone is a walking
skeleton: one deposit, end to end, on a real ledger.

- **Source of truth for requirements:** Phase 2 FRD v1.0 (Draft), Sections
  1–21. Its stories are numbered ACC-, TXN-, APR-, RCT-, CLS-, RES-, DEM-,
  CSH-, BNK-, API-, ENG-, UX-, CFG- and NOTIF-US-nnn; the traceability table
  at the end maps every one.
- **Source of truth for what exists:** the schema in `migrations/`, not the
  Phase 1 FRD. Where the FRD assumes something Phase 1 was written to do and
  the code does it differently, the code wins and the difference is recorded
  below under **What the FRD assumes, and what is actually there**.
- **Supersedes:** M8's resignation stories (S-801 to S-803) in full, per FRD
  Section 2. M8's dormancy stories (S-804 to S-806) are not in this FRD and
  stay deferred — see open point 3.

## How this backlog is elaborated

Stories for **M13–M15** carry full Given/When/Then acceptance criteria: the
ledger, the approval matrix and the three everyday transactions are what gets
built first, and their criteria are what a first sprint is planned against.
Stories for **M16–M21** have enough definition to sequence and estimate, and
are refined at the start of the milestone that contains them — the same rule
Phase 1 followed, for the same reason.

Estimates are the Phase 1 scale (relative Fibonacci, for sequencing, not for
dates). Priority is FRD Section 18: every TXN-, ACC-, APR-, RCT-, CLS-, RES-
and DEM- story is Must; the cashier module is Should; export polish is Could.

## What Phase 1 already delivers

The FRD was written assuming Phase 1 as specified. Phase 1 as **built** gets
Phase 2 further than that, and in three places it already answers a Phase 2
story outright. None of these is re-done.

| Phase 2 needs                                             | Phase 1 has                                                                                                                                                                            | Consequence                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Shares and MSA opened together, inseparably (ACC-US-002)  | Migration 0018: both account types are `is_membership_default`, both opened at approval, one number for the person and both accounts                                                   | **Done.** ACC-US-002 is traced to S-309/0018                                                            |
| One account of each type per member (ACC-US-007)          | `account_one_per_type_per_member_idx`, 0018                                                                                                                                            | **Done** for the single-instance case; multi-instance HSA is open point 5                               |
| Opening HSA or Investment for a member (ACC-US-003)       | M11 additional-account applications, S-612/S-613, on the membership chain                                                                                                              | **Done.** The chevron it uses is the one M14 generalises                                                |
| A configurable, editable approval chain (APR-US-009..012) | `workflow_definition` + `workflow_step` (0010): steps assigned to roles, `is_enabled` to remove one without deleting it, `quorum_count`; `activeChain` reads it live on every decision | **The chain exists.** Phase 2 adds the _matrix_ that selects one, and the transaction status vocabulary |
| Segregation of duties on approvals                        | `segregation_rule`, keyed by `entity_type`                                                                                                                                             | Reused with `entity_type = 'transaction'`                                                               |
| A chevron that reflects the live chain (UX-US-005)        | `ApplicationTimeline.astro` renders whatever `TimelineStep[]` it is given; only the _producer_ (`applicationTimeline`) is application-specific                                         | Generalise the producer; the component is reused unchanged                                              |
| Cash cap and Source of Funds threshold (TXN-US-003, -011) | `payment.cash_maximum`, `payment.cash_source_of_fund_threshold`, `payment.cash_source_of_fund_checklist` (0062), Administrator-editable, with the SOF form as a checklist document     | **Done for payments.** Deposits read the same three entries                                             |
| Sequential, voidable receipts with gap detection (RCT-)   | `receipt_number` (0017): serial + generated `RCT-000001`, states allocated/issued/abandoned/void, S-506 reconciliation view                                                            | Extended to transactions; the number is never reused                                                    |
| Structured financial events for Phase 5 (ENG-)            | `financial_event` (0017), one self-contained payload per payment/refund/void                                                                                                           | `event_type` widened — by a new migration, 0017 is on `main`                                            |
| Nominee to default the claimant from (DEM-US-001)         | S-602 nominee capture; S-607 Takaful beneficiary                                                                                                                                       | Read, not rebuilt                                                                                       |
| Notifications, templates, retry, delivery log (NOTIF-)    | M9: `notify()`, per-event templates, channels, `next_attempt_at` retry, `/admin/notifications`                                                                                         | NOTIF-US-006 is done; Phase 2 adds event codes and wording                                              |
| Reports with export (Section 13)                          | `src/lib/reports/definitions.ts`, S-905–S-907, Excel export                                                                                                                            | New definitions in the same file                                                                        |
| Two actor types on one API framework (API-US-003)         | `defineEndpoint` (staff cookie) and `defineMemberEndpoint` (member bearer token) share one envelope, rate limiter, log line and audit trail                                            | Same engine behind both; open point 9 records the surface decision                                      |

## What the FRD assumes, and what is actually there

The FRD's Section 21 says every open point is resolved. Six things the code
raises are not in it, because the FRD could not see the code. Each has a
default the stories below are written to; each is listed again, with its
default, under **Phase 2 open points**.

1. **There is no balance anywhere.** Phase 1 records what was paid
   (`payment`, `payment_line` per fee component) and never a balance —
   "opening payment less refund" is the nearest thing, computed on the fly.
   The ledger is new, and every existing member's Shares and MSA must open
   with the money Phase 1 already took from them, or every balance starts at
   zero. That backfill is S-1303, and its acceptance criterion is a control
   total.
2. **`member.status` has no constraint.** It is `text` with a default. Phase
   2 adds `resigned` and `demised` and the constraint that names the whole
   vocabulary — nothing today would refuse a misspelling.
3. **Dormancy is referenced, not delivered.** The FRD blocks withdrawals on a
   Dormant member (TXN-US-005) and cites Phase 1 Section 7.11, but detection
   is M8's S-804, deferred, and this FRD does not schedule it. Phase 2 makes
   the status real and blocking; nothing sets it.
4. **Payment methods are a check constraint**, not configuration
   (`payment.method in ('cash', 'cheque', 'bank_transfer', …)`, 0017). FRD 6.6
   wants Juice, Salary Deduction, Standing Order, Deposit at Bank and Internet
   Banking, addable without a release. That is a table, and a migration that
   maps today's codes onto it.
5. **A transfer to a non-member has nowhere to land.** FRD 6.4 lists "another
   member, a non-member, or Other" as destinations; a non-member has no
   account to credit. Default: a transfer whose destination is not an account
   on the system is a debit leg and a disbursement out — one movement, not
   two — and a credit leg exists only when there is an account to credit.
6. **Receipts by email need a link, not an attachment.** M9's channels carry
   text; nothing attaches a file, and a PDF of a member's transaction in a
   mailbox is personal financial data at rest somewhere the Society does not
   control. Default: the message carries a link to the receipt on the site,
   which FRD 11.1 allows ("or a link to retrieve it"). WhatsApp media is
   Should.

## Epic index

| Epic    | Title                                              | Milestone | Priority |
| ------- | -------------------------------------------------- | --------- | -------- |
| EPIC-17 | Account Structure                                  | M13       | Must     |
| EPIC-18 | Transaction Engine — Deposit, Withdrawal, Transfer | M13 → M15 | Must     |
| EPIC-19 | Approval Matrix & Dynamic Workflow                 | M14       | Must     |
| EPIC-20 | Receipts & Statements                              | M16       | Must     |
| EPIC-21 | Account Closure                                    | M17       | Must     |
| EPIC-22 | Resignation                                        | M17       | Must     |
| EPIC-23 | Demised Member Handling                            | M17       | Must     |
| EPIC-24 | Cashier / Teller                                   | M20       | Should   |
| EPIC-25 | Bank Accounts & Reconciliation Foundation          | M19       | Must     |
| EPIC-26 | Mobile-Ready API Layer                             | M13, M21  | Must     |
| EPIC-27 | Unified Transaction Engine                         | M13       | Must     |
| EPIC-28 | Consistent Workflow UX                             | M14       | Must     |
| EPIC-29 | Configuration Readiness                            | M18       | Must     |
| EPIC-30 | End-User & Staff Notifications                     | M18       | Must     |

---

# M13 — The ledger, and one deposit end to end

**Goal:** money exists. Every account has a balance derived from an immutable
ledger, every existing member's Shares and MSA open with what Phase 1 already
took from them, and an officer can record a deposit that posts, receipts and
appears on the member's page — the walking skeleton every later milestone
hangs from, built the way Phase 1's M3 was.

**Why the ledger comes first and alone:** FRD 6.1's single engine is a
property that is either true from the first line or never true afterwards. So
M13 builds the engine with exactly one transaction type on it, proves the
database refuses any other route to a balance (S-1302), and only then adds
types. A deposit below the escalation threshold needs no chain, which is why
it — and not a withdrawal — is the skeleton.

**Needs confirming first:** open point 1, the mapping from Phase 1 fee
components to opening balances. Default: `shares` lines open the Shares
balance, `msa_deposit` lines open the MSA balance, everything else (entrance,
processing, Takaful) is income and opens nothing. The backfill is written to
that default and its control total will say whether the Society agrees.

**Shipped, first increment** (S-1301, S-1302): the ledger exists, and the
database is the thing that says how money moves on it.

Migration 0064 adds `transaction` (one kind so far, `deposit`; each later
milestone widens the check as it adds one), `account_entry` (immutable — the
trigger and grant shape `audit_event` has had since 0004) and
`account_balance`, a cache of the entries' sum maintained inside
`post_transaction()` in the same database transaction, so the two cannot
disagree by a crash between them. `ledger_drift()` finds any other
disagreement and `rebuild_account_balance()` resolves it from the entries;
the nightly `ledger-verify` job asks and audits each repair as
`ledger.repaired`, naming both figures, because a cache that drifted once is
a bug somewhere. Direction is the account holder's: a credit raises the
balance, a debit lowers it. `docs/ledger.md` has the rest.

**The grant is the architecture.** `albarakah_app` holds no insert, update
or delete on `account_entry` or `account_balance` at all; `post_transaction()`
is `security definer`, owned by the schema owner, and is the only road in.
`scripts/schema.test.ts` asserts every one of those denials, so FRD 6.1's
"no transaction type may be implemented as a one-off balance update outside
this engine" fails the build, not a review. Everything atomic about posting —
entries, cache, status, one `transaction.posted` on `financial_event`, one
audit row — is in that function, so "half posted" is not a state that can
exist. `financial_event` gained a second subject: `payment_id` nullable,
`transaction_id` added, exactly one set, by a new migration rather than an
edit to 0017.

**Found while building it:** `pool.query()` hides every driver error behind
"the database is unavailable", which is right for a page and wrong for a
function whose refusals are the caller's business — a draft, a closed
account, an unnamed actor. The ledger's writes go through a client instead,
and `restrict_violation` and `no_data_found` come back as a `LedgerError`
carrying PostgreSQL's own message; nothing else is caught. Every guard
honours the test-data reset's flag, and the reset test proves it reaches all
three tables.

Nothing creates a transaction row yet. This increment changes the behaviour
of nothing on its own; the deposit that first uses it is S-1305's own change,
as M11's schema-first phase was.

**Shipped, second increment** (S-1304): each account type now carries what
the engine will read before it moves money. Migration 0065 adds
`minimum_balance` (one floor — FRD 4.3 is explicit that a withdrawal and a
transfer do not have separate ones), `allows_deposit`, `allows_withdrawal`,
`allows_transfer` and `maximum_transaction_amount` (null for no limit; zero
is refused, since that is what the switches are for). Nothing is blank on
day one: every type defaults to a floor of 0, everything allowed and no cap,
and Shares' floor is set from its opening minimum — the 5000 of 0018 — at
migration time. All five are on Configuration → Account types, on both
forms, and the existing configuration trigger audits them with the rest of
the row; the reference API returns them. In `AccountTypeInput` they are
optional: omitted means the column default on create and unchanged on
update, so the dozen existing callers with no opinion on limits did not
change, while the screen always sends all five, so an emptied cap there
means cleared. Enforcement is deliberately not here — a floor is read by a
withdrawal (M14) and a transfer (M15), a cap and the switches by every
kind, and each arrives with the kind that needs it.

**Shipped, third increment** (S-1303): Phase 1's money is on the ledger.
Migration 0066 carries every unvoided receipt over — a `shares` fee line
becomes a deposit on the Shares account the application opened, an
`msa_deposit` line on the MSA, and (wider than the story's wording, because
that is what the data holds) a `payment_account_line` on the account of its
type, which is how an HSA or Investment opening deposit and an imported
balance of any other type were recorded. Entrance, processing and Takaful
open nothing. A refund line becomes a **reversal** of the deposit its
original became: `reverses_id` and the `reversal` kind are S-1505's
mechanism (decision 13), arrived early because a refunded Shares line has
no other honest way onto a balance. The carried transaction references the
receipt it came from — 0064's one-receipt-one-transaction rule is narrowed
to receipts issued at posting, since one membership receipt pays into two
accounts — names who took the money and when, and posts whatever the
account's status, because the money is already there. One function,
`post_opening_balances()`, does it for one application at a time; the
backfill calls it for every application with accounts in the order the
money arrived, and every live path that might give an account something to
carry — the four account-opening paths, the legacy-balance import, a refund
— calls the same function, so it is one-time only in the sense that the
second call finds nothing. A migrated legacy balance is already a payment
with lines, so "never both" needed no rule. Found on the way: 0064 gave a
transaction a member and only a member; a customer's HSA had nowhere to
land, so a transaction is now a member's or a customer's, exactly one. A
void of a receipt already on a balance is refused in favour of a refund.
`pnpm figures:capture` carries the Shares and MSA balance totals, and the
backfill test asserts they equal the issued, unrefunded lines. The backfill
posts as a fourth service account, `migration@system.albarakah.mu`.

**Shipped, fourth increment** (S-1307): payment methods are configuration.
Migration 0067 adds `payment_method` — code, name, `is_cash`,
`requires_reference`, `touches_bank`, `is_system`, `is_active`, sort order —
audited by the trigger every configuration table carries, seeded with
today's five under their existing codes, the FRD's six additions and the
import's own `migration` (system: never offered, not editable), and turns
`payment.method` and `transaction.method` into foreign keys to it, dropping
0017's check constraint. The constant and the label map in `payments.ts`
are gone: a `Payment` carries `methodName` beside its code, so a receipt by
a method since retired still says how it was paid. The three payment forms
and the refund form render their options from `offeredPaymentMethods()`,
each option carrying `is_cash` and `requires_reference`, and the page
script reads those instead of a list of codes — so a new method with a
reference gets the field, and the cash controls, with no release. The
server holds the same line: a method that is not offered is refused, and a
method that requires a reference is refused without one, on a payment and
on a refund alike (refunds had never validated their method at all). The
reference API returns the offered methods for the mobile app. Deposits
(S-1305, next) read the same table. Built first, ahead of the deposit
itself, because the deposit form's cash and reference rules hang off it.

**Shipped, fifth increment** (S-1305, S-1308; S-1306 in part): an officer
records a deposit, and it is on the ledger with its receipt before they let
go of the button. `recordDeposit()` (`ledger/deposits.ts`) decides in order
— the idempotency key, the method, the cash controls, the destination — and
refuses before writing, naming the rule: the holder or the account not
active, the type's `allows_deposit` off, its `maximum_transaction_amount`
exceeded. Then one database transaction: the `transaction` row,
`post_transaction()`, the receipt issued; a failure inside abandons the
number with the reason, as a payment does. The page is
`/members/{id}/deposit`, reached from the person's own page, for a member
or a customer alike; the endpoint is `POST /api/v1/deposits`. S-1308:
`defineEndpoint` gained `idempotent: true`, which demands the
`Idempotency-Key` header and documents it; the service keeps a fingerprint
beside the key (0068), answers a repeat with the original and refuses a
changed request with 409; the form issues its key on render, so a refresh
after a success cannot post twice. S-1306: the ceiling and the threshold
apply to a cash deposit through the very function a payment calls, reading
the same three entries — one control, not two; the deposit records the
officer's confirmation (`source_of_fund_form_confirmed`). The rest of
S-1306 — the form as a filed document for a deposit, verified before the
post — arrived with M23, once documents could be keyed to a transaction
(M17). `transaction.capture` (0068) is the
permission, held by whoever holds `payment.record`; the rest of the
transaction permissions are S-1311's.

**Shipped, sixth increment** (S-1309, S-1310): the balance is where an
officer looks, and nothing derives one from payments any more. The
member's page shows each account's balance from the cache, with a link to
`/accounts/{id}`: every posted entry newest first, fifty a page, each with
the balance after it computed from the entries in SQL, the method, the
receipt, the note and who captured it — `accountEntries()` grew those
columns and a one-line description ("Opening deposit", "Refund",
"Deposit", "Reversal of TX-…"). `GET /api/v1/accounts/{id}/balance` and
`GET /api/v1/accounts/{id}/history` (paged by `before`) join
`POST /api/v1/deposits`, all through `defineEndpoint`, behind
`payment.view` until S-1311 gives money its own permissions. The stand-in
that read "opening payment less refund" is gone from everywhere it lived:
`transactionsForAccount` (the Members list's dialogue and
`/accounts/{id}/transactions`), the member app's `/me/accounts` balance
and `/me/accounts/{id}/transactions`, and the Members list's Total funds —
each now reads the ledger, and the payment tests that built an account by
hand now carry its receipt the way approval does. The deposit page and the
endpoint already shared one service function, as S-1310 asks.

**Shipped, seventh increment** (S-1311), and M13 closes: money has its own
permissions. Migration 0069 adds `transaction.view`, `transaction.post`,
`account.view` and `receipt.void` beside 0068's `transaction.capture`,
creates the three Section 5 roles Phase 1 never needed — Clerk, Account
Officer, Auditor — with no members, and maps the defaults: Clerk and
Regional Officer capture, Account Officer and Regional Officer post
(at a regional counter the officer who takes a deposit posts it),
Treasurer voids, Auditor views; `account.view` rides on `member.view` and
`transaction.view` on `payment.view`, so nobody lost a figure. The history
page and the three account endpoints moved from `member.view` and
`payment.view` onto `account.view`, and the member page hides the balances
without it. A deposit — one act, no chain — now needs `transaction.post`
as well as capture; a Clerk holding capture alone is told to ask an
Account Officer, until M14's chain hands a capture on. The capture path
writes `transaction.captured` to the trail before the engine writes
`transaction.posted`, and three `segregation_rule` rows key on it: the
officer who captured may not approve, may not post through a chain, may
not void the receipt. Nothing consults them yet on the one-act deposit;
M14's post and approve actions and S-1505's void do. M13's one open end
was S-1306's filed Source of Fund document for a deposit, closed by M23.

**Officer feedback, after M13:** a **Transactions** page (sidebar, under
Finance) with a card per kind — Deposit, Withdrawal, Transfer, Resignation,
Closure, Demise; only Deposit is live, the others are on the page already,
unavailable, so the shape does not change as they arrive. Deposit there
starts from the account type and its number — the member's AB number for
Shares and the MSA, the account's own number for an HSA or Investment
(`findAccountByNumber`) — and lands on the same deposit form the person's
page opens, with that account chosen. On the person's page the button is
now **Deposit**, in the top banner beside "← All members", where the other
kinds will join it; it is no longer in the Accounts section.

---

# M14 — The approval matrix, on the chain that already exists

**Shipped, first increment** (S-1401; S-1402 and S-1406 in part): the
matrix exists and deposits obey it. Migration 0070 adds the transaction
status vocabulary to `workflow_status`, one Secretary → President
`workflow_definition` per kind — deposit, withdrawal, transfer, closure,
resignation, demise — on the tables applications already use, so
Configuration → Workflows edits them with no new screen; `approval_rule`,
ordered within a kind, first match wins, a rule with no chain meaning "post
at once", seeded to FRD 6.5's table with a 100,000 threshold that is the
band on the rule (FRD 9's configurable value, edited on Configuration →
Approval matrix rather than kept in step from somewhere else — a placeholder
for the Society to confirm, open point 15); and `transaction_transition`,
`application_transition`'s shape plus the rule and chain that routed it.
`resolveRoute()` reads the matrix and falls back to the most demanding
chain for the kind when nothing fits; `submitTransaction()` posts at once
or leaves the transaction at the first enabled step, recorded. A deposit
above the threshold is now submitted, not posted: no receipt until it
posts, the step it waits at on the confirmation, and a Clerk holding
capture alone can record one. The tests prove a disabled Secretary step
sends the next large deposit to the President (S-1402's live chain).
**Shipped, second increment** (S-1403, S-1404; S-1402 complete): the
queue and the screen that act on what waits. `/transactions/pending` lists,
for any kind, what stands at a step the person's role owns, what is
approved for them to post, and their own captures a reviewer returned;
`/transactions/{id}` is one screen for all of it — details, Forward (Approve
at the last step), Return and Reject with their mandatory comments, Post,
and the correction form — with the trail underneath. Two permissions,
`transaction.review` and `transaction.approve`, by position on the chain
rather than by step name, so a re-shaped chain needs no release (0071);
one more segregation rule, the captor may not review. Where a transaction
stands is read against the live chain: a step disabled under a queued item
moves it to the next role's queue, which is S-1402's last criterion, now a
test. Approval decides and posting moves the money — a separate act, by
someone with `transaction.post` who did not capture it, where a deposit
takes its receipt. A returned deposit is its captor's to correct; it
re-enters at the step that returned it, or, when the amount crossed a band,
takes the route a first submission would (decision 11), posting at once
included. **One departure from the story as written:** the sidebar badge on
Transactions counts the transactions, and the one on Applications keeps
counting applications — a badge counts what its own link opens, rather than
one number that leads to only half of what it counts.

**Shipped, third increment** (S-1405, S-1406) — M14 complete: the chevron
on a transaction is its chain as configured now. `src/lib/workflow/timeline.ts`
holds the step shape and the one-current rule both timelines use;
`applicationTimeline` is one caller of it and `transactionTimeline` the
other, reading Recorded → the enabled steps → Posted off the live chain and
the trail, so a deposit routed nowhere shows no approval stage and a step
disabled today leaves every chevron from then on. `ApplicationTimeline.astro`
became `ChainTimeline.astro`, unchanged but for a screen-reader label. The
trail on the transaction page is the log, not the chain — a disabled step
it passed is still there — and the audit log labels the same acts under the
transaction's reference, which the transaction page answers to directly.

### S-1301 · The account ledger ✅

**As** the Society, **I need** every movement of money on an account to be
one immutable row, **so that** a balance is something the history proves
rather than a number a program keeps. _(ENG-US-001, ENG-US-002, FRD 3, 6.1)_
`Must · 8 · EPIC-27`

- **Given** a posted transaction **Then** it has produced one `account_entry`
  per account it touched (a deposit one, a transfer two), each carrying the
  account, the transaction, the direction, the amount and the posting time,
  and none of them can be updated or deleted — the same trigger and grant
  shape `audit_event` has (0004, 0005)
- **Given** an account **When** its balance is asked for **Then** it is the
  sum of its entries, and `account_balance` — one row per account, updated in
  the same database transaction as the entries — is a cache of that sum, read
  for speed and never trusted over it
- **Given** the cache and the entries disagree **Then** the nightly
  `ledger-verify` job (the M1 runner) says so, loudly, and the cache is
  rebuilt from the entries — never the other way round
- Amounts are `numeric(14, 2)`, as fees already are; a Mauritian rupee has
  cents and floating point does not
- **Depends on:** nothing. This is the foundation

### S-1302 · No other road to a balance ✅

**As** a technical lead, **I need** the database itself to refuse a balance
change that did not come through the engine, **so that** FRD 6.1 is enforced
rather than promised. _(ENG-US-001, ENG-US-003, FRD 6.1, 16)_
`Must · 5 · EPIC-27`

- **Given** the application's own role (`albarakah_app`) **Then** it holds no
  `insert`, `update` or `delete` on `account_entry` or `account_balance` at
  all — the only way in is `post_transaction()`, a `security definer`
  function owned by the schema owner, exactly the pattern `reset_all_test_data`
  and the retention job already use
- **Given** a developer adds a second code path that writes either table
  **Then** `scripts/schema.test.ts` fails, the way it already fails if the
  application role gains DDL — the FRD's "automated check that fails the
  build" is a grant assertion, not a grep
- `post_transaction()` takes a transaction id and does everything atomic
  about posting: entries, cache, status, the financial event, the receipt
  issue — one function, one transaction, so "half posted" is not a state that
  can exist

### S-1303 · Phase 1's money becomes Phase 2's opening balances ✅

**As** the Treasurer, **I need** every member's Shares and MSA to open with
the amounts they actually paid at membership, **so that** the first balance
an officer sees is right. _(ACC-US-004, FRD 4.1, open point 1)_
`Must · 8 · EPIC-17`

- **Given** an approved member with a Phase 1 payment **When** the migration
  runs **Then** each `payment_line` whose fee component is `shares` becomes
  an opening entry on their Shares account and each `msa_deposit` line an
  opening entry on their MSA, dated the payment's date and naming its receipt;
  a refund reverses the lines it refunded
- **Given** the migration has run **Then** the sum of all Shares balances
  equals the sum of all issued, unrefunded `shares` lines — and the same for
  MSA — and `pnpm figures:capture` (S-1002) gains both totals, so a restore
  drill checks them too
- **Given** a member migrated by M7 with a legacy balance (S-709) **Then**
  that balance is the opening entry instead, referenced to the import, and
  the two sources are never both applied to one account
- **Given** a member approved after this migration **Then** approval itself
  posts the same opening entries through `post_transaction()` (S-1305), so
  the backfill is one-time and the live path is the engine

### S-1304 · Account types learn their limits ✅

**As** an administrator, **I need** each account type to carry its floor,
its limits and what is allowed on it, **so that** the rules are configuration
and the engine reads them. _(ACC-US-001, ACC-US-006, FRD 4.3, 9)_
`Must · 5 · EPIC-17`

- `account_type` gains `minimum_balance` (one floor, used identically by
  withdrawal and transfer — FRD 4.3 is explicit that there are not two),
  `allows_deposit`, `allows_withdrawal`, `allows_transfer`, and
  `maximum_transaction_amount` (nullable — no limit)
- **Given** the migration **Then** every existing type has a working value:
  Shares keeps its 5000 opening minimum (0018) and gets a matching holding
  floor; MSA, HSA and Investment get a floor of 0 and all three operations
  allowed — so nothing is blank on day one (FRD 9)
- **Given** Configuration → Account types **Then** each is editable there,
  audited through the trigger every configuration table already carries
  (S-210), and a change takes effect on the next transaction with no release

### S-1305 · One engine, one transaction type: deposit ✅

**As** an officer, **I need** to record a deposit into any account a member
holds, **so that** funds are added under full traceability — and so that
there is now a transaction on the system at all. _(TXN-US-001, ENG-US-001,
FRD 6.2)_
`Must · 8 · EPIC-18`

- `transaction` is one table for every kind: reference `TX-000001` from its
  own sequence, `kind` (`deposit` now; `withdrawal`, `transfer_leg`,
  `disbursement` are added by the milestones that use them, each a
  migration widening the check), member, account, amount, method, status,
  the officer, the region, an optional reason, and the receipt once issued.
  A posted row is immutable — its own trigger, like `payment`'s
- **Given** the officer picks a member (the search S-613 already has),
  enters an amount, picks a method and an account **When** they submit
  **Then** the deposit posts immediately through `post_transaction()`,
  the balance moves, and a receipt is issued — because a deposit below the
  escalation threshold has no chain (FRD 6.2); M14 puts the threshold in
  front of it
- **Given** the account type has `allows_deposit = false`, or the account
  is not active, or the member is not active **Then** the deposit is
  refused before anything is written, naming which
- **Given** a Shares account **Then** it is a valid destination like any
  other — FRD 4.1: Shares is topped up, not paid once
- **Given** the deposit posts **Then** one `financial_event` of type
  `transaction.posted` carries the whole thing, self-contained, the way
  `payment.recorded` does — and `financial_event.event_type`'s check is
  widened by a new migration, never by editing 0017

### S-1306 · Cash controls apply to a deposit as they do to a payment ✅

**Completed by M23.** Cash above the threshold is a request
(`src/lib/ledger/deposit-requests.ts`): a draft the officer starts, the
Source of Fund form — 0062's own document type — signed on screen and
filed against the transaction, and then submitted by the officer who
recorded it: the matrix, the engine, the receipt. (M23 first required a
second officer to verify the form; the Society has since dropped that.) A draft's amount and reason can change
while it is the officer's, and it can be cancelled; the deposit page
continues into the request instead of offering a tick. Open point 17's
"later capture path" for the `draft` status is this one.

**As** the Society, **I need** the Source of Funds requirement and the cash
cap to govern a cash deposit exactly as they govern a cash payment, **so
that** there is one control, not two. _(TXN-US-003, TXN-US-011, FRD 6.7)_
`Must · 5 · EPIC-18`

- **Given** a cash deposit above `payment.cash_source_of_fund_threshold`
  **Then** the SOF form is required — the same checklist document (0062),
  the same print–scan–upload path, the same Missing → Verified lifecycle
  (S-407) — and the deposit cannot post until it is Verified
- **Given** a cash deposit above `payment.cash_maximum` **Then** it is
  refused outright, with the message the payment step already shows
- **Given** any method other than cash **Then** neither applies — the flag
  is on the method (S-1307), not on a list of method names in code
- The three configuration entries are reused, not duplicated: a deposit is
  a payment, and an administrator sets each number once

### S-1307 · Payment methods become configuration ✅

**As** an administrator, **I need** to add a payment method without a
release, **so that** the list matches how members actually pay. _(TXN-US-002,
FRD 6.6, open point 4)_
`Must · 5 · EPIC-18`

- `payment_method` is a configuration table: code, name, `is_cash` (drives
  S-1306), `requires_reference` (cheque number, transfer reference — drives
  BNK-US-002), `touches_bank`, `is_active`, sort order; audited like every
  other configuration table
- **Given** the migration **Then** it is seeded with today's methods under
  their existing codes and the FRD's additions (Juice, Salary Deduction,
  Standing Order, Deposit at Bank, Internet Banking, Other), and
  `payment.method` and `transaction.method` become references to it — the
  check constraint from 0017 is replaced, by a new migration, with every
  existing row mapped
- **Given** a method with `requires_reference` **Then** the reference is
  mandatory on the form and on the record — the Phase 1 rule "show the
  reference only for cheque, transfer and mobile money" becomes data

### S-1308 · An idempotency key on every write ✅

**As** the system, **I need** a retried submission to be the same
transaction and not a second one, **so that** a double-click or a dropped
connection cannot move money twice. _(API-US-002, FRD 3, 16)_
`Must · 5 · EPIC-26`

- `transaction.idempotency_key` is unique per acting user; the form issues
  one when it renders and sends it with the submit
- **Given** the same key with the same payload **Then** the response is the
  original transaction, unchanged, with no new row; **given** the same key
  with a different payload **Then** 409, and nothing is written
- `defineEndpoint` gains the check as a declared property of a write
  endpoint, so `/api/v1/deposits` and every later write endpoint gets it by
  declaration, and the OpenAPI document says so (S-110)

### S-1309 · The balance, where an officer looks ✅

**As** an officer, **I need** to see a member's accounts with their balances
on the member's page, **so that** I can answer the question they came in
with. _(ACC-US-004, TXN-US-007, FRD 6.9)_
`Must · 3 · EPIC-17`

- **Given** the member page **Then** each account shows type, status and
  balance, from the cache (S-1301), with a link to its history
- **Given** an account's history **Then** it lists every posted transaction
  for it, newest first, paginated, with a running balance computed from the
  entries — which is the statement S-1601 later exports
- Balance replaces "opening payment less refund" wherever the member app
  (Phase 4) and the member page showed it

### S-1310 · A deposit is reachable from the API ✅

**As** a developer, **I need** the deposit to be an endpoint like every other
operation, **so that** the API is the product and the page is a client of
it. _(API-US-001, FRD 10)_
`Must · 3 · EPIC-26`

- `POST /api/v1/deposits` (with S-1308's key), `GET
/api/v1/accounts/{id}/balance`, `GET /api/v1/accounts/{id}/history`, all
  through `defineEndpoint`, all in the OpenAPI document, all behind the
  permissions S-1311 defines
- The deposit page calls the same service function the endpoint does — one
  path, as `saveDraft` and the capture pages already share one

### S-1311 · Who may do what to money ✅

**As** the Society, **I need** transaction permissions that match the roles
in FRD Section 5, **so that** a clerk records and a Treasurer voids.
_(CFG-US-003, FRD 5, 12)_
`Must · 3 · EPIC-29`

- Permissions, in the existing `entity.action` form: `transaction.capture`,
  `transaction.view`, `transaction.post` (below-threshold actioning, FRD 6.3
  "Account Officer can action directly"), `receipt.void`, `account.view`;
  the approval-step permissions arrive with M14
- **Given** the migration **Then** the default mapping matches Section 5's
  table — Regional Officer/Clerk capture, Account Officer post, Treasurer
  void, Auditor view — and is editable at Administration → Roles (S-201)
- `segregation_rule` gains `entity_type = 'transaction'` rows: the officer
  who captured may not be the one who posts or approves

---

# M14 — The approval matrix, on the chain that already exists

**Goal:** an administrator decides which transactions need whose approval,
in what order, and can change their mind without a release — and the screen
shows the chain that is live, not the one the front end was built with.

**What is reused, and what is new:** Phase 1's `workflow_definition` and
`workflow_step` already do everything FRD 6.5 asks of a chain — steps
assigned to roles, an ordered sequence, `is_enabled` to remove a step
without deleting it, `quorum_count`, and `activeChain` reading it live on
every decision (S-209, S-611). Nothing in this milestone rewrites that. What
Phase 1 does not have is the _matrix_: the rule that says which chain — or
none — a given transaction falls under, keyed on kind, amount, account type
and the initiating role. That is one table and one function, and the rest is
giving transactions a status vocabulary the existing steps can name.

### S-1401 · The approval matrix ✅

**As** an administrator, **I need** to say which transactions escalate and
to which chain, **so that** routine transactions post and the rest are
reviewed. _(APR-US-001, APR-US-002, APR-US-006, FRD 6.5, 17)_
`Must · 8 · EPIC-19`

- `approval_rule`: transaction kind, optional account type, optional
  initiating role, an amount band (from, to — `to` null for "and above"),
  and the `workflow_definition` it routes to — **or none**, which means
  "post immediately". Rules are ordered; the first match wins; the table is
  configuration, audited like the rest
- **Given** a transaction is submitted **Then** `resolveRoute()` finds its
  rule and either posts it (S-1305's path, unchanged) or places it at the
  first enabled step of the chosen chain — and records which rule and which
  chain, so the trail (S-1406) can say why it went where it went
- **Given** no rule matches **Then** the transaction escalates to the most
  demanding chain configured for its kind — an administrator who forgot a
  band gets a review, never a silent post
- **Given** the migration **Then** the defaults from FRD 6.5's table exist:
  deposits post; withdrawals and transfers-out above a threshold go
  Secretary → President; closures, resignations and demised claims go
  Secretary → President; the threshold is a configuration value (FRD 9)
- Configuration → Approval matrix edits it, with the same "who changed what,
  when" every configuration screen has (S-210)

### S-1402 · A chain per transaction kind, on `workflow_step` ✅

**As** an administrator, **I need** to define an ordered chain of role steps
for withdrawals, transfers, closures, resignations and demised claims, **so
that** governance is a setting. _(APR-US-009, APR-US-010, APR-US-011, FRD
6.5)_
`Must · 5 · EPIC-19`

- A `workflow_definition` with `entity_type = 'transaction'` per kind,
  seeded, each with `workflow_step` rows whose `from_status`/`to_status`
  name the transaction statuses: `submitted` → `under_review` →
  `approved` → `posted`, with `returned` and `rejected` as exits — the
  same shape a membership application's chain has, which is why
  Configuration → Workflows edits it with no new screen
- **Given** a step is disabled or re-ordered **When** the next transaction
  of that kind is submitted **Then** it routes through the chain as it now
  is — `activeChain` already reads live; this story's work is the status
  vocabulary and the tests that prove a removed Regional Manager step is
  skipped by the next withdrawal
- **Given** a transaction already queued at a step **When** that step is
  disabled **Then** it stays there until that role acts on it — verified
  against how `activeChain` treats a disabled step for an in-flight item,
  and made so if it is not (APR-US-012 is the FRD's one explicit rule
  about in-flight work; it is a test before it is a feature)

### S-1403 · Review and decision, one screen for every kind ✅

**As** the Secretary and the President, **I need** one queue of everything
waiting on me and one screen to act on any of it, **so that** I do not learn
six interfaces. _(APR-US-003, APR-US-004, UX-US-004, FRD 6.5, 8)_
`Must · 8 · EPIC-19`

- **Given** a role with a step on any transaction chain **Then**
  `/transactions/pending` lists everything at a step that role owns —
  withdrawals, transfers, and later closures, resignations and claims —
  filterable by kind, with the amount, the member and how long it has waited
- **Given** an item **Then** the review screen is one component
  parameterised by kind: the details, the documents, the trail, and
  **Forward** / **Return with comment** / **Reject with comment** — the
  comment mandatory on the last two, as it is for applications (S-305,
  S-306)
- **Given** the President approves a withdrawal **Then** it moves to
  `approved`, and posting is a separate act by whoever records the
  disbursement (S-1503) — approval decides, disbursement moves money, and
  the two are not the same click
- `pendingActionCount` (the sidebar badge) counts transaction steps too,
  so the President sees one number

### S-1404 · Return, edit, resubmit — at the step that returned it ✅

**As** the officer who captured it, **I need** to correct a returned
transaction and send it back to the step that returned it, **so that** an
approval already given is not asked for twice. _(APR-US-005, APR-US-008, FRD
6.5.1)_
`Must · 5 · EPIC-19`

- **Given** a transaction returned from step _n_ **Then** it is editable by
  its captor only — amount, method, reason, account — and by nobody while it
  sits at any other step
- **Given** it is resubmitted **Then** it re-enters at step _n_, keeps its
  reference, and its trail shows both versions and the comment that
  prompted the change; an application's `reopenRejectedApplication` is the
  pattern, generalised
- **Given** the edit changes the amount across a matrix band **Then**
  `resolveRoute()` runs again and the transaction may go to a different
  chain — the FRD says re-enter at the rejecting step; a changed amount is
  a changed transaction, and the rule that would have applied on first
  submission applies now. Recorded as decision 11

### S-1405 · The chevron reads the live chain ✅

**As** an officer, **I need** the strip at the top of every transaction to
show the steps this one will actually go through, **so that** the screen
and the configuration cannot disagree. _(UX-US-001, UX-US-002, UX-US-005,
FRD 8)_
`Must · 5 · EPIC-28`

- `chainTimeline(entityType, id)` in `src/lib/workflow/timeline.ts`
  produces `TimelineStep[]` for any entity with a chain, from the live
  `workflow_step` rows plus the entity's fixed stages (Details, Documents,
  Submit … Disbursement); `applicationTimeline` becomes one caller of it
- `ApplicationTimeline.astro` is reused unchanged — it never knew what an
  application was — and gains a neutral name in the same change
- **Given** a deposit below threshold **Then** its chevron has no approval
  stages at all; **given** a step is disabled **Then** every chevron
  rendered from then on omits it, with no front-end change

### S-1406 · The trail an auditor reads ✅

**As** an auditor, **I need** the actual sequence of steps a transaction went
through and who acted at each, **so that** governance can be verified after
the chain has changed. _(APR-US-007, FRD 12)_
`Must · 3 · EPIC-19`

- `transaction_transition` mirrors `application_transition`: step, actor,
  action, comment, time, and the rule and chain that routed it — so two
  withdrawals either side of a chain edit show different trails, and both
  are right
- Read-only on the transaction page, and in the audit log under the
  transaction's reference

---

# M15 — Withdrawal and transfer

**Goal:** money leaves an account under the floor, the limits, the matrix
and the trail — and a transfer is two legs under one id, never two
transactions that happen to match.

**Shipped, first increment** (S-1501, S-1502, S-1503): a withdrawal, end to
end. Migration 0072 widens the kind check, teaches `post_transaction()` a
debit that refuses to breach the type's floor, and adds the rule that the
approver may not disburse. `recordWithdrawal()` checks in FRD 6.3's order and
names the first failure — the type, the holder, the available balance, the
floor, the maximum — then the matrix: below the band it is paid out and
posted at once with its receipt, the method's reference demanded now; above
it, capture alone submits it and paying out is `postApprovedTransaction()`'s
separate act once approved, recording the method and reference and dating
the entry the disbursement. `availableBalance()` is the balance less what is
already on its way out, on the form and on the balance endpoint. Withdrawal
in the person's banner, the Transactions card by type and number, the
review screen's pay-out form and correction form, and
`POST /api/v1/withdrawals`.

**Shipped, second increment** (S-1504): a transfer is two legs under one
id. Migration 0073 adds `transfer` (`TR-000001`) and the `transfer_leg`
kind with its direction and, for a payee with no account here, the payee's
name; `post_transaction()` posts a debit leg and then its credit leg in the
same call, so both post or neither, and holds the floor on any debit. The
debit leg is the transaction the matrix routes — as `transfer` between the
same holder's accounts, as a withdrawal when the money leaves their
control — and the chain reviews; the credit leg follows, never queued,
never posted alone, and rejected with it. A payee transfer has one leg and
is paid out at disbursement (S-1503). Transfer in the person's banner, the
Transactions card, the review screen showing the other side and a
correction form for the amount and note, and `POST /api/v1/transfers` with
one key for the pair.

**Shipped, third increment** (S-1505, S-1506) — M15 complete. A posted
mistake is corrected by `reverseTransaction()`: a reversal that names it,
posted through the engine on its own receipt, a transfer whole; the
Treasurer's act (`receipt.void`), with a reason, never the captor's (0074).
Nothing past submission is ever deleted — the guard from 0064 already
refused it — and every state is on the trail. Drafts are not persisted:
a form abandoned before Submit records nothing, which is what the story
asks of a draft, without a row whose generated reference would burn a
number (decision 17). `listTransactions()` is one list across every
account, filterable and paged, a transfer once, on the person's page, on
`/transactions/all` for the day, and at `GET /api/v1/transactions`.

### S-1501 · Withdrawal ✅

**As** an officer, **I need** to record a withdrawal that the engine
validates before anyone approves it, **so that** a request that cannot
succeed is refused at the counter. _(TXN-US-004, TXN-US-005, FRD 6.3)_
`Must · 8 · EPIC-18`

- **Given** a withdrawal is submitted **Then** before it is written the
  engine checks, in order, and names the first failure: the account is
  active and the type allows withdrawal; the member is active — not
  dormant, resigned or demised; the available balance covers it (S-1502);
  the resulting balance is not below the type's floor (hard, FRD 4.3); the
  amount is within the type's maximum
- **Given** it passes **Then** `resolveRoute()` (S-1401) posts it or places
  it on its chain; **given** it posts **Then** the disbursement details —
  method, and the reference the method requires — are recorded on the same
  transaction, and a receipt is issued
- **Given** a Shares account **Then** the floor is the configured holding
  minimum (S-1304), so an officer cannot withdraw a member below membership
  by mistake — resignation (M17) is the way out. Recorded as decision 12
- `kind = 'withdrawal'` is added to `transaction`; `POST /api/v1/withdrawals`

### S-1502 · Available, not merely current ✅

**As** an officer, **I need** the balance I quote to allow for what is
already on its way out, **so that** two withdrawals in one afternoon do not
both pass. _(TXN-US-007, open point 7)_
`Must · 3 · EPIC-18`

- `available = balance − sum(pending debits)` where pending is any
  withdrawal or transfer-out for that account in `submitted`,
  `under_review` or `approved` — a query, not a ledger entry, so a rejection
  releases it by doing nothing
- Shown beside the current balance on the withdrawal and transfer screens,
  and returned by the balance endpoint as a second figure

### S-1503 · Disbursing an approved withdrawal ✅

**As** the Treasurer, **I need** to record how an approved withdrawal was
paid out, **so that** the money moves when it is paid, not when it is
approved. _(TXN-US-004, CLS-US-005 pattern, FRD 6.3, 15)_
`Must · 5 · EPIC-18`

- **Given** an `approved` withdrawal **Then** a holder of `transaction.post`
  records the method and reference, and only then does `post_transaction()`
  run — the ledger entry is dated the disbursement, not the decision
- **Given** the method `touches_bank` (S-1307) **Then** the reference is
  mandatory and, from M19, names which of the Society's bank accounts it
  came from
- Segregation: the approver and the disburser are different people
  (S-1311's rules)

### S-1504 · Transfer ✅

**As** an officer, **I need** to move money between accounts as one
transfer, **so that** the two sides can never be reconciled apart.
_(TXN-US-006, FRD 6.4, open point 5)_
`Must · 8 · EPIC-18`

- `transfer` (id, reference `TR-000001`, member, reason, status) links
  `transaction` rows with `kind = 'transfer_leg'`: a debit leg on the source
  and, **when the destination is an account on the system**, a credit leg
  on it. Posting is atomic across both legs or neither
- **Given** the destination is the member's own account, or another
  member's, or a customer's (S-614) **Then** it is a credit leg and the
  destination account's `allows_deposit` and status are checked too
- **Given** the destination is a non-member or "Other" **Then** there is no
  credit leg: the debit leg carries the payee's name and the disbursement
  method and reference, and posts through S-1503's disbursement step — the
  default in open point 5, because there is no account to credit
- **Given** the source **Then** every withdrawal check in S-1501 applies,
  floor included; **given** the destination is another party **Then**
  `resolveRoute()` treats it as a withdrawal for the matrix (FRD 6.4:
  "funds are leaving the source member's control"); an own-account transfer
  has its own kind in the matrix and posts by default
- `POST /api/v1/transfers`, one call, one idempotency key for the pair

### S-1505 · Drafts, and what a submitted transaction can and cannot become ✅

**As** an officer, **I need** to abandon a mistake before it is submitted and
to know that after submission nothing disappears, **so that** the record is
honest. _(TXN-US-008, FRD 6.5.1, 12)_
`Must · 3 · EPIC-18`

- **Given** a `draft` **Then** its captor can edit or delete it, and it has
  no reference, no receipt and no ledger effect — as an application draft
- **Given** anything past `draft` **Then** it is never deleted: it is
  returned, rejected, or posted, and every state is in the trail
- **Given** a posted transaction was wrong **Then** the correction is a
  reversing transaction that references it (`reverses_id`), through the
  engine, on its own receipt — never an edit. Recorded as decision 13

### S-1506 · Transaction history, across accounts ✅

**As** an officer, **I need** a member's transactions across every account
in one list, **so that** a query is answered from one screen. _(TXN-US-009,
FRD 6.9, 10)_
`Must · 3 · EPIC-18`

- `/members/{id}/transactions` and `GET /api/v1/transactions?member=` —
  paginated, filterable by account, kind, status and date; a transfer shows
  once, with both legs
- The same query, unfiltered, is `/transactions` for a region's own view of
  its day

---

# M16 — Receipts and statements

**Goal:** every movement of money produces a receipt in the sequence Phase 1
started, a member can be given one without a printer, and any account's
statement can be read or exported from the same endpoint the future app will
call.

**Shipped, first increment** (S-1601, S-1603): every transaction has taken
its receipt from the one sequence since M13, issued when it posts; what
arrives is the rest of the receipt's life. `/receipts/{id}` renders a
transaction's receipt from the transaction alone — deposit, withdrawal,
transfer with both sides on the one sheet, reversal — with prints recorded
(0075) so a reprint says so. Void withdraws the number with a reason, the
Treasurer's act and never the captor's, and leaves the transaction posted;
it is an event on the stream. The reconciliation lists voided transaction
receipts beside payment ones and counts transactions in the period's total
by direction; the receipts report gains kind, reference, method, amount and
the void reason, with totals by method.

**Shipped, second increment** (S-1602, S-1604) — M16 complete. A receipt
goes to its member the moment it is issued: `receipt.issued` is an event
with an email and a WhatsApp template (0076), raised by the ledger after
every post that issues a receipt and again from the receipt page's **Send**,
to the address on the holder's application. The message carries a signed
link — HS256 on `MEMBER_SESSION_SECRET`, thirty days, one transaction — that
opens `/receipts/shared/{token}` without a sign-in and renders the sheet
alone; without the secret or an origin (`PUBLIC_APP_URL`, else the
redirect URI's) the wording says to ask at the branch. Where it went, and
whether it arrived, is on the receipt page. The statement is
`accountStatement()`: the balance before the period from the entries, every
entry in it with the running balance, totals and the closing balance;
`GET /api/v1/accounts/{id}/statement?from&to` returns it, `format=xlsx` as
the spreadsheet, and `/accounts/{id}/statement` shows it, prints it and
links the download — month to date until a period is chosen. **Not yet:**
WhatsApp as a document (S-1602's Should). The Treasurer's notification on
void arrived with S-1805 (M18).

### S-1601 · Every transaction takes a receipt from the one sequence ✅

**As** the Treasurer, **I need** deposits, withdrawals, transfers and
disbursements receipted in the same `RCT-` sequence as payments, **so that**
a gap means the same thing everywhere. _(RCT-US-001, RCT-US-007, FRD 6.8)_
`Must · 5 · EPIC-20`

- `post_transaction()` allocates from `receipt_number` and issues on post,
  exactly as `recordPayment` does (S-502); the receipt names the transaction
  reference, member, account, amount, method, date, officer and region, all
  read from the transaction — no field is typed twice
- A transfer's two legs share one receipt; the printable form (S-503's
  renderer) gains a transaction variant

### S-1602 · A receipt by email or WhatsApp ✅

**As** an officer, **I need** to send the member their receipt without
printing it, **so that** they leave with a record. _(RCT-US-002, NOTIF-US-005,
FRD 6.8, open point 6)_
`Must · 5 · EPIC-20` — WhatsApp media `Should` ✅

- **Given** a receipt is issued **Then** a `receipt.issued` notification
  (M9 templates) carries a link to `/receipts/{id}`, which the member's own
  sign-in (Phase 4) or a signed, expiring link opens; sent automatically
  when the event's template is active, and re-sendable from the receipt
- WhatsApp as a document is the Should half, built: the receipt as a PDF on
  the same signed link (`.pdf`), sent as the template's document header —
  and as an email attachment — where the wording's **Attach the receipt as
  a PDF** is on (migration 0089). Off by default, because a WhatsApp
  template only takes a document if Meta registered it with a document
  header.

### S-1603 · Void, and the reasons a sequence has holes ✅

**As** the Treasurer, **I need** to void a wrong receipt with a reason and to
see every gap and void in one report, **so that** the sequence stays
explainable. _(RCT-US-003, RCT-US-004, RCT-US-006, FRD 6.8, 12)_
`Must · 3 · EPIC-20`

- `state = 'void'` with a reason and the voiding user already exists (0017,
  S-506); a transaction's receipt voids the same way and requires
  `receipt.void`; voiding a receipt never un-posts the transaction —
  correction is S-1505's reversal
- S-506's reconciliation view lists transaction receipts alongside payment
  receipts, and the `receipts` report (S-906) gains kind, void reason and
  totals by period, branch, officer and method
- Treasurer notified on void (S-1805)

### S-1604 · The statement ✅

**As** an officer — and later the member — **I need** an account's statement
for a date range, on screen and as PDF or Excel, **so that** history is
available on demand. _(RCT-US-005, FRD 6.9, 10)_
`Must · 5 · EPIC-20` — export polish `Could`

- `GET /api/v1/accounts/{id}/statement?from&to` returns date, description,
  debit, credit and running balance from the entries; the page is a client
  of it; Excel through the export S-905 built, PDF through the receipt
  renderer's page layout
- Opening and closing balance for the range are on the document, so a
  member can check it against the last one

---

# M17 — Closure, resignation, demised

**Goal:** a member can leave a product, leave the Society, or die, and in
each case the money goes to the right person through the same engine and
the same chain as any withdrawal, with the accounts closed and the status
telling the truth. Supersedes M8's S-801 to S-803.

**Shape shared by all three:** a _request_ record (reason, signature, the
documents its checklist requires, the trail) that, on approval, produces
`disbursement`-kind transactions through S-1503's step and then changes
status. No request touches a balance itself.

**Shipped, first increment** (S-1701, S-1702): `member.status` is a check
constraint (0077) — pending, active, inactive, dormant, resigned, demised —
with `status_changed_at` beside it, and the member page says in one line
what a member who cannot transact is and since when; the capture paths
already refused anything but active. An account can be `closing` and
`closed`, dated, and a closed one no longer counts against one-of-each-type.
A closure is a transaction of kind `closure` on the chain 0070 seeded for
it: **Close** on any account that is not the membership's opens a draft
(account, reason, how the balance goes back), the member signs the request
on a sheet that is rasterised and filed against the transaction itself —
`document` gained a third owner — and **Submit** puts the account into
`closing`, where nothing else posts and the balance reads as spoken for.
The chevron is Details → Signature → Documents → Submitted → the chain →
Closed. Reviewed, returned, corrected and resubmitted like any transaction;
rejected or withdrawn, the account is active again. Posting is S-1503's
disbursement: `post_transaction()` refuses a closure whose amount is not
the balance at that moment, writes the debit (none for an empty account)
and closes the account in the same statement, with a receipt. Shares and
the MSA are refused by name: closing them is a resignation.
`POST /api/v1/accounts/{id}/closure` starts one.

**Shipped, second increment** (S-1703): a resignation is a transaction of
kind `resignation` on the Shares account covering every membership-default
account (0078) — Shares and the MSA as one unit, a Hajj Savings or
Investment untouched — with the same request life as a closure:
**Resign** on the member's page, the signed request filed against the
transaction, Details → Signature → Documents → Submitted → the chain →
Resigned. The pre-checks are each a switch at Configuration → Fee
schedules and each named when it blocks: nothing still on its way on
either core account, the joining fees fully paid, no financing outstanding
(a hook with nothing behind it, seeded off). Submitting puts both accounts
into `closing`; rejected or withdrawn, both are active again. Posting is
one disbursement and one receipt: `post_transaction()` refuses an amount
that is not what both accounts hold, writes one debit per account, closes
each as it empties and sets `member.status = 'resigned'`, dated. Retention
gained its fourth class, "Documents of a member who left", anchored on
that date (`docs/retention.md`). `POST /api/v1/members/{id}/resignation`
starts one.

**Shipped, third increment** (S-1704, all three parts): a claim is a
transaction of kind `demise` covering every account the member holds
(0079). **7a** — the claimant is the nominee the member named (S-602) by
default, or another person in full (name, NIC, address, relation), on the
transaction with the name in `payee_name`; the death certificate and the
affidavit are filed against the transaction from the wizard's Documents
step, and the affidavit is a category, not a validation, said in one line.
**7b** — the two figures: every account's balance, and the Takaful benefit
from `demised.takaful_benefit` (15,000, Administrator-editable at
Configuration → Fee schedules) as its own line, read at submission and
carried on the claim; posting writes one debit per account, closes each,
pays the total to the claimant on one receipt and sets `member.status =
'demised'`, dated. **7c** — the review screen shows the claimant, the
benefit beside the total and the two documents. `POST
/api/v1/members/{id}/demise` starts one.

**Shipped, fourth increment** (S-1705, S-1706) — M17 complete. Twelve
events, `closure.*`, `resignation.*` and `demised.*` for submitted,
under review (with the reviewer's comment), approved (at the payout, with
the amount, method and receipt) and rejected (with the reason), each with
seeded email and WhatsApp wording at Configuration → Notification wording
(0080); a closure or a resignation writes to the member, a claim to the
claimant's own email and mobile — the nominee's as captured, or the ones
the officer records — never the deceased member's. The **Exits** report
lists the three kinds by the period submitted, with the member, what was
paid out and to whom, the Takaful benefit, the status, the receipt and the
days from submission to payout; filterable by kind, totals by kind in the
summary, Excel through the same export as every report.

### S-1701 · Member status gets a vocabulary ✅

**As** the system, **I need** `member.status` to name every state a member
can be in and refuse any other, **so that** `resigned` and `demised` mean
something. _(RES-US-006, DEM-US-007, open point 2)_
`Must · 2 · EPIC-22`

- A check constraint, by migration, naming what the code already writes
  (`active`, `inactive`, `pending` …) plus `dormant`, `resigned`,
  `demised`; a member in the last three cannot transact or open an account,
  and the member page says why

### S-1702 · Closure request (HSA / Investment) ✅

**As** an officer, **I need** to close a member's secondary account with the
member's signature and the reason, **so that** they can leave a product
without leaving the Society. _(CLS-US-001..006, ACC-US-005, FRD 7.1)_
`Must · 8 · EPIC-21`

- Only account types that are not `is_membership_default` are offered;
  Shares and MSA are refused by the API with a message naming resignation
- The balance is computed, shown and not editable; the signed request is a
  checklist document; routes per the matrix; on approval a `disbursement`
  for the balance is recorded through S-1503, and on posting the account is
  `closed` and refuses every later transaction
- The chevron: Details → Signature → Documents → Submit → the live chain →
  Disbursement

### S-1703 · Resignation request (Shares + MSA, ends membership) ✅

**As** an officer, **I need** to resign a member, **so that** both their core
accounts close together and their membership ends. _(RES-US-001..006, FRD
7.2)_
`Must · 8 · EPIC-22`

- Shares and MSA are selected as one unit and cannot be resigned singly; any
  HSA or Investment the member holds is untouched (FRD 7.2 — the two
  processes are independent)
- Pre-checks before submission, each configurable and each named when it
  blocks: pending transactions on either account, unpaid fees, and —
  when Phase 3/4 exists — outstanding financing (a stub that always passes,
  with the hook in place)
- On approval one combined `disbursement` is recorded and posted; both
  accounts close; `member.status = 'resigned'`; the member's documents
  become anchorable for retention (docs/retention.md's "cannot be anchored
  yet" is now anchored)

### S-1704 · Demised claim ✅

**As** an officer, **I need** to settle a deceased member's entitlements to
their claimant, **so that** the family is paid what is owed and nothing
more. _(DEM-US-001..007, FRD 7.3)_
`Must · 13 → split · EPIC-23`

Split before it is pulled: **7a** the claim record and the claimant (nominee
default from S-602, or `other` with name, address, NIC, relation) with the
Death Certificate and Affidavit as checklist documents — `5`; **7b** the
computed, read-only total (every open account's balance, plus the Takaful
benefit from configuration as its own line) and the disbursement and
closure on approval — `5`; **7c** the review screen's presentation of the
two figures and the documents — `3`.

- `config: demised.takaful_benefit`, default 15,000, Administrator-editable
- On posting every account closes and `member.status = 'demised'` — a
  distinct value from `resigned`, and the report S-1806 tells them apart
- The Affidavit is a document category, not a validation: whether the file
  is the right legal instrument is the reviewer's call, and the screen says
  so in one line (FRD 7.3)

### S-1705 · Notifications at every stage of an exit ✅

**As** the member or claimant, **I need** to hear when a request is
submitted, under review, approved with the payout, or rejected, **so that**
nobody has to phone. _(CLS-US-007, RES-US-007, DEM-US-008, FRD 11.1)_
`Must · 3 · EPIC-30`

- Event codes `closure.*`, `resignation.*`, `demised.*` for `submitted`,
  `under_review`, `approved`, `rejected`, with wording seeded and editable
  at Configuration → Notification wording; a demised claim writes to the
  claimant's contact, not the member's

### S-1706 · Exits report ✅

**As** a manager, **I need** closures, resignations and demised claims by
period with amounts and turnaround, **so that** exits are visible.
_(RES-US-008, FRD 13)_
`Should · 3 · EPIC-12`

---

# M18 — Ready to use: configuration, notifications, reports

**Goal:** FRD Section 9's rule is met and provable — no officer is ever
blocked by a value nobody set — and every transaction event reaches the
people it should, and can be reported on.

**Shipped, first increment** (S-1803, S-1804, S-1805): ten events with
seeded wording (0081). To the member — `deposit.posted` with the balance,
`withdrawal.submitted` / `under_review` (with the comment) / `disbursed`
(method, receipt, balance) / `rejected` (with the reason), `transfer.posted`
to the holder of each side that is an account here (once when both are
theirs), and `balance.near_floor` when a posted debit leaves an account
within `balance.near_floor_margin` (Fee schedules, Rs 500, 0 for none) of
its type's floor. To the office, by email from `app_user` —
`transaction.awaiting` to every active holder of the step's role on every
arrival (submission, forward, resubmission; exits included), except whoever
sent it there; `transaction.returned` to the captor with the reviewer's
comment and a link; `receipt.voided` to every other holder of
`receipt.void` with the reason and the user, for transaction and fee
receipts alike. `src/lib/ledger/transaction-notifications.ts`,
`void-notifications.ts`, `src/lib/notifications/staff.ts`;
`docs/notifications.md`.

**Shipped, second increment** (S-1801, S-1802): `src/lib/config/readiness.ts`
lists every Phase 2 setting — the Fee-schedules amounts, the matrix and
chain per kind, each active account type's limits, the methods offered, the
wording by subject, the retention periods — with its value, whether a person
has changed it since it was seeded and by whom (from `config_entry_history`
and the configuration tables' `audit_event` rows, a migration's own change
counting as default). `readiness.test.ts` asserts a fresh database reads
nothing as missing, everything as at default, and that a rule removed, a
chain with no enabled step or wording switched off is flagged.
Configuration → Readiness shows the list read-only with the counts and a
link to where each is changed; `docs/functional-testing.md` carries the
go-live walk-through.

**Shipped, third increment** (S-1806) — M18 complete. Three reports in
`src/lib/reports/definitions.ts`: **Transactions** (everything recorded in
a period by kind, method and officer, with status, receipt, posting date
and posted totals by kind; a transfer once, as its debit leg), **Approvals**
(everything that went to a chain: the step and role it waits at, the days
since submission or to the decision, and the average turnaround) and
**Accounts near their minimum** (open accounts within a margin of their
type's floor, the configured margin unless one is typed, with headroom);
and the **Accounts** report gains a balance column and status and
balance-band filters. Region is not offered: nothing in the data records
one. The cashier's report is M20's (S-2003). `docs/ledger.md`, "Receipts".

### S-1801 · Every Phase 2 setting has a working default ✅

**As** an administrator, **I need** to adjust configuration rather than
author it, **so that** officers can transact on day one. _(CFG-US-001,
CFG-US-004, CFG-US-006, FRD 9)_
`Must · 3 · EPIC-29`

- Each milestone's migration seeds its own defaults (S-1304, S-1307,
  S-1401, S-1402, S-1704); this story is the test that asserts none of
  Section 9's items reads as unset on a fresh database, and the UAT step
  that has a new officer complete one of each transaction with no
  administrator involved

### S-1802 · Configuration → Readiness ✅

**As** an administrator, **I need** one page listing every Phase 2 setting
with its value and when it last changed, **so that** I can confirm the
platform is ready before go-live. _(CFG-US-005, FRD 9)_
`Must · 5 · EPIC-29`

- Reads `config_entry_history` for "last changed by whom", and flags an
  item that has never been changed since it was seeded — "still at
  default" is information, not an error

### S-1803 · Transaction notifications to members ✅

**As** a member, **I need** to be told when my deposit is confirmed, my
withdrawal is submitted, pending, disbursed or rejected, and my transfer has
completed, **so that** I know without asking. _(NOTIF-US-001, FRD 11.1)_
`Must · 5 · EPIC-30`

- Event codes `deposit.posted`, `withdrawal.submitted`,
  `withdrawal.under_review`, `withdrawal.disbursed`, `withdrawal.rejected`,
  `transfer.posted` (to both members, when both are); raised after commit
  in the engine, as `workflow.ts` raises application events (M9)
- `balance.near_floor` — advisory when a posted transaction leaves an
  account within a configurable margin of its floor

### S-1804 · Notifications to staff ✅

**As** an approver or captor, **I need** to know when something waits on me
or has come back to me, **so that** approvals do not stall. _(NOTIF-US-002,
NOTIF-US-003, FRD 11.2)_
`Must · 3 · EPIC-30`

- `transaction.awaiting` to every holder of the step's role, on arrival at
  a step; `transaction.returned` to the captor with the comment and a link;
  staff addresses come from `app_user`, which has them

### S-1805 · Treasurer told of a void ✅

_(NOTIF-US-004, FRD 11.2)_ `Must · 1 · EPIC-30` — `receipt.voided`, with
reason and user, to holders of `receipt.void`.

### S-1806 · Reports for Section 13 ✅

**As** a manager and an auditor, **I need** the reports Section 13 lists,
**so that** transactions, approvals, exits, receipts and floors are visible.
_(ACC-US-008, FRD 13)_
`Should · 8 → split by report · EPIC-12`

- New definitions in `definitions.ts`, each its own change: transactions
  (by period, method, type, officer; region is not recorded anywhere, so
  not offered); pending approvals with age and turnaround; exits (S-1706);
  receipts extended (S-1603); accounts at or near floor; the `accounts`
  report (S-905) gains balance and status filters. Cashier reports arrive
  with M20

---

# M19 — Bank accounts and reconciliation-ready records

**Goal:** the Society's own bank accounts are known to the system and every
transaction that touches one names it and carries a reference, so Phase 5
can match statements without re-engineering Phase 2.

**Shipped, first increment** (S-1901): `bank_account` (0082) — code, name,
bank, number, currency, opening balance and date, active — audited like
every configuration table, with its own `bank_account.view` (the number
masked to its last four, server-side) and `bank_account.manage` (whole;
add and change), the Treasurer holding both and the Auditor the first.
Configuration → Bank accounts shows each with a balance derived, never
stored, from the opening balance and the posted transactions naming it.
`transaction.bank_account_id` arrives nullable: a deposit, a withdrawal, a
transfer to a payee and a disbursement may name an active account of the
Society's and the ledger refuses any other; the transaction page shows it
beside the method.

**Shipped, second increment** (S-1902) — M19 complete. Wherever the
method touches a bank, the bank account and the reference are mandatory:
at capture for a deposit; at capture when it posts at once and at
disbursement otherwise for a withdrawal, a transfer to a payee, a closure,
a resignation and a claim; a reversal inherits the original's.
`requireBankAccount()` asks in the caller's words at every one of those
points, and `post_transaction` (0083) refuses to post money through a bank
without both, whatever path was taken; the posting's `financial_event`
payload carries `bank_account_id` beside `method_reference`. Every capture
and disbursement form gains a bank account select, shown for a
bank-touching method and naming accounts without their numbers; every
endpoint that takes a method takes `bankAccountId`. The reconciliation
dry-run is in `docs/functional-testing.md`.

### S-1901 · The Society's bank accounts ✅

_(BNK-US-001, BNK-US-004, FRD 15)_ `Must · 3 · EPIC-25` — `bank_account`
configuration: bank, reference, currency, opening balance, active; full
details visible only with `bank_account.manage`; a read-only balance derived
from posted transactions that name it.

### S-1902 · Every bank-touching transaction names its bank account ✅

_(BNK-US-002, BNK-US-003, FRD 15)_ `Must · 3 · EPIC-25` — where the method
`touches_bank` (S-1307), `transaction.bank_account_id` and the reference are
both mandatory; a sample reconciliation dry-run against a real statement is
the acceptance test, and the `financial_event` payload carries both fields.

---

# M20 — Cashier

**Goal:** each regional office's cash drawer opens with a float, is expected
to hold what the day's cash transactions say, and closes against a count.
Should-Have: designed here, not required for go-live.

**Shipped, first increment** (S-2001, S-2002): `cash_session` (0084) —
cashier, opened at, float, closed at, count, expected at close, over or
short, note — one open per cashier, closed only by its cashier, immutable
once closed, never deleted, opening and closing audited with the figures.
Attribution is the database's: a trigger writes the open session of
whoever posted a cash transaction onto `transaction.cash_session_id`, and
of whoever recorded a cash fee receipt or refund onto
`payment.cash_session_id`, so no path that moves cash has to remember.
Expected = float + cash in − cash out from those rows, live on the
**Cash drawer** page (`cash.session`: Clerk, Account Officer, Regional
Officer, Treasurer) with every movement, and fixed at closing; **Cash
drawers** (`cash.view`: Treasurer, Regional Manager, Auditor) lists every
session with its count and over or short. No region or branch: nothing in
the data has one.

**Shipped, second increment** (S-2003) — M20 complete. **Daily cash
reconciliation** (`cash.view`, under Reports → Finance): every drawer in a
period — day, cashier, opened and closed, float, cash in, cash out,
expected, counted, over or short, movements, note — and, by day and by
whoever moved it, the cash that went through no drawer at all, so nothing
that touched the till is missing from the day. A closed drawer's expected
figure is the one fixed at closing; the movements beside it are what the
database attributes to it now, and the one way they can disagree — a fee
receipt voided after the drawer closed — is said on the row. The summary
gives the counted total against the expected and the net over or short.

### S-2001 · Open and close the drawer ✅

_(CSH-US-001, CSH-US-003, FRD 14)_ `Should · 5 · EPIC-24` — `cash_session`
per cashier per day: opening float, closing count, computed expected,
over/short logged and audited; a cashier cannot open twice or close what
they did not open.

### S-2002 · Expected cash, live ✅

_(CSH-US-002, CSH-US-004, FRD 14)_ `Should · 3 · EPIC-24` — every cash
transaction posted while a session is open is attributed to it (region,
branch, cashier on the transaction); expected = float + cash in − cash out,
from the ledger.

### S-2003 · Daily cash reconciliation report ✅

_(CSH-US-005, FRD 13, 14)_ `Should · 3 · EPIC-12` — per day and cashier:
float, cash in, cash out, expected, counted, over or short, with the cash
moved outside any drawer listed beside; `cash.view`.

---

# M21 — Member-scoped access, ahead of Phase 6

**Goal:** the balance, statement and history a member will see in the app
are the same endpoints staff use, behind the member's own token, and a
member-initiated transaction — when the Society switches it on — is subject
to every rule a staff-initiated one is.

**Shipped, first increment** (S-2101): `/api/v1/member/me/accounts/{id}/
balance`, `/history` and `/statement` through `defineMemberEndpoint`, each
answering with the staff endpoint's own payload. The response schema and
the mapping now live once, in `src/lib/ledger/api-payloads.ts`, and the
staff endpoints under `/api/v1/accounts/{id}` were rewritten onto it, so
there is one shape for a balance, a history page and a statement whoever
asks. The member endpoint adds one thing: `ownedAccountId`, which resolves
the account server-side against the session's member and answers not
found for any other — another member's, a customer's, or none. The
statement's `format=xlsx` download is offered to the member as it is to
the officer.

**Shipped, second increment** (S-2102): `POST /api/v1/member/me/deposits`,
`/withdrawals` and `/transfers`, each the staff transaction — the same
service function, rules and matrix — captured by the member-app system user
in the new Member role (0085: a system role assigned to nobody, with no
permission, there for the matrix to name). The app holds
`transaction.capture` and never `transaction.post`, so a route that would
post at once is refused and a member's transaction goes to a chain or
nowhere: never more lenient than a clerk's. `member_api.enabled_operations`
(0085, empty by default; Configuration → Member app, `config.manage`; on
Readiness) switches each of the three on; until then the endpoints exist
and refuse. A cash deposit is refused outright; `/reference` now names the
Society's bank accounts so a deposit can say which one it reached; a
transfer goes to an account here by id, never to a payee outside. Member
writes demand an `Idempotency-Key` as staff ones do.

**Shipped, third increment** (S-2103) — M21 complete. Every Phase 2
endpoint is in the generated document already (`pnpm openapi:check` fails
the build otherwise); what changed is how the explorer groups them. Tags
now follow the thing, not the caller: an account's balance, history,
statement and transactions — staff and member alike — are **Accounts**, a
deposit, withdrawal, transfer, reversal or exit **Transactions**, with the
permission line on each saying whether it is an officer's permission or a
member app session. **Member app** keeps identity, applications, documents
and the reference.

### S-2101 · Balance, statement and history for a member's own accounts ✅

_(API-US-001, API-US-003, FRD 10)_ `Must · 5 · EPIC-26` — `/api/v1/member/
accounts`, `/balance`, `/statement`, `/history` through `defineMemberEndpoint`
(Phase 4), resolving the member server-side as `link-member` does, calling
the same service functions as the staff endpoints; the response schema is
the staff one.

### S-2102 · Per-endpoint switch for member-initiated writes ✅

_(API-US-005, API-US-006, FRD 10)_ `Must · 5 · EPIC-26` — `config:
member_api.enabled_operations`, default none; deposit, withdrawal and
transfer as member endpoints that exist, refuse until enabled, and when
enabled call `resolveRoute()` and the engine exactly as a clerk's submission
does — the initiating role is "member", which the matrix can route
differently, never more leniently.

### S-2103 · The API reference covers Phase 2 ✅

_(API-US-004)_ `Must · 2 · EPIC-26` — every endpoint above is in the OpenAPI
document (`pnpm openapi:check` already fails otherwise) and the in-app
explorer (S-110) groups them under Transactions and Accounts.

---

# Phase 2 traceability

Every story in FRD Section 20 is covered. "Phase 1" means built already
(see the reuse table); a bare story id is where it is scheduled.

| FRD story    | Backlog                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| ACC-US-001   | S-1304                                                                                                            |
| ACC-US-002   | Phase 1 — S-309, migration 0018                                                                                   |
| ACC-US-003   | Phase 1 — S-612, S-613                                                                                            |
| ACC-US-004   | S-1309, S-1303                                                                                                    |
| ACC-US-005   | S-1702                                                                                                            |
| ACC-US-006   | S-1304                                                                                                            |
| ACC-US-007   | Phase 1 — migration 0018; open point 5                                                                            |
| ACC-US-008   | S-1806                                                                                                            |
| TXN-US-001   | S-1305                                                                                                            |
| TXN-US-002   | S-1307                                                                                                            |
| TXN-US-003   | S-1306 (Phase 1 0062 for payments)                                                                                |
| TXN-US-004   | S-1501                                                                                                            |
| TXN-US-005   | S-1501, S-1701                                                                                                    |
| TXN-US-006   | S-1504                                                                                                            |
| TXN-US-007   | S-1502, S-1309                                                                                                    |
| TXN-US-008   | S-1505                                                                                                            |
| TXN-US-009   | S-1506                                                                                                            |
| TXN-US-010   | Not a story: the FRD's Section 18 says "TXN-US-001 to TXN-US-010", but its Section 20 table runs 001–009 then 011 |
| TXN-US-011   | S-1306 (Phase 1 0062 for payments)                                                                                |
| APR-US-001   | S-1401                                                                                                            |
| APR-US-002   | S-1401                                                                                                            |
| APR-US-003   | S-1403                                                                                                            |
| APR-US-004   | S-1403                                                                                                            |
| APR-US-005   | S-1404, S-1804                                                                                                    |
| APR-US-006   | S-1401                                                                                                            |
| APR-US-007   | S-1406                                                                                                            |
| APR-US-008   | S-1404                                                                                                            |
| APR-US-009   | S-1402 (Phase 1 S-209 for the mechanism)                                                                          |
| APR-US-010   | S-1402                                                                                                            |
| APR-US-011   | S-1402                                                                                                            |
| APR-US-012   | S-1402                                                                                                            |
| RCT-US-001   | S-1601                                                                                                            |
| RCT-US-002   | S-1602                                                                                                            |
| RCT-US-003   | S-1603 (Phase 1 S-506 for payments)                                                                               |
| RCT-US-004   | S-1603 (Phase 1 S-506)                                                                                            |
| RCT-US-005   | S-1604                                                                                                            |
| RCT-US-006   | S-1603                                                                                                            |
| RCT-US-007   | S-1601                                                                                                            |
| CLS-US-001   | S-1702                                                                                                            |
| CLS-US-002   | S-1702                                                                                                            |
| CLS-US-003   | S-1702                                                                                                            |
| CLS-US-004   | S-1702, S-1403                                                                                                    |
| CLS-US-005   | S-1702, S-1503                                                                                                    |
| CLS-US-006   | S-1702                                                                                                            |
| CLS-US-007   | S-1705                                                                                                            |
| RES-US-001   | S-1703                                                                                                            |
| RES-US-002   | S-1703                                                                                                            |
| RES-US-003   | S-1703                                                                                                            |
| RES-US-004   | S-1703, S-1403                                                                                                    |
| RES-US-005   | S-1703                                                                                                            |
| RES-US-006   | S-1703, S-1701                                                                                                    |
| RES-US-007   | S-1705                                                                                                            |
| RES-US-008   | S-1706                                                                                                            |
| DEM-US-001   | S-1704 (7a)                                                                                                       |
| DEM-US-002   | S-1704 (7a)                                                                                                       |
| DEM-US-003   | S-1704 (7b)                                                                                                       |
| DEM-US-004   | S-1704 (7b)                                                                                                       |
| DEM-US-005   | S-1704 (7a)                                                                                                       |
| DEM-US-006   | S-1704 (7c), S-1403                                                                                               |
| DEM-US-007   | S-1704 (7b), S-1701                                                                                               |
| DEM-US-008   | S-1705                                                                                                            |
| CSH-US-001   | S-2001                                                                                                            |
| CSH-US-002   | S-2002                                                                                                            |
| CSH-US-003   | S-2001                                                                                                            |
| CSH-US-004   | S-2002                                                                                                            |
| CSH-US-005   | S-2003                                                                                                            |
| BNK-US-001   | S-1901                                                                                                            |
| BNK-US-002   | S-1902                                                                                                            |
| BNK-US-003   | S-1902                                                                                                            |
| BNK-US-004   | S-1901                                                                                                            |
| API-US-001   | S-1310, S-2101                                                                                                    |
| API-US-002   | S-1308                                                                                                            |
| API-US-003   | S-2101; open point 9                                                                                              |
| API-US-004   | S-2103                                                                                                            |
| API-US-005   | S-2102                                                                                                            |
| API-US-006   | S-2102                                                                                                            |
| ENG-US-001   | S-1301, S-1302, S-1305                                                                                            |
| ENG-US-002   | S-1301                                                                                                            |
| ENG-US-003   | S-1302                                                                                                            |
| ENG-US-004   | S-1302, S-1601 (one function does both)                                                                           |
| UX-US-001    | S-1405                                                                                                            |
| UX-US-002    | S-1405                                                                                                            |
| UX-US-003    | Phase 1 — the signature and upload pages are reused by every request; S-1702                                      |
| UX-US-004    | S-1403                                                                                                            |
| UX-US-005    | S-1405                                                                                                            |
| CFG-US-001   | S-1801                                                                                                            |
| CFG-US-002   | Phase 1 — S-901's screen; S-1803 for the events                                                                   |
| CFG-US-003   | S-1311                                                                                                            |
| CFG-US-004   | S-1801                                                                                                            |
| CFG-US-005   | S-1802                                                                                                            |
| CFG-US-006   | S-1801                                                                                                            |
| NOTIF-US-001 | S-1803, S-1705                                                                                                    |
| NOTIF-US-002 | S-1804                                                                                                            |
| NOTIF-US-003 | S-1804                                                                                                            |
| NOTIF-US-004 | S-1805                                                                                                            |
| NOTIF-US-005 | S-1602                                                                                                            |
| NOTIF-US-006 | Phase 1 — S-904, `/admin/notifications`                                                                           |

# Phase 2 open points

The FRD closes its own open points. These are the ones the code raises. Each
has a default the stories are written to, so none blocks the start of M13;
each should be confirmed before the milestone that consumes it.

| #   | Point                                                       | Needed by    | Default the backlog assumes                                                                                                             |
| --- | ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which Phase 1 fee components open which balance             | M13 · S-1303 | `shares` → Shares, `msa_deposit` → MSA; entrance, processing, Takaful open nothing                                                      |
| 2   | The full `member.status` vocabulary                         | M17 · S-1701 | What the code writes today plus `dormant`, `resigned`, `demised`                                                                        |
| 3   | Dormancy: detection and reactivation (M8's S-804 to S-806)  | M15 · S-1501 | **Closed by M22**: detection nightly after `dormancy.months` of no activity (12); reactivation by an officer with a reason              |
| 4   | Payment method list and which need a reference              | M13 · S-1307 | FRD 6.6's list; cheque, transfers and bank methods require a reference                                                                  |
| 5   | HSA / Investment as multi-instance per member               | M13          | One of each type per member (0018) stands; multi-instance is a later migration if wanted                                                |
| 6   | Receipt by email: link or attachment                        | M16 · S-1602 | A link, and since 0089 the PDF as well where the wording says so (per channel; off by default)                                          |
| 7   | Whether a pending withdrawal reserves balance               | M15 · S-1502 | Yes: available = balance − pending debits, as a query                                                                                   |
| 8   | Transfer to a non-member: where the credit goes             | M15 · S-1504 | Nowhere: debit leg plus disbursement out, no credit leg                                                                                 |
| 9   | One API surface for staff and member (API-US-003)           | M21          | Two surfaces on one framework and one engine, as Phase 4 built; the rules are identical, the paths differ                               |
| 10  | Withdrawing from Shares below the holding minimum           | M15 · S-1501 | Refused; resignation is the only way below it                                                                                           |
| 11  | A returned transaction whose amount crosses a matrix band   | M14 · S-1404 | Re-routed by the rule that now applies                                                                                                  |
| 12  | Correcting a posted transaction                             | M15 · S-1505 | A reversing transaction, never an edit                                                                                                  |
| 13  | Receipt number format and yearly reset (FRD shows RC-2026-) | M16 · S-1601 | `RCT-` continuous, as 0017; prefix becomes configuration; no yearly reset                                                               |
| 14  | Takaful / funeral benefit amount                            | M17 · S-1704 | Rs 15,000, configuration                                                                                                                |
| 15  | Minimum balance floors and approval thresholds per type     | M13 · S-1304 | Shares: the holding minimum; others 0; escalation threshold a single configured amount                                                  |
| 16  | Board quorum on President's step for large disbursements    | M14          | 1 — `quorum_count` exists (0022) and can be raised without a release                                                                    |
| 17  | Transaction drafts                                          | M15 · S-1505 | Not persisted for a one-act deposit; the `draft` status carries the request flows — closures, exits, and since M23 a large cash deposit |

# Phase 4 — Member mobile app (AD-03) ✅ first slice

**The member surface exists.** `/api/v1/member` (`docs/member-app.md`),
built with `defineMemberEndpoint` on the same framework as the staff API
— same envelope, rate limiter, log line and audit trail — and reached
with a bearer token the middleware never confuses with the staff cookie.

**Identity, in four parts kept apart.** NIC + AB Number _identify_ one
active member (`link-member`: exact pair, active only, one answer whichever
half was wrong, never the staff `existing-member-search`); a one-time code
to the mobile on that member's record _verifies_ the person (hashed,
five attempts, five minutes, one use); the session that results
_authenticates_ every later request (JWT access token + rotated refresh
token, `member_session`); and the _link_ to the member — `member_id` — is
resolved server-side on every request and never sent to the phone. NIC +
AB Number alone open nothing. A new applicant verifies a mobile instead
(`sign-up`) and gets an applicant session that never resolves to a member,
whoever the number belongs to. Migration 0039.

**Applications from the phone.** Captured by the `Member app` system user
(no role, unclaimable subject), tied to the applicant's verified mobile,
saved as they go through `saveDraft`, documents through the same brokered
upload, checked at submit by `problemsBlockingSubmission` plus the
checklist — and landing on **`received`**, a new status: the branch's to
complete (signed form, payment) and submit into the chain as a draft.
`isEditableStatus` is now the one test the capture pages, document guards
and workflow read.

**A member's own capture of their details** arrives as a
`member_details_request`, and staff act on it at Members → Details updates
(`member.details_verify`, migration 0042): what the record holds against
what the member says, field by field, applied or declined with a reason
the member is shown. A change is measured against what the member was
SHOWN, never against the record as it stands — the app sends the whole
form back, so diffing the other way would write their stale copy over
anything an officer corrected at the branch while the request waited.

The balance a member sees is the ledger's since M13, and since M21 the
app reads the same balance, history and statement payloads the branch
does and, where the Society switches it on, starts a transaction that
rides the same matrix.

**The two leftovers, closed as M24.** A member opens their own documents:
`GET /me/documents/{id}/content` streams the file from this origin exactly
as the branch's print path does (`getDocumentContent`), for any document
`/me/documents` lists and nothing else — `ownedDocumentId` answers the same
not_found for someone else's, a draft's and a non-id, as `ownedAccountId`
does for an account. And a member is told when a details update they sent
is decided: `member.details.applied` names the fields that changed,
`member.details.declined` carries the officer's reason (migration 0087,
email and WhatsApp wording each), raised after the decision commits
through the same `tellMember` the dormancy job uses. An application's
status changes already reached the applicant through `application.*` and
`account.*` events on the address they gave; what remains unbuilt is push
to the device itself, which needs a token registry and a provider the
Society has not chosen — the app shows the outcome on next open either
way.

# M25 — The job that watches the jobs ✅

`docs/jobs.md` had recommended it since M1: `job_run` recorded every run
and nothing read it back. **`job-watch`** (`src/lib/jobs/watch.ts`) now
does, on the same runner: a run still open and untouched for six hours
means a container died and nothing resumed it; a job whose latest run
failed is one nobody has re-run. Each is told to every active System
Administrator by email — `job.stalled`, `job.failed`, migration 0088 —
once per run, the delivery log being the memory of what was said, so a
stalled run found again the next morning is not reported again while the
same run failing after it resumes is. It cannot see a job that never
starts at all; that is the platform's own run history.

# M27 — The timeline experience for transactions ✅

An officer recording a deposit, a withdrawal or a transfer used to learn
whether it would be reviewed only after pressing Record. Now the form opens
on the chevron the transaction page will show, drawn ahead of time — Record
current, every step of the chain to come, Posted at the end, or Record and
Posted alone under "Up to Rs 100,000.00: posted at once, no review needed"
— for the account chosen and the amount typed, from a member's page and from
the Transactions lookups alike. The bands are `routeBands()` in
`src/lib/ledger/routing.ts`, read off `resolveRoute` at every boundary the
matrix draws for that kind, account type and officer, so the picture and the
submit cannot disagree; `previewTimeline` and `routePreviewGroups`
(`src/lib/workflow/timeline.ts`) turn them into the same `TimelineStep`s
the membership application's chevron uses, and `RoutePreview.astro` shows
the right one as the amount changes. `docs/ledger.md` has the detail.

# M26 — After an exit: rejoining and reopening ✅

A member who resigned could not come back, and a closed Hajj Savings
account could not reopen: a fresh membership application would have made
a second member with a second AB number, and an additional-account
application for the type was refused at approval because the closed
account still counted as held. Now the resigned member's page offers
**Rejoin**, which starts the same membership application through the same
chain, naming the member (`rejoins_member_id`, migration 0090) and copying
the parties on file; approval re-admits that member — same row, same
number, `rejoined_at` — and reactivates the Shares and MSA the resignation
closed, under their own ids. A closed account's row offers **Reopen**,
which starts the additional-account application for its type; approval
brings the closed account back under its own number, `reopened_at`, rather
than opening a second. Both are tagged on the page — "rejoined {date}",
"Reopened {date}" — and audited as `member.rejoined` and
`account.reopened`. The buttons a closed or resigned record no longer
needs (Deposit, Close, Resign) were already gone with the status; the
"already holds" check and the offer of types to open now ignore a closed
account. `docs/ledger.md` under Closing an account and Resigning has the
detail; `src/lib/members/rejoin.test.ts` proves both paths against the
migrations. Since then: a rejoin application is no longer refused as a
duplicate of the member's own NIC; a resigned member opens a further
account (HSA, Investment) from their page without rejoining
(`canOpenAccount`); the members list shows no badge for a closed
account; and a resigned member is a non-member from then on — they
deposit, withdraw, transfer and close on the accounts still open, and
are tagged and counted as a non-member while they hold one.

# Officer feedback, round 6 — screens ✅

Small changes to screens that are already built. None of them changes a
rule.

- **Filed documents** have the same two controls on every page: a View
  button and a red ✕ that deletes, the same height and in the same place
  (`VIEW_BUTTON`, `DELETE_BUTTON` in `src/lib/ui.ts`).
- **Secondary buttons** have a white fill, and closing or deleting
  actions a light red one. On a member's page the Close button on an
  account row is one of these red buttons, and History and Reopen are
  small secondary buttons.
- **A member's Documents and Payments** open in dialogs from two buttons
  that show a count, so the page does not grow with the lists.
- **A posted deposit's Source of Fund form** has a View button on its row
  in the account history.
- **The left menu** collapses to a rail of icons, and each browser
  remembers the choice.
- **Every report** has a link back to the report list.
  - The Applications report adds the applicant's name and where each
    application stands ("With the Secretary", "Returned by …").
  - Its Status filter is a dropdown of where an application stands: Draft,
    Received online, one "With the …" per step of the configured chain,
    Returned, Abeyance, Approved, Rejected. The raw `new` and
    `submitted_for_approval` are not offered (they say nothing about who
    holds it), nor `submitted_for_review`, which no enabled step produces
    (migration 0011).
- **A colleague's draft** closure, resignation or claim says on its page
  who holds it, since only its captor can continue or cancel it; the
  member page's "Claim ·" and "Resigning ·" buttons open the wizard while
  it is a draft.

# Officer feedback, round 7 — tables, the closure request, the app ✅

- **Every table sorts** by its column headings: click once for ascending,
  again for descending, on the rows already on the page
  (`src/lib/client/table-sort.ts`; a table opts in with `data-sortable`, a
  heading with no order opts out with `data-no-sort`, and a formatted date
  or amount carries its raw value in `data-sort-value`).
- **The closure request's signature step** shows the signed request with
  View and the red ✕ that deletes it, as the resignation's does (the
  `remove-form` intent); deleting it means signing again. The demised
  claim has no signed request of its own, only its papers, which already
  had the two.
- **The member app** admits a resigned member while an account of theirs
  is still open (a non-member holding an HSA or an Investment), and no
  longer one with no account at all — one rule (`mayUseAppSql`,
  `src/lib/member/identity.ts`) for the link, the code and the refresh,
  by officer direction. `docs/member-app.md`.

# The dashboard, and the document directory ✅

The dashboard's six dashed "coming soon" tiles are replaced by cards built
from the same navigation model as the sidebar (`navigationFor`,
`src/lib/navigation.ts`): one card per group — Membership, Finance,
Administration — each door on it offered only to a role holding the
permission its route declares, with a line on what it is for
(`NAV_DESCRIPTIONS`) and the same "waiting on you" counts the menu
badges carry. **Documents** is a new door (`document.view`): the document
directory at `/documents`, a folder per member and non-member customer
with how much is on file, and `/documents/{id}` listing everything filed
for them — under the applications that made them, against the member
directly, and on their transactions (`src/lib/documents/directory.ts`,
`docs/documents.md`, `docs/access-control.md`).

# Disbursement is the Treasurer's ✅

Officer direction: after the Secretary and the President, the Treasurer
pays the money out. `transaction.disburse` (migration 0095, the
Treasurer's) is the act after approval for a withdrawal, a transfer to a
payee, a closure, a resignation or a claim; `transaction.post` keeps
posting an approved deposit and posting directly below the threshold. The
queue shows each person what they may pay out or post. On screen money
paid out is "disbursed" (`src/lib/ledger/labels.ts`), the button says
Disburse, and the chevron of a transaction that pays out ends in
**Disbursement** with the roles holding the permission under it —
"Treasurer" — read from the roles, so moving the permission moves the
name (`rolesHoldingPermission`, `src/lib/access/holders.ts`).

- **How a withdrawal is paid out is asked only where it is paid out.**
  Recording one that goes for approval no longer asks "Paid by" or the
  bank account (officer direction): the Treasurer says both at Disburse.
  One the matrix pays out at once still asks, since whoever records it
  pays it. The form follows the route preview as the account and amount
  change; until Disburse the method on record is a placeholder the screens
  and the transactions report do not show.
- **The same for a closure and a demised claim** (business decision, after
  the lifecycle test): recording either asks nothing about the payout, as a
  resignation already did. Only where the matrix pays it out at once does
  the Submit step ask "Paid by", the reference and the bank account. The
  signed closure request no longer prints how it will be paid.
- **A guardian cannot resign while a minor depends on them** (business
  decision): the resignation's checks name each minor member, minor
  non-member or minor's application that gives them as guardian, and the
  request cannot be submitted until there is none. A minor's guardian
  cannot be changed on screen today, so the block lasts until the minor
  leaves or reaches majority.
- **The Deposit, Withdrawal and Transfer lookups** suggest matching
  accounts, by number or by holder name, as the officer types.

# Regression run fixes (QA-01 to QA-38) ✅

The manual regression run of 23 September 2026 reported 38 findings. Fixed
here, with the business's decisions where the report left a choice open:

- **Money.** Back, then Post, no longer records a deposit, withdrawal or
  transfer twice: the key a form was posted with is put back when the
  officer returns by Back (`IdempotencyKeyField`). A new member's opening
  deposits, carried from the fee receipt, count once — not again on the
  approver's drawer or the cash reconciliation (migration 0096) — and share
  the receipt's number without reading as a duplicate. An exit that has paid
  out is never offered Reverse (undoing it is a rejoin or a reopen), and a
  reversal on a closed account says so in words. A transfer is known by its
  TR reference on the list, the statement, the receipt and the detail page;
  the TX reference stays each leg's key for the audit trail. An exit's last
  step is **Disbursement** and its button **Disburse**, like any money paid
  out (business decision); "Received from" on a Minor's or a Corporate
  member's deposit names the guardian or the contact person.
- **Applications.** Autosave is back, on leaving a changed field and on
  leaving the page (business decision; see docs/applications.md). An
  approved application no longer flags its own member's NIC; a choice sent
  in another case ("female") is stored as the form writes it; the guardian
  search offers active members and applications in progress, never a
  resigned member; a President who has signed off on a quorum step is not
  offered Approve again.
- **Configuration and jobs.** Reactivating a member counts as activity, so
  the next dormancy run leaves them active. A migration import checks its
  control totals against the file before anything is written. A new
  approval-matrix rule goes first (business decision). The Regional Manager
  handles applications sent from the app, end to end (migration 0097,
  business decision). A built server reads its own settings: what `.env`
  held at build time never overrides them (`pickEnv`).
- **Screens.** Status codes read as words, amounts as MUR 1,234.00, a
  missing page has a proper not-found page, documents reports name the
  transaction, SharePoint being unreachable says so, the filed file's
  version follows what was filed rather than every attempt, and the
  remaining labels and print layouts are corrected.

Not changed, by decision: WhatsApp template names (QA-33) are for the
Society to set to what Meta approves; the member app's own findings
(QA-35 to QA-37) belong to its repository.

# Open values that later stories depend on

Each is absorbed by configuration, so none blocks the start of development.
They must be confirmed before the milestone that consumes them.

| Value                                          | Needed by    | Default if unconfirmed                                                                         |
| ---------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Minor MSA deposit                              | M5 · S-501   | Not required — **shipped this way**                                                            |
| Processing fee amount and applicability        | M5 · S-507   | Zero / not applicable — **shipped this way**                                                   |
| Nominee count and percentage rules             | M6 · S-602   | Single nominee, no percentages — **shipped this way, changeable per type without a release**   |
| Dormant reactivation rule                      | M8 · S-805   | Flag for staff action — **shipped this way** (`dormancy.reactivation`, M22)                    |
| KYC and audit retention periods                | M10          | Retain indefinitely — now settable on Configuration → Retention (audit: see docs/retention.md) |
| Whether Abeyance and Manager review are wanted | Post-go-live | Available but disabled                                                                         |
