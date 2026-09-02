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

**Done:** S-601 to S-610 — Corporate capture, configurable nominee count and
percentage splits, the four-signature verification gate, the Guardian link
(searchable, and findable before the parent is even a member), the successor
guardian/beneficiary subjects, the pre-Board completeness gate, the Board
quorum sign-off, and the minor-majority transition, all the way through to
an approved member. Every M6 story is built.

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
creates that many `nominee` rows; `problemsBlockingSubmission` already looped
over every row for a subject, so per-nominee mandatory-field checks needed no
change at all. Percentages need no flag of their own: a type that adds a
mandatory `percentage` field to the nominee subject gets its split totalled
at submission — refused unless it comes to exactly 100, and silent for every
type that never configured the field. See `docs/applications.md`.

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
