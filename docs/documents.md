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

**Filing the signed form no longer needs a separate scan.** The print page
(step 2, "Application signature") already let a signatory draw on screen; what
used to happen next was print → save as PDF → go to step 3 → upload that file
by hand. Now, once the Applicant has signed, "File signed form" renders the
page as it stands — signatures included — into a PDF client-side
(`src/lib/client/pdf.ts`, html2canvas-pro rasterising the DOM and jsPDF
assembling A4 pages) and files it through the same brokered upload a manual
filing uses, so step 3 opens with it already `under_review`.

**A signature is cropped to its own ink.** The signing pad fills the screen,
so a name written across the middle of it exports as a small mark on a very
large, mostly transparent image — placed on a signature line with a set
height, it scales by its own aspect ratio and the writing disappears.
`trimmedSignature` (`src/lib/client/signature.ts`) crops to the drawn area
first, and reports an untouched pad as nothing rather than as a blank image
nobody can tell from a real one. Both signing pads use it: the printed
form's four blocks, and the Cash Deposit Form on the Payments step. The
pad's own bottom bar carries Clear and "Use this signature", and carries
them on every screen: the canvas is sized to the device pixel ratio, so on a
2x display its height attribute is twice the viewport — and a flex item will
not shrink below its content unless told to, which pushed that bar off the
bottom of the page and left an officer with nothing but Cancel (officer
feedback).

**Filing is its own button, and not Next.** It first rode on "Next: upload
documents →", which meant an officer who simply passed back through step 2
filed a second copy nobody had asked for (officer feedback). Next is a plain
link again; filing happens when the officer says so and at no other time.

**Only the last signature is kept.** Where a signed form is already on file,
filing again removes it (`POST /api/v1/documents/remove`, the same
`removeFiledDocument` the Remove button on step 3 runs) before uploading the
new one, so SharePoint holds one signed form and not a pile of near-identical
copies a digit apart in their names. The removal runs first, so a failure
there stops the second copy being created at all — the checklist reads
Missing in the meantime, which is what it genuinely is. This is the one
document type that works this way, and deliberately: a re-signature means the
earlier signature was withdrawn, not that a clearer scan of it arrived.

This is deliberately not a hard gate. If the Applicant has not signed on
screen — signing on paper instead, or not yet — the button says so and files
nothing; the officer prints and uploads on step 3 as they always could. A
SharePoint hiccup during the render or the upload leaves them on the print
page with what went wrong and that same manual path still open.

`.no-print` elements (the Sign buttons, the witness-name inputs' own hint,
the action bar) are excluded from the capture by a `.capturing` class applied
to `.print-page` itself for the moment the rasteriser runs — applied there
and not to `<body>` because Astro scopes this page's stylesheet to elements
it renders, and a class added outside that tree would not match the CSS rule
meant to hide them.

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

**Printing needs the bytes, not the link — and so, it turned out, does
showing a PDF.** `GET /api/v1/documents/content` (`document.view`, the same
permission and the same document) streams the bytes through this server
instead of handing over SharePoint's URL. Print needs it because a
cross-origin frame will not take `window.print()`, and SharePoint sends no
CORS headers for a script to fetch the file and re-host it; the Print button
points a hidden frame at this endpoint, which being same-origin can be told
to print. The viewer's own PDF frame needs it for a different reason:
SharePoint's URL comes back as `Content-Disposition: attachment`, so a frame
pointed at it downloads the file rather than showing it — the officer
clicked View and got a save prompt and an empty box. An image is still
rendered straight from SharePoint's URL: `<img>` ignores the disposition
header, and there is no reason to pay for the bytes twice.

Both the viewer and its Print live in one place, `src/components/DocumentViewer.astro`,
included by the pages that show documents — the three application kinds and a
member — rather than copied into each of them.

**An image is printed inside a page of ours, not on its own.** Sent to the
printer as raw bytes, a phone photograph of an A4 page comes out across three
or four sheets, because the browser prints it at its natural size — 4 pages
for a 900×3600 scan, measured. The print frame wraps an image in a minimal
document that tells it to fit (`@page` margin, `max-height: 100%`,
`object-fit: contain`), which puts it on one sheet whatever it was captured
at. A PDF is pointed at the endpoint directly: it carries its own page
boundaries and the browser's viewer honours them.

**Verifying a document keeps the officer where they are.** Deciding one used
to re-render the page from the top, so a reviewer working down a list of six
scrolled back five times. Each document's form posts to that document's own
anchor (`#doc-<id>`), so the response lands on the item just decided — no
script, and better than restoring a pixel offset, since deciding a document
changes its own height. The reason box is revealed by Reject and nothing
else: verifying needs no reason, and the first Reject asks for one rather
than making the round trip to be refused. Without scripting the box is
simply always visible, which is what it was before.

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

**A photographed document is shrunk before it leaves the device.** A phone
camera produces several megabytes for a page of A4, and every one of them
crosses a branch connection twice — once on the way to SharePoint, and again
each time somebody opens or prints the document. None of that resolution is
readable: a long edge of 2400px carries a scanned form comfortably.
`compressImageForUpload` (`src/lib/client/image-compression.ts`) re-encodes
to JPEG at that size before the upload begins, and the status line says what
it did ("Compressed 5.2 MB to 780 KB…") rather than leaving the officer to
wonder why the file that went up has a different name. Measured: a 3000×4000
PNG of 1.1 MB filed as 725 KB of `image/jpeg`.

It hands the file back untouched whenever there is nothing to gain — it is
not an image, it is already under a megabyte, the browser cannot decode it
(HEIC, below), or the re-encode came out no smaller. A compression that makes
a file bigger is not one worth keeping. Nothing here is allowed to fail an
upload either: a browser without `createImageBitmap`, or a canvas that will
not give up a blob, files the original.

The re-encode happens on the device and not on this server deliberately. The
bytes never pass through here — that is the whole point of the brokered
upload — so compressing centrally would mean routing every scan through this
server to save bandwidth it had just spent.

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
