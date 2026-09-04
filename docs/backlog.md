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

---

# M7 — Legacy migration

**Goal:** the existing register becomes members in this system, phase-wise —
**members first, finance later**, per your direction.

**Needs first:** the cleansed extract from Al Barakah. The legacy register
analysis records five blockers and the field gaps; none is this system's to
fix, and the import cannot start until the source is agreed and frozen.

### S-701 · Agree and freeze the cleansed source extract

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

### S-707 · Promote to production after business sign-off

**As** the project, **I need** an explicit sign-off before production import,
**so that** the decision is deliberate and recorded. _(decision 3)_
`Must · 3 · EPIC-14`

### S-708 · Log the import as a traceable audit event

**As** an auditor, **I need** the import recorded, **so that** it is
distinguishable from ordinary data entry. _(FRD 7.12)_
`Must · 3 · EPIC-11`

- Source checksum, counts, who authorised it, when

### S-709 · Later pass — shares, savings, Haj and loan balances

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

# M8 — Resignation & dormancy

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

### S-804 · Scheduled dormancy detection

**As** the Society, **I need** dormancy detected automatically, **so that**
the rule is applied evenly. _(DOR-US-001, FRD 7.11)_
`Must · 8 · EPIC-15`

- Threshold is configuration
- Runs on the job runner from M1, resumable over a large membership

### S-805 · Configurable reactivation

**As** an administrator, **I need** the reactivation rule configured, **so
that** it can change without a release. _(decision 6)_
`Must · 5 · EPIC-15`

- **Depends on** the confirmed rule. Default until then: flag for staff action

### S-806 · Approaching-dormancy report

**As** staff, **I need** to see who is close to dormancy, **so that** they can
be contacted first.
`Should · 3 · EPIC-12`

---

# M9 — Notifications, reporting & public API

**Goal:** members hear from the Society, staff can report on it, and
Albarakah.mu can submit applications.

### S-901 · Provider-independent notification service with templates

**As** the Society, **I need** notifications independent of any one provider,
**so that** changing provider is configuration. _(decision 11)_
`Must · 8 · EPIC-10`

- Templates are configuration; channel is a detail behind one interface

### S-902 · Email channel for the events in FRD Section 9

**As** a member, **I need** to be told what happened to my application,
**so that** I am not left waiting. _(FRD Section 9)_
`Must · 5 · EPIC-10`

### S-903 · WhatsApp channel — membership approved

**As** a member, **I need** approval by WhatsApp, **so that** I hear promptly.
_(decision 11)_
`Must · 8 · EPIC-10`

- Sends to the international-form number captured in M3, which is why that
  conversion happened at capture rather than being deferred

### S-904 · Notification delivery log and retry

**As** staff, **I need** to see whether a notification arrived, **so that** a
silent failure is not mistaken for a member ignoring us.
`Must · 3 · EPIC-10`

- **Given** a send fails **Then** it is retried on a schedule and the failure
  is visible until it succeeds or is abandoned

### S-905 · Membership, document and account reports

`Should · 8 · EPIC-12`

### S-906 · Payments, receipts and dormancy reports

`Should · 5 · EPIC-12`

### S-907 · Operations and audit reports

`Should · 5 · EPIC-12`

- Includes an access-and-actions report over the audit trail, which is what
  makes the trail useful rather than merely present

### S-908 · Public application API for Albarakah.mu

**As** an external applicant, **I need** to apply from the website, **so
that** joining does not require visiting an office. _(MEM-US-002, FRD 7.3)_
`Must · 8 · EPIC-13`

- Creates a draft application through the same service the staff screens use,
  so the two cannot diverge
- **Given** a public submission **Then** it enters the same chain, with the
  same required documents

### S-909 · API credentials, throttling and abuse protection

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
policy — so this is the one open value that should not stay open.

### S-1001 · Penetration test and remediation

`Must · 8 · EPIC-01`

### S-1002 · Backup and restore, proved by an actual restore

**As** the Society, **I need** a restore that has been performed, **so that**
the backup is known to work rather than assumed to.
`Must · 5 · EPIC-01`

- **Given** a restore drill **Then** the recovered system is verified against
  known figures, and the time taken is recorded

### S-1003 · Retention and disposal policy applied

**Depends on** the confirmed retention periods.
`Must · 5 · EPIC-11`

### S-1004 · Provision real staff accounts and roles

**As** the Society, **I need** the real people set up with the right roles,
**so that** go-live is not the moment access is first tested. _(decision 15)_
`Must · 3 · EPIC-02`

### S-1005 · Operational runbook and handover

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

# Open values that later stories depend on

Each is absorbed by configuration, so none blocks the start of development.
They must be confirmed before the milestone that consumes them.

| Value                                          | Needed by    | Default if unconfirmed                                                                       |
| ---------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| Minor MSA deposit                              | M5 · S-501   | Not required — **shipped this way**                                                          |
| Processing fee amount and applicability        | M5 · S-507   | Zero / not applicable — **shipped this way**                                                 |
| Nominee count and percentage rules             | M6 · S-602   | Single nominee, no percentages — **shipped this way, changeable per type without a release** |
| Dormant reactivation rule                      | M8 · S-805   | Flag for staff action                                                                        |
| KYC and audit retention periods                | M10          | Retain indefinitely                                                                          |
| Whether Abeyance and Manager review are wanted | Post-go-live | Available but disabled                                                                       |
