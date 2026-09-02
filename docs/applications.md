# Membership applications

The walking skeleton (M3, S-301 to S-310): an application is captured, goes
through the Secretary and the President, and becomes a Member with their
default account.

This is the first module that **reads** the reference configuration of M2
rather than storing its own copy. Nothing here knows what an Individual
application asks for.

| What                                                             | Comes from                                   |
| ---------------------------------------------------------------- | -------------------------------------------- |
| Which fields the form shows, and which are mandatory             | `membership_type_field` (S-205)              |
| Which subjects exist — applicant, nominee, guardian, beneficiary | `membership_type_field.subject`              |
| Which steps run, in what order, and which role acts              | `workflow_step` (S-209)                      |
| Which statuses exist                                             | `workflow_status` (S-209)                    |
| Which account a membership opens                                 | `account_type.is_membership_default` (S-206) |

Hiding a field in Configuration removes it from the capture form. Enabling the
Regional Manager step puts it in the chain. Neither needs a release.

## Nothing exists until a detail does

Opening the capture form does not create an application. `/applications/new`
holds the form with no row behind it; `startApplicationWithValues` returns
`null` for a form that is entirely blank, and the officer who tapped Capture on
the wrong applicant and closed the tab leaves nothing behind — no reference
spent, no row in the list, no draft for someone to delete.

The application is created by the first save that carries a value, and the
client then moves the address bar to `/applications/<id>` with `replaceState`
rather than navigating: the officer is mid-word, and reloading the page under
them to show a heading they did not ask for is not worth the interruption.

There is no Save draft button. Saving is automatic — two seconds after typing
stops, on leaving a field, on a backstop interval, and when the page is hidden.
That makes the autosave the guarantee rather than a convenience, which is why
it reports "Not saved" loudly and never reports a save that did not happen. A
`<noscript>` button is the fallback for a reader with scripting off.

The rule lives in the service, not on the page: a page that merely declines to
post is still a page that can post.

**Next moves the officer on without a save button of its own.** It flushes
whatever autosave has not yet sent, then navigates to `/applications/<id>` —
a real navigation, not the `replaceState` the first save already did, because
the officer asked to move on and the destination is a different page: the
documents, the payment, the actions the capture form never grows into.
`/applications/<id>` carries its own **Back**, for the reverse trip — browser
history where the tab has one to go back to, `/applications` otherwise, so it
always lands somewhere real rather than depending on how the tab got here.

**Flushing has to wait for a save already running, not skip it.** Leaving a
field fires `focusout`'s own save; clicking Next a moment later used to call
`save()` again to flush, and a plain "in flight" boolean made that second call
a no-op if the first was still in flight — Next then navigated before the real
save's `fetch` had landed, and the browser could cancel it mid-flight, losing
whatever that field had just been given (a Nominee detail, reliably enough to
be the reported symptom). Both `new.astro` and `[id].astro` now track the
in-flight save as a promise: a caller that arrives while one is running chains
onto it and, once it resolves, saves again only if something changed in the
meantime — so Next's flush always waits for the real thing rather than racing
it.

## The progress timeline

`applicationTimeline` (`src/lib/applications/timeline.ts`) computes six steps
— **Applicant details, Application signature, KYC Documents, Payments,
Submit, Approval Stage** — and how far a status/checklist/payment combination
has got through them. Submission and Secretary review read as the one
"Submit" step: an officer has exactly one thing left to do at that point, and
everything from there through the Secretary forwarding it on is out of their
hands. `ApplicationTimeline.astro` draws the six as a row of arrow-shaped
boxes — a `clip-path` chevron on both the right edge (pointed) and the left
(notched to match), so the box's own outline is the arrow rather than a
rectangle with a point tacked onto one side, with real spacing between them
rather than a nested/overlapping row — the first thing on the page, above
the status line, above every section it summarises, on **both** the capture
form and the full application page. An officer orients before they read
anything else. The label alone says what a step is; nothing numbers them,
since the chevron shape already reads as a sequence on its own.

