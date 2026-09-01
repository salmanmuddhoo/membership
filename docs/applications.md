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
  schema and undo Feature 2.2. `ordinal` means FRD 5.3's "one or more
  Nominees" needs no migration.
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

No `/api/v1` endpoints for applications. M3's stories are all staff-facing, and
the API surface FRD Section 12 describes is better designed once M4's document
flow and M5's payments are known. The service layer is already separate from
the pages, so adding endpoints is a wrapper, not a rewrite.
