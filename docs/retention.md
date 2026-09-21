# Retention and disposal

How long each kind of record is kept, and what happens when a period is
reached (S-1003).

> **Nothing is disposed of today.** Every period ships unset, and unset means
> retain indefinitely — exactly what this system has always done. Disposal
> begins only when somebody enters a number on **Configuration → Retention**.

## Why the mechanism came before the periods

The backlog treated the Society's unstated retention periods as blocking this
work. It is the other way round. The periods are a policy decision and the
mechanism is an engineering one, and coupling them meant the Society could not
state a policy without a release, and a release could not happen without the
policy.

So the periods are configuration. The Society states its policy by using the
system, and the number it enters is audited like every other configuration
change — which also means the audit trail, not somebody's memory of an email,
is the record of who authorised a disposal and when.

## What can be disposed of

| Record                                  | Anchored on                      | What goes                                                             |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| **Notification log**                    | When the message was sent        | The whole row — recipient, subject and the text of what was said      |
| **Applications that were not approved** | When the application was refused | The applicant's captured details, the documents, the SharePoint files |
| **Drafts that were never submitted**    | When the draft was last touched  | The whole application                                                 |

The rule behind those three differences is one sentence: **disposal removes the
personal data, and keeps the fact that something happened** — except where the
record is only personal data, and then it goes too.

- A notification row **is** the personal data: a member's number or address,
  and the full text of the message. Redacting it leaves an empty shell, so the
  row goes.
- A refused application is not. Its reference, its status and the date it was
  refused say nothing about anybody. Those stay, and the Society can still
  answer "was this application refused, and when" without holding the identity
  papers that prove who it was about.
- An abandoned draft is neither. Nobody submitted it and nobody acted on it. It
  is half-typed details and nothing else, so it goes through the same path an
  officer deleting a draft already uses — including that path's refusals: a
  draft that has been paid against, or that has any history behind it, is not
  disposed of, and the run counts it and carries on.

## Two things this deliberately does not do

### A member's own KYC documents are not disposable

The period for those runs from the **end of the relationship**, and this system
has no end of relationship yet: resignation and closure are M8, deferred to
Phase 2. The only date available today is the upload date, and anchoring on it
would destroy an active member's identity papers because they joined a long
time ago. That is not a retention policy; it is data loss with a schedule.

When M8 lands, closure gives the anchor and this becomes a fourth class.

### The audit trail cannot be disposed of at all

Not an oversight, and not something the disposal job quietly skips. It is
prevented twice over, by design:

- Migration 0004 puts a trigger on `audit_event` that refuses `UPDATE`,
  `DELETE` and `TRUNCATE` outright.
- Migration 0005 revokes those privileges from the application role as well, so
  an attempt fails at the permission check before any row is touched.

Those two controls are what make every other control in the system provable.
`docs/security-review.md` leans on them, and so does `docs/restore.md`, which
uses the latest audit event to establish the point a recovery should restore
to.

**So if the Society states a retention period for audit records, that is a
decision to weaken this, and it needs to be taken as one.** Honouring it means
a narrow, audited hole in both controls — a function that may delete rows older
than the period and nothing else. That is buildable. It is not something to
arrive at as a side effect of a backlog line mentioning audit, so it is put
here as a question rather than answered in code.

Worth knowing before answering it: an audit row holds who did what to which
record and when, plus the before and after values. Where those values are an
applicant's own details, the personal data the Society would be disposing of is
already in there.

## Setting a period

**Configuration → Retention**, which needs `retention.manage` — deliberately
not `config.manage`. This is the one control in the application that schedules
the irreversible destruction of member data, and it should not come attached to
the ability to rename a document type.

Beside each period the page shows **how many records would be disposed of
today**. That is the point of the screen: a number of months has no visible
consequence until somebody can see what it destroys, so the count is shown
before anything is saved and again afterwards.

Periods are bounded at 6 months and 600. Neither is a legal limit; they are a
guard against 6 being typed where 60 was meant, which is the realistic way this
control goes wrong. Leaving the field empty keeps those records indefinitely,
and clearing a period is always safe — it stops disposal, it does not bring
anything back.

## The job

```bash
pnpm job retention-disposal
```

Run **daily**, alongside `document-expiry`. Nothing here is time-critical: a
record disposed of tomorrow instead of tonight is a record one day past its
period, and a daily run keeps each one small once the first sweep is behind it.

It is safe to schedule before the Society has decided anything. A class with no
period is not queried at all, so on a database where nothing has been set the
run reads three rows and exits.

The run works in passes, each its own bounded transaction, so a first sweep of
a years-deep log does not hold one transaction open across the whole table and
a `SIGTERM` between passes stops it cleanly with everything so far committed.
It is idempotent: notifications and drafts are gone and so not selected again,
and a redacted application carries `disposed_at`. An interrupted run resumes
rather than repeating.

Every disposal is recorded in the audit trail under `retention.disposed`, with
no actor and the job named — the same shape `document-expiry` uses for a change
nobody requested. The entry deliberately records the reference and the counts
and **never what was disposed of**: keeping a copy of an applicant's details in
a table nobody can edit afterwards would be no disposal at all. The notification
log writes one entry per run rather than one per row, or a first sweep would
write thousands of identical entries into that same uneditable table.

## If a disposal goes wrong

There is no undo. `docs/restore.md` is the only route back, and it recovers the
database to a point in time — so it also un-does everything else that happened
since. SharePoint files deleted by a disposal are covered by Microsoft 365
retention, on its own timeline, not by the database restore.

A SharePoint delete that fails leaves the application **not disposed of** —
deliberately. Redacting it anyway would leave an applicant's identity papers in
SharePoint with nothing left in this system able to name them, which is the
outcome disposal exists to prevent. The run logs `files not removed,
application NOT disposed of` with the reference, counts it, carries on with
everything else, and offers it again on the next run.
