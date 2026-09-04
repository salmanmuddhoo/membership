# Documents and SharePoint

SharePoint is the **official repository** for member documents; this application
is the **metadata system of record**. Every call to SharePoint goes through
`src/lib/documents/` — no page and no browser talks to Microsoft Graph on its
own initiative.

## Two tenants, not one

This trips people up, so it is stated first.

|           | Directory                                                         | Used for             |
| --------- | ----------------------------------------------------------------- | -------------------- |
| Sign-in   | **Entra External ID (CIAM)** tenant, created for this application | Staff authentication |
| Documents | Al Barakah's **Microsoft 365** organisational tenant              | SharePoint           |

They are separate directories. The `ENTRA_*` credentials cannot reach
SharePoint, and the `GRAPH_*` credentials cannot sign anyone in. Graph access
needs **its own app registration, in the Microsoft 365 tenant**.

The application authenticates to Graph as **itself** (client credentials), not
as the signed-in officer. Officers therefore need no SharePoint licence and no
per-user permissions, and this application decides who may file what. The cost:
SharePoint sees a single identity, so _who did what_ lives in our audit trail
rather than SharePoint's version history.

## The constraint this spike exists to settle

A Vercel serverless function accepts a request body of about **4.5 MB**. A photo
of an identity document, taken on a tablet, is routinely **3–12 MB**.

So a document cannot be POSTed to our API and forwarded. The request is rejected
**before our code runs** — no amount of care inside the handler helps. This is
exactly the limit S-112 exists to find now rather than during M4.

## What was proven

`src/lib/documents/upload.test.ts` runs a stand-in for Graph that enforces the
real protocol: 320 KiB chunk alignment, `Content-Range` continuity, and the size
declared up front. Against it:

- **A 9 MB file transfers intact** — twice the request-body limit — and the
  reassembled bytes are compared to the sent bytes exactly. Reversing the bytes
  of each chunk makes the test fail, so the assertion is real.
- A rejected chunk **fails the upload** rather than reporting success (S-408).
- The backend, not the caller, decides the folder, the name, the size ceiling
  and the permitted content types.

What is **not** proven here: the real tenant. Nothing has run against actual
SharePoint, because that needs credentials this environment does not have. The
protocol is exercised; the configuration is not.

## The mechanism

Graph's large-file protocol is two steps:

1. **The backend creates an upload session.** It chooses the folder from the
   member record, sanitises the file name, checks the size and content type, and
   asks Graph for a session on exactly those terms.
2. **The bytes go straight to Microsoft.** Graph returns a `uploadUrl` that is
   _pre-authenticated_ — it carries its own short-lived token, is scoped to that
   one file in that one location, and needs no `Authorization` header. The
   client PUTs ranges to it.

The client therefore never receives the application's client secret or any
credential that reaches anything else (**AD-09**), and our function's body limit
never applies because the bytes never pass through it.

## The decision, now settled

**The browser talks to Microsoft directly.** That is a real departure from
"SharePoint access must be through the backend/integration layer", so it was put
to the operator rather than taken by default.

> **Decided 26 August 2026: option A, the brokered session.** The client
> receives a capability to write one named file to one folder, expiring in
> hours; the backend continues to decide every term of the upload. What is
> delegated is the transfer, not the authority.

The alternatives were considered and are kept below, because the reasoning
matters if the requirement is ever revisited — particularly if content in
transit needs inspecting, which option A cannot offer.

|                                         | How                                                            | Trade                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Brokered session** _(implemented)_ | Backend creates the session; client PUTs to the scoped URL     | No credential leaves the backend, no size limit, one network hop. But the browser reaches a Microsoft endpoint.                                                                                 |
| **B. Relay through the API**            | Client sends chunks to our API; backend forwards each to Graph | Literally all access through the backend. But every chunk must fit the 4.5 MB limit, we pay double egress and double latency, and function execution time becomes a factor on slow connections. |
| **C. Stage in Azure Blob**              | Client uploads to Blob; a job moves it to SharePoint           | Decouples the upload from SharePoint's availability. But it adds a component and puts a second copy of member documents somewhere that must then be secured and swept.                          |

**A was chosen.** The session URL is not a credential in any meaningful
sense — it is a capability to write one named file to one folder, expires in
hours, and grants nothing else. The backend still decides every term of the
upload; what it delegates is the _transfer_, not the _authority_. B is the
purist reading, and would be the right answer if the requirement were about data
residency or inspecting content in transit rather than credential custody.

## Setting it up

In the **Microsoft 365 tenant** (not the CIAM one):

1. Register an application; note the tenant id, client id; create a client
   secret.
2. Grant the Graph **application** permission `Sites.Selected` — _not_
   `Sites.ReadWrite.All`, which would grant every site in the organisation.
3. Grant that app write access to the one document library, per site:
   ```
   POST /sites/{site-id}/permissions
   { "roles": ["write"], "grantedToIdentities": [ { "application": { "id": "<client-id>" } } ] }
   ```
4. Find the drive id: `GET /sites/{site-id}/drives`.