Each step's label and detail turn red when `applicationTimeline` marks it a
`problem` — a mandatory field still empty, a required document still
outstanding, a return for correction — but **only once that step is current
or done**, never while it is still ahead in the chain. A step nobody has
reached yet always looks incomplete read on its own (no documents filed, no
payment taken), and that is not a problem — it is just next. Gating on state
this way is what keeps Payments from reading red while the officer is still
on Applicant details: `state !== 'todo'` in the final map, not a special case
for any one step. The box colour still shows done/current/todo regardless;
the red is layered on top of whichever it lands on, and it comes from the
same computation the rest of the timeline reads rather than the component
re-deriving "is this wrong" from the detail string.

**The capture page (`/applications/new`) never shows red at all.** Its
timeline is a starting position, not a read of anything the officer has
actually attempted (see below) — every field and document reads as
outstanding before a single character is typed, and marking that a "problem"
would be alarming someone who has not done anything yet, wrong or otherwise.
`new.astro` strips every step's `problem` flag before handing the steps to
the component; the live, real version of the timeline — problems included —
is what greets the officer on the id page once Next has actually created the
application.

On `[id].astro` every step is a real link — `applicationId` is passed in, and
each step's `href` (`ApplicationTimeline.astro`'s `STEP_HREF` map) goes
straight to that step: Applicant details, KYC Documents and Payments land on
their `?step=N`, Application signature lands on the print page, and Submit
and Approval Stage land on the application as a whole, since neither is a
page an officer steps through — Approval Stage is the Secretary's and the
President's. A step not yet reached still links — same redirect `[id].astro`
already does for a hand-typed `?step=` ahead of `furthestStep`, landing back
on the furthest step actually unlocked rather than a dead end. The capture
page (`/applications/new`) has no application yet for a step to link to, so
its boxes render as plain `<div>`s instead.

