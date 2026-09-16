# Functional test findings

What walking the application as a tester turned up, and what was ruled out.
`docs/functional-testing.md` is how to run the suite; this is what it found.

Nothing here is fixed. Each is written so somebody can decide whether it is
worth fixing, and reproduce it in one step if they want to see it.

**Tested:** 16 September 2026, against the application running on a real
database, walked as all five roles.

## Open

### 1. `/receipts` answers 404 — low

**Reproduce:** sign in as anyone with `payment.view` and go to `/receipts`.

The route map declares `['/receipts/', 'payment.view']`, but there is no
`src/pages/receipts/index.astro`. The prefix covers `/receipts/<id>` and
`/receipts/reconciliation`, which both exist; the bare path does not.

**Why it is only low:** nothing links there. The sidebar goes straight to
**Receipts → Reconciliation**, and a receipt is otherwise reached from its
application. A person only finds this by typing the URL or trimming one.

**Worth knowing:** `pnpm verify:routes` cannot catch it. That checks every page
the build produces is declared and reachable — not that every declared prefix
has something at its root. So this is a gap in the check as much as in the
pages.

**Options:** a receipts list page (the Treasurer might want one anyway); or
redirect `/receipts` to the reconciliation page; or nothing, and accept that a
trimmed URL 404s.

### 2. "Applicant status" labels a control that picks the applicant type — low

**Reproduce:** sign in as a Regional Officer and open **Applications**. The
picker beside **Member Registration** is labelled "Applicant status" and offers
Individual, Corporate, Minor.

Those are membership **types**, not statuses. And "status" already means
something else on that very screen — the filter above it says "All statuses"
and lists Draft, New, Approved, which is what status means everywhere else in
the application and in the workflow configuration.

So one word means two things on one page, and the one an officer uses every
day is the wrong one. "Applicant type", or just "Type", matches both the
configuration screen it comes from (**Configuration → Membership types**) and
the rest of the system.

## Checked and found correct

Recorded so nobody re-investigates them, and so "not reported" can be told from
"not looked at". Each of these looked wrong at first and was not.

| Looked like                                                                | Actually                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A "Save draft" button rendered as raw HTML text on the capture page        | The `<noscript>` fallback. A browser with scripting on reports its contents as text; it is not displayed. Correct.                                                       |
| Recording the payment also submitted the application, with no Submit click | Intended, and commented as officer feedback: recording the payment is the last thing standing in the way, and it only submits if the officer holds `application.submit`. |
| The user menu would not open, so nobody could sign out                     | It opens. The sign-out link sits inside a menu, so its computed role is not the plain `link` the obvious selector asks for.                                              |
| The API reference named no permissions                                     | Each endpoint is a collapsed `<details>`. Every one names its permission when opened.                                                                                    |
| No notification wording was configured                                     | The wording is in `<option>` elements of the test-send picker, which a browser treats as not visible until the list is open.                                             |
| Verifying the signed application form was refused                          | It requires confirming all four signatures are on the scan first. That is the control, and it worked.                                                                    |

## What the journey proved

Walked end to end as five people, against a real database: capture with every
mandatory field the configuration asks for, four required documents filed and
confirmed present in storage, the fee schedule's own total taken and a receipt
allocated, submission, the Secretary verifying each document and forwarding,
the President approving — and a member created with the accounts their
membership type opens. The capturing officer was offered no decision at any
point, and the Secretary could not touch the application while it was still a
draft.

The receipt sequence reconciled clean afterwards, every report opened, and the
audit trail carried the approval.