Then set `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and
`GRAPH_DRIVE_ID` per environment. Test and production should use **different
sites**, so a test upload can never land in the real member library.

### Until that is done, filing a document fails — visibly

`GET /api/v1/health` reports `sharePoint: "configured"` or
`"not_configured"`. It reads the settings only and makes no network call, so a
health check never waits on Microsoft and an outage at their end is not
reported as one at ours.

Filing a document in an environment that is not set up answers **503** with
`SharePoint is not configured for this environment…`, not a 500. The
distinction matters: 500 means this application has a defect and there is
nothing an operator can do; 503 with that message names the thing to go and
fix. Wrong or expired credentials are told apart from missing ones, and a
refusal by the library is reported as the library's rather than as a problem
with the file being filed.

The detail behind any of them — the AADSTS code, the Graph error body — is
logged against the request's correlation id and never returned. Quote that id
when reporting a problem and the exact cause is one search away.

## What M4 built on it

The spike endpoint `/api/v1/documents/upload-ticket` has been **retired**. It
filed to a `Members/{reference}` folder that nothing else reads and created no
`document` row, so a file sent through it appeared on no checklist and in no
audit trail. Two endpoints replace it, and they are the only way a document is
filed:

| Endpoint                               | Permission        | What it does                                                           |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `POST /api/v1/documents/begin-upload`  | `document.upload` | Records the intent, creates the folder, returns the scoped URL         |
| `POST /api/v1/documents/commit-upload` | `document.upload` | Asks Graph whether the file is there and the right size, then files it |

Between the two the version is `pending`, and the checklist reads **Missing** —
so a tablet that loses signal halfway leaves nothing that looks filed.

Three rules are worth knowing because they are not obvious from the endpoints:

- **Only the person who began an upload may commit it.** Not a theft concern —
  the bytes are whatever they are, and Graph is what confirms them. It is that
  the commit writes `document.filed` to the audit trail, and segregation of
  duties reads that trail to decide who may not verify the document. Letting
  anyone commit anyone's upload would put the wrong name against the filing.
- **A replacement changes nothing until it arrives.** The document's state,
  its verdict and its expiry are rewritten at commit, never at begin, so a
  failed replacement leaves the good file that is still live exactly as it was.
- **File type and size are checked before the folder is created**, so a
  refusal costs no round trip and leaves no empty folder behind.

Verifying and rejecting are ordinary form posts on the application page rather
than API endpoints: the Secretary is at a desk, and a form works without
scripting. Filing cannot be, because the bytes go from the device to Microsoft
— so the file input is disabled until the script enables it, and says why.

**The signed form cannot be marked Verified on the strength of the file
existing alone (S-603, FRD 5.4).** The printed form always carries four
signature blocks — Applicant, Nominee, Witness 1, Witness 2
(`SIGNATURES`, `documents.ts`, shared with the print page so the two can
never disagree about what "all four" means) — regardless of membership type.
Reviewing a `signed_form` document shows four checkboxes, one per block; a
verify attempt with fewer than four checked is refused, naming which are
still missing. Every other document type is untouched by this — the check
is keyed on the document TYPE's code, not on being reviewed at all.
Rejecting still records whichever were checked (`document.confirmed_signatures`),
so a Secretary who rejects for an unrelated reason — a blurry scan — does not
lose the ones they had already confirmed when the replacement arrives.

### Viewing and removing what was filed

**Viewing is brokered the same way filing is, in the other direction.**
`POST /api/v1/documents/view-url` (`document.view`) asks Graph for the current
committed version's metadata and returns its `@microsoft.graph.downloadUrl` —
a pre-authenticated URL good for one GET, no further sign-in. That is what
lets an officer open a document at all: they have no SharePoint account (see
"Two tenants, not one" above), so the item's ordinary `webUrl` is not usable
to them. The URL is fetched on click rather than embedded in the page — it is
a secret in the same sense an upload ticket is one, and a page that sat open
for an hour would otherwise carry a live one in its HTML the whole time.

**Removing a filed document is Replace without the replacement — and, unlike
Replace, it does not keep the file.** `removeFiledDocument` (`document.upload`)
supersedes the live version exactly as a genuine replacement would (S-409),
then deletes it from SharePoint (officer feedback). Replace's own "versions
are never deleted" guarantee is about a _superseded_ filing — it exists to
keep a signed form retrievable after a clearer scan replaces it, which
presumes the earlier filing was a real record of something. A mistaken
upload was never that, so there is nothing worth keeping: the item reads
Missing again, exactly as if nothing had been filed, and can be filed afresh.
The database row updates first and the SharePoint delete happens after, so a
delete that fails (or never runs) still leaves the checklist correctly at
Missing — an orphaned file in that case is a cleanup problem, not a data
one. Available on any state Replace already is — S-409 lets an officer
replace even a verified document without restriction, so this is not a new
door, only the other side of an existing one.

The **Replace** button itself is gone from `[id].astro`. It offered upload and
delete-then-upload as one control, which read as one action while quietly
being two; a filed document now shows a small × (`removeFiledDocument`,
above) instead, and the Upload control only reappears once that × has been
used — one thing to do with a document at a time, visible rather than
implied. Both — the × and Upload — sit on the same line as the document's own
name and status, not in a row underneath it.

Still open for later in M4: HEIC previews (accepted, but a browser cannot render
one, so the thumbnail is a generic icon), and resuming a dropped transfer via
`nextExpectedRanges` rather than restarting it.

## Recommendation for M4 (from the spike, kept for the record)

- Keep the ticket-then-upload shape: the API authorises, the device transfers.
- **Record metadata only after Graph confirms the item** (S-406, S-408). The
  upload is not done until the finished file comes back with an id; anything
  else risks a member record pointing at a document that does not exist.
- The permission `document.upload` does not exist yet, so the endpoint is
  unreachable — deny-by-default means it stays that way until M4 creates the
  permission and grants it. That is the intended state, not an oversight.
- Resumable uploads come free with the session: a dropped connection can query
  `nextExpectedRanges` and continue. Worth using on the tablet, where the
  connection is the least reliable part.
- Expect HEIC from iPads. It is in the allow-list, but a browser cannot preview
  it, so M4 should either convert on the device or accept that the thumbnail is
  a generic icon.