The section is `sticky`, positioned just under the app header rather than
under it: the header's own height varies with viewport and content wrap, so a
small script in `ApplicationTimeline.astro` measures `#app-header` (added on
`DashboardLayout.astro`'s `<header>`) after layout and on resize, and writes
it to a `--app-header-height` custom property the timeline's `top` reads.
Scrolling the page never scrolls the timeline out of view.

The capture page has no application behind it yet (see above), so its
timeline is a starting position rather than a read of a real record: every
mandatory field counts as outstanding and so does every required document the
membership type's checklist configures — passing `0` for either would read as
**done** rather than **not yet begun**, ticking off a step nothing has
happened on. It does not update as the officer types; the id page reached on
Next is where the live version lives, and reaching for one is one Next click
away.

## A red border has to stay honest without a reload

A mandatory field's red border is drawn once, from what `problemsBlockingSubmission`
found still empty when the page rendered — and autosave then keeps saving in
the background with no reload, which used to leave that border exactly as
wrong as it started: a field the officer had since filled in stayed red until
they reloaded, reading as data that was never saved when it had been. The
same staleness reached the capture form's own **Next** button, whose disabled
state and "N required fields still empty" label were drawn from the same
page load.

Both are now kept live in `[id].astro`'s script rather than the server's:
every mandatory input carries `data-mandatory` (`CaptureFields.astro`), and an
`input`/`change` listener recomputes that one field's border and the whole
form's remaining-empty count on every keystroke — a purely client-side
correction, since the server-rendered HTML was never wrong about what was
true at the moment it rendered, only about what became true afterwards
without it.

## The wizard: one step visible at a time, while it is the officer's

Capture, documents and payment used to be three sections stacked on one long
page. They are now three of five numbered **steps**
(`CAPTURE_STEP` … `SUBMIT_STEP` in `[id].astro`), and only one is on screen —
selected by a `?step=` query parameter, Back and Next at the foot of each:

1. **Capture** — the applicant/nominee/etc. fields, exactly as before.
2. **Print** — `/applications/<id>/print` itself, not a section here (see
   below).
3. **Documents** — the KYC checklist.
4. **Payment** — recording what was taken.
5. **Submit** — the "Your next step" action, once there is one to take.

A step is reachable only once the one before it actually is done, on the same
evidence the progress timeline reads — `blocking.length`, the documents
still `missing`, whether a live payment exists — computed fresh on every
request as `furthestStep`, never stored. Requesting a step ahead of that
(`?step=4` before the documents are filed) redirects back to it rather than
rendering a step nothing unlocked; requesting none at all resumes at
`furthestStep` rather than always restarting at Capture, so reopening a draft
someone else's autosave or a previous session already carried further does
not make them walk it again. Going **backward** — reviewing what was
captured, reprinting the form — is always allowed; only going forward is
gated.

**Step 2 has no section of its own.** `/applications/<id>/print` already
shows a preview with a Print button, which is what step 2 asks for, and its
own "done" signal — the signed form coming back and being filed — is
something step 3 produces, not something step 2 could gate step 3 on without
a paradox. So Next from Capture goes straight to the print page, and Next
there goes straight to Documents; `?step=2` on `[id].astro` itself exists only
to redirect a hand-typed URL somewhere real.

**None of this applies once the application is no longer editable.** A
submitted application is read by the Secretary and the President in full —
every section, not a walkthrough — because they are deciding on the whole of
it, not filling anything in in order. The gating is `isEditable &&` on every
step; without it, everything renders exactly as it always did.

## Submitting requires more than the form fields

`submitApplication` used to check only `problemsBlockingSubmission` — the
form fields — before moving an application to `new`. It now calls
`submissionReadiness`, which also refuses while a required document is still
`missing` (filed, not verified — verifying is the Secretary's job, the next
step in the chain, and cannot be a precondition of reaching it) or while no
live payment has been recorded. Both refusals are a plain `ApplicationError`,
not the `{ problems }` shape field-completeness returns, because they are not
a list of fields to fix — there is exactly one thing missing, and the message
says what it is.

The wizard's own gating (above) means an officer can only reach Submit once
both are already true, so in the ordinary flow this refusal is never seen —
but it is not the wizard's job to be the only thing standing between an
incomplete application and central processing. `submissionReadiness` is
exported and shared: the wizard and the server read the same three counts, so
neither can drift from what the other allows.

## A minor's guardian has to be someone real (S-604, S-605)

The guardian block on a Minor application asks for a Member No. and a NIC —
plain text fields, like any other — but filling them in is not the same as
naming a real guardian. So `problemsBlockingSubmission` (`capture.ts`)
resolves whatever was typed the same way `findGuardian` below does: against
`member` first, joined back to the applicant party of whichever application
created that member (NIC is not a column on `member` itself — it only ever
lived on the application that produced it); failing that, against an
Individual application still in progress, by its own reference or by NIC.
Either identifier resolving to either kind of match is enough; neither
resolving, resolving to someone who is a member but not active, or resolving
to an application that was rejected (a dead end — it will never produce a
member) is reported the same way an empty mandatory field is: it blocks
submission, and it blocks the wizard from reaching Documents or Payment, on
the same `blocking` count the timeline and the Next button already read.

**A guardian does not have to be approved yet.** A parent and their minor
routinely join at the same visit — the parent captured first, exactly as any
Individual application is, and not yet decided when the officer starts the
minor's form. Requiring the parent's own approval before the minor's
application could even be submitted would force a second visit for no
reason the parent's status actually changes, so submission accepts a
guardian who resolves to either kind of match, not only an active member.
What it still refuses is a guardian nobody can find at all, or one whose own
application has already been rejected.

The difference from an empty field is that a filled-in, wrong Member No.
looks fine at a glance — the red border it gets is the same one an empty
field gets, but nothing on the page says _why_ a filled-in field is red. The
capture page's **Needs attention** section exists for exactly this: unlike
the "still required" list (which only appears after a real submit attempt),
it always shows a blocking problem whose value is non-empty — the "must join
as a member first" or "is not an active member" message — the moment the
page renders it, without the officer having to attempt and be refused first.
An empty mandatory field is not listed there; the asterisk and the border
already say what it needs.

**Successor guardian and Takaful beneficiary (S-606, S-607) needed no new
code.** Both were already configuration: the successor guardian is the Minor
type's own `nominee` subject (distinct from an Individual or Corporate
nominee — the type decides what "nominee" means), and the beneficiary is its
own subject, both with their own checklist requirements from migration 0010.
The same is true of Corporate capture (S-601): the fields, checklist and fee
schedule were seeded in M2, and nothing in `capture.ts` has ever known a
membership type by name — the generic pipeline just had to be pointed at it
by a test to be sure. `workflow.test.ts` now carries end-to-end tests for
both.

