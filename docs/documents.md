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

## Recommendation for M4

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