### Finding a parent before they are a member, and never typing them by hand

The guardian block asks for a Member No. and a NIC, which used to mean typing
both in blind. `CaptureFields.astro` shows a search box above them whenever a
type's guardian subject configures both fields (checked by field key, not by
assuming "guardian" always means this — the type still decides): type two
characters and it calls `GET /api/v1/applications/guardian-search`, which
wraps `searchGuardianCandidates` (`capture.ts`).

**The search finds two different kinds of person, on purpose.** A parent and
their minor can join at the same visit — the parent captured first, exactly
as any Individual application is, and _not yet decided_ when the officer
starts the minor's form. So the search matches:

- **Active members**, by surname, name, NIC or Member No. — read the same way
  `findGuardian` above resolves one.
- **Individual applications not yet decided** (any status except `approved`
  or `rejected`) — by surname, name or NIC. `rejected` is excluded because it
  will never produce a member; `approved` is excluded because that person
  already has a member row, found by the first arm — listing both would show
  the same parent twice.

Picking a result fills in the guardian's surname, name, NIC, Member No. and
mobile fields exactly as if the officer had typed them — a shortcut to a
form that was already valid, not a new kind of field, so nothing about how
those values are stored, normalised or validated changes. What goes in the
Member No. field for someone who is not a member yet is their **application's
own reference** (`APP-2026-000123`), not a real Member No. — human-recognisable
on the form, and never confusable with one (the two never share a shape).

**These fields are read-only, not merely pre-filled.** Since the search is
the only legitimate way to name a real guardian, `CaptureFields.astro`
renders the guardian's surname, name, NIC, Member No. and mobile as `readonly`
whenever the search is offered — an officer can pick a different result, but
cannot hand-edit a real record's details into something that no longer
matches it. Relationship is read-only too, but never typed or picked at
all: it is worked out from the minor's own gender (Male files as _Son_,
Female as _Daughter_), synced live so a guardian picked before the minor's
gender is filled in still ends up correct once it is.

**This does not change when a minor can be submitted.** `findGuardian` still
resolves against `member` or a not-yet-decided Individual application, by
Member No. **or NIC** — and NIC is what actually carries a not-yet-a-member
parent through: it does not change when their application is renamed on
approval (`reference` becomes their `member_no`, see Identifiers below), so
nothing about the minor's own form needs revisiting once the parent is
approved. The Member No. field the search filled in with an `APP-` reference
simply stops mattering at that point; the NIC match is what resolves them.

## Nominees: how many, and whether they must add up (S-602)

FRD 5.3 asks for "one or more Nominees where configured" — the schema has
supported that since S-301 (`application_party.ordinal`), but capture only
ever created and rendered one. `membership_type.nominee_count` is the
setting that changes that, per type, without a release: `insertApplication`
creates that many `nominee` rows at capture time, `CaptureFields.astro`
renders that many field-grid blocks (each labelled "Nominee _n_ of _N_" once
there is more than one), and both capture pages read `field.nominee.<n>.*`
back off the form instead of always `.1.`. An administrator changes the count
from **Membership types**, next to the fields it applies to — the control
only appears for a type that has a `nominee` subject at all.

Nothing about validation had to change to make this work.
`problemsBlockingSubmission` already looped over every `application_party`
row for a subject, not a hardcoded one — so a type with three nominees
configured gets three sets of missing-field checks, each naming its own
nominee, for free.

**A percentage split needs no flag of its own.** A type that wants its
nominees to divide the membership by percentage adds a mandatory
`percentage` field to the `nominee` subject the same way it adds any other
field — `problemsBlockingSubmission` detects the rule from that field's
presence alone, so it can never drift out of sync with whether the field
actually exists. It only totals the split once every nominee has entered a
value: an incomplete one is already reported as its own missing field, and
totalling it too would be noise on top of that. A total that is not (allowing
for rounding) exactly 100 blocks submission, naming the actual total so the
officer knows which way to correct it.

## The chain

```
draft ──capture──▶ new ──secretary_review──▶ submitted_for_approval ──president_decision──▶ approved
  ▲                 │                              │
  └──── returned ◀──┘ (Secretary returns)          └──▶ rejected
```

`regional_review` sits between capture and Secretary review as a **gate** — a
step that must be acted on but does not move the record. It ships disabled
(decision 2); `activeChain()` skips it, so switching it on adds it to the chain
with no code change.

Migration 0011 corrected a mistake in 0010, which had mapped FRD 7.4.3's status
list onto steps without a draft state and so made capture read
`new → submitted_for_review`. FRD 7.4.3 defines New as "captured … **and
submitted**", so capture is what produces New. `Draft` and `Returned for
Correction` were added as configuration rows, which 7.4.3 explicitly
anticipates.

`submitted_for_review` remains an active status because the FRD confirms it,
but no enabled step produces it: it is the state for a Secretary _claim_
action, which the walking skeleton does not need.

## Nothing incomplete reaches the Board (S-608)

Submission (S-304) already refuses an empty mandatory field, an unfiled
document, or money not yet taken. Forwarding to the Board re-checks three
things submission cannot guarantee stay true between then and now:

- Every required document has actually been **Verified**, not merely filed —
  filing is the officer's job, verifying is the Secretary's own, and it is
  what this gate exists to make sure happened before the file leaves their
  hands.
- The payment recorded at submission is still live — voided or refunded
  since, and the money submission checked for is no longer there.
- A guardian is a claim about another member's status, not a fact frozen at
  submission — re-resolved the same way `problemsBlockingSubmission` does,
  in case that member has since stopped being active.

`boardReadiness` (`workflow.ts`) reports all three at once; `reviewApplication`
refuses a `forward` outcome while any is outstanding, naming every one
together so the Secretary chases them in one pass rather than one refusal at
a time. **Return for correction is untouched by this gate** — sending work
back to the officer never needed the Board's own preconditions met, and
still does not. `[id].astro` shows the same list before the Secretary even
tries, next to a disabled Forward button, exactly the way a missing
mandatory field is shown before Submit is tried.

## A quorum above one needs that many sign-offs (S-609)

`workflow_step.quorum_count` (S-209) has shipped at 1 everywhere since M2,
where a single decision has always transitioned the record immediately —
`decideApplication` still does exactly that at quorum 1. Configured above 1,
the President's decision becomes a Board's: `application_step_signoff`
records one row per distinct person who acts, and the step itself does not
complete until enough of them have approved.

**A reject is never something a quorum waits out.** FRD 7.10.9 asks for an
attributable decision, not a vote nobody can trace to a person, so a single
reject — from anyone entitled to decide — ends it immediately, whatever else
is already signed off. Quorum only ever governs how many _approvals_ it
takes to move forward.

The same person cannot sign off twice on the same step of the same
application — checked before the write, refused the same way a segregation
conflict is. Every sign-off is audited under `membership.application.approved`
whether or not it is the one that completes the step, so who signed off is
never only in this one table. `signoffsFor` reads them back in order;
`[id].astro` shows who has signed off and how many more are needed, but only
when a step's quorum is actually above 1 — the common case shows none of
this at all, exactly as before S-609 existed.

## Three controls, and they are not interchangeable

Every action passes all three:

1. **A permission** — may this person review applications _at all_?
2. **The configured step's role** — is review this role's job in this chain?
3. **Segregation of duties** — has this person already acted on **this record**
   in a way that bars them (S-203)?

The first two are about the person's job. The third is about this record's
history, and it is the only one that can refuse someone otherwise entirely
entitled to act. The segregation check reads `audit_event`, which is
append-only: someone cannot erase their earlier action to unblock the later
one.

The action names are the contract with the rules seeded in migration 0009:

| Action                            | Recorded when                                          |
| --------------------------------- | ------------------------------------------------------ |
| `membership.application.captured` | Submission — once per person who worked on the capture |
| `membership.application.reviewed` | Secretary review                                       |
| `membership.application.approved` | President decision                                     |

Renaming one of those in `workflow.ts` without changing the rule silently
disables the control, which is why they are named once as constants.

## Walking it through yourself

Segregation means **one person cannot do all three steps**. To try the whole
chain you need three accounts, or one account and three role changes between
steps (each change is audited). Create them under **Staff accounts** and assign
Regional Officer, Secretary and President.

The System Administrator role deliberately holds only `application.view` and
`member.view`. Administering the system is not running the Society's business,
and an administrator who could approve applications would defeat both the
permission model and the segregation rules above it.

## Storage

- `membership_application` — the application, its status and who captured it.
- `application_party` — one row per subject instance, values as `jsonb` keyed
  by `field_key`. A column per field would put the form's shape back in the
  schema and undo Feature 2.2. `ordinal` is what lets FRD 5.3's "one or more
  Nominees" be a row count rather than a schema change — see S-602 below for
  how many rows a given type actually gets.
- `application_transition` — the chain itself (S-307), append-only. `audit_event`
  records everything; this records the approval chain in order, so
  reconstructing it does not mean filtering a table that holds every action.

## Identifiers

| Format            | Sequence                    | Gaps                                            |
| ----------------- | --------------------------- | ----------------------------------------------- |
| `APP-YYYY-000001` | `application_reference_seq` | Acceptable — a rolled-back capture consumes one |
| `AB0001`          | `member_number_seq`         | Acceptable                                      |

There is no account number. **A member is one number and two accounts:** AB0001
is the member, their Shares account and their MSA. Storing that number on each
account as well would invite the copies to disagree, and there is no question
which would be right — so the accounts carry no number of their own and the
screens read it from the member.

**An approved application takes the member's number as its own reference.**
`APP-YYYY-000001` is what it is called before anyone is a member — allocated at
capture, when there is nothing else to call it. `createMemberFromApplication`
overwrites `membership_application.reference` with the new member's `member_no`
inside the same transaction that creates them, so from approval onward there is
one identifier, not two: the application, the Shares account and the MSA all
read AB0001. A rejected application keeps its `APP-` reference forever — no
member is ever created from it.

This is a rename, not a new record, and it reaches everything that reads the
`reference` column live: the applications list, receipts, the printed form if
reprinted. It does **not** reach back and correct what was already fixed at an
earlier moment — the signed form the applicant already has in hand was printed
with `APP-2026-000003` on it, and any document filed before approval sits in a
SharePoint folder of that name (`applicationFolderPath` reads whatever
`reference` says at the moment a document is filed). A document filed _after_
approval goes to a new, AB-numbered folder instead. Both are archives of a
moment, not live views, and are expected to disagree with a record that has
since moved on — the same principle as a superseded fee version.

Acceptable, but not free: it is why an empty form creates nothing. A reference
allocated to a form nobody typed into is a gap with no story behind it.

Receipt numbers are the ones where a gap **is** an audit signal (AD-11), and a
sequence is the wrong tool there. M5 allocates them as committed rows instead —
see `docs/payments.md`.

The legacy import in M7 must advance `member_number_seq` past whatever the
existing register contains: FRD 7.5 requires Member IDs to stay unique
including for migrated records.

## Telephone numbers

Stored in E.164 (`+23057891234`), converted at capture. S-301 is right that
this cannot be backfilled: a column mixing `5789 1234` with `+230 5789 1234`
cannot be resolved once nobody remembers which entries were Mauritian. Anything
the normaliser cannot place is **refused** rather than guessed — prefixing +230
onto nine digits produces something that looks right and can never be dialled.

## Not built yet

`GET /api/v1/applications/guardian-search` (S-604, above) is the one
`/api/v1` endpoint applications has today, and it exists to serve the
capture form's own search widget, not FRD Section 12's public API surface —
that is still better designed once M4's document flow and M5's payments are
known. The service layer is already separate from the pages, so adding the
rest is a wrapper, not a rewrite.
