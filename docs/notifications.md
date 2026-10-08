# Notifications

What a member is told, and how it leaves the building. The design is M9's
(S-901 to S-904); this is what an operator needs to make messages actually
arrive.

## The shape of it

A **template** is configuration: an administrator writes the wording at
**Configuration → Notification wording**, and the code only decides which
event fired and what values it has. A **channel** says how it travels. The
**provider** that carries it is named in environment variables and nowhere
else, so changing provider is a settings change and a deploy, not a release.

Every intended send is a row in `notification` — the outbox — carrying the
subject and body **as they were rendered at the time**. Editing wording never
rewrites what a member was already told.

A send that fails is retried on a backoff and, if it never gets through, given
up on. Nothing is silently dropped: **Notifications** shows what is waiting,
what is being retried and what has been given up on.

## Nothing arrives until a provider is configured

A channel with nothing configured **refuses**, and the refusal is recorded
against the notification. This is deliberate. Until it was, an unconfigured
channel wrote to the server log and reported success — `sent` against a
message no member ever received, which is the one failure mode worse than an
outage.

**Notifications** names what is carrying each channel, so "nothing is being
sent" is visible rather than inferred.

`NOTIFY_*_DELIVERY=log` writes the message to the server log instead of
sending it. It is refused when `PUBLIC_APP_ENV` is `production` or unset.

## Email

### Through the Society's Microsoft 365 mailbox (`graph`)

Reuses the `GRAPH_*` app registration the document library already uses — the
same tenant and client credentials, one more permission.

1. In that app registration → **API permissions**, add the Microsoft Graph
   **application** permission `Mail.Send`. Not the delegated one: the
   application sends as itself, not as the signed-in officer.
2. **Grant admin consent.** Until this is done every send fails with an
   authorisation error from Graph.
3. Pick the mailbox to send as — a shared mailbox such as
   `noreply@albarakah.mu` is the usual choice — and set:

   ```
   NOTIFY_EMAIL_DELIVERY=graph
   NOTIFY_EMAIL_FROM=noreply@albarakah.mu
   ```

   The mailbox must exist in the **Graph** tenant, not the sign-in tenant.

`Mail.Send` as an application permission lets the app send as **any** mailbox
in the tenant. If that is too broad, scope it with an Exchange application
access policy restricting the registration to the one mailbox.

`GRAPH_DRIVE_ID` is not needed for mail — it is the document library's
setting. An environment that sends email but files no documents is a valid
configuration.

### Through a gateway (`http`)

For any other provider — a transactional email service behind a small relay of
your own:

```
NOTIFY_EMAIL_DELIVERY=http
NOTIFY_EMAIL_WEBHOOK_URL=https://<gateway>/send
NOTIFY_EMAIL_WEBHOOK_TOKEN=<optional bearer token>
```

The gateway receives `{ channel, to, subject, message }` as JSON, plus
`attachment: { url, filename, contentType }` when the wording attaches the
receipt — the gateway fetches the file from `url`.

## WhatsApp

### Why a template name is required

This is the part that surprises people, and it is not something this
application chose.

WhatsApp allows free text only inside a 24-hour window that the **member**
opens by messaging the Society first. Every notification here is
business-initiated — nobody writes in to ask whether their own application was
approved — so it may only be sent as a **template Meta approved in advance**.

The API is given the template's name and the values for its positional `{{1}}`,
`{{2}}` slots, not a finished sentence. So each WhatsApp wording carries the
name it is registered under, and the **order** of the placeholders in the body
is the order of the values sent. The editing screen shows that correspondence:

```
WhatsApp slots:  {{1}} = {{applicant_name}}   {{2}} = {{member_no}}
```

Re-order the placeholders in the body and you re-order what the provider is
sent, so the body and the approved template have to agree.

### Through Meta directly (`cloud_api`)

1. Create a Meta app with the **WhatsApp** product, and attach a WhatsApp
   Business Account.
2. Add and verify the sending phone number. Note its **phone number ID** —
   that is the id, not the number.
3. Create a **system user** with access to the WhatsApp Business Account and
   generate a **permanent** token. The token offered on the getting-started
   page expires in 24 hours and is only useful for a first test.
4. Under **Message templates**, create one template per WhatsApp wording, with
   body variables in the same order as the placeholders here. Submit each for
   approval — this takes minutes to hours, and an unapproved template is
   rejected at send time. A template that is to carry the receipt as a
   document must be created with a **document header**; then tick **Attach
   the receipt as a PDF** on that wording.
5. Set:

   ```
   NOTIFY_WHATSAPP_DELIVERY=cloud_api
   NOTIFY_WHATSAPP_PHONE_NUMBER_ID=109876543210
   NOTIFY_WHATSAPP_TOKEN=<permanent system user token>
   ```

6. At **Configuration → Notification wording**, set each WhatsApp message's
   template name and language to match what Meta approved. The defaults are
   `membership_approved` and `account_approved`; change them to whatever the
   templates ended up being called.

While the number is still in trial, Meta only delivers to recipients on its
allowed list. A test to any other number is accepted by the API and never
arrives.

### Through a gateway (`http`)

A reseller (Twilio, 360dialog, and others) that takes finished text:

```
NOTIFY_WHATSAPP_DELIVERY=http
NOTIFY_WHATSAPP_WEBHOOK_URL=https://<gateway>/send
NOTIFY_WHATSAPP_WEBHOOK_TOKEN=<optional bearer token>
```

The gateway receives `{ channel, to, message }`, plus `attachment: { url,
filename, contentType }` when the wording attaches the receipt — the gateway
fetches the file from `url`. Note that the 24-hour rule
still applies at the provider behind it — a reseller that accepts text is
mapping it onto an approved template of its own, and that mapping is theirs to
configure.

## Proving it works

**Notifications → Delivery → Send test** sends one real message to an address
or number you choose, using that wording with obviously fake values, and shows
what the provider said. It needs `config.manage`.

A test is a diagnostic, so it is **not** written to the outbox — a message no
member was meant to receive does not belong in the record of what the Society
told its members, and a failed experiment should not leave the retry job
something to attempt for the next thirty hours. It **is** audited: a control
that sends a message to an arbitrary number is one whose use should be
visible.

What the failures mean:

| What you see                                    | What it is                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `No email provider is configured`               | `NOTIFY_EMAIL_DELIVERY` unset, or missing its settings                                                                      |
| Graph `ErrorAccessDenied` / `Authorization_...` | `Mail.Send` not granted, or consent not given                                                                               |
| Graph `ErrorInvalidUser`                        | `NOTIFY_EMAIL_FROM` is not a mailbox in that tenant                                                                         |
| `template name does not exist`                  | The name here does not match an approved Meta template                                                                      |
| `(#132001)`                                     | Template exists but not in that language                                                                                    |
| Sent, but nothing arrives on WhatsApp           | Trial number: recipient not on Meta's allowed list                                                                          |
| `No push provider is configured`                | `NOTIFY_PUSH_DELIVERY` unset, or its key file does not parse                                                                |
| `Google refused the service account`            | The key file is not that Firebase project's, or was revoked                                                                 |
| `That member has no phone signed in`            | Nobody has signed in to the app as that AB Number, or they signed out                                                       |
| Sent, but nothing arrives on the phone          | The app was built without `google-services.json` (its summary says so), or notifications are off for it in Android settings |

## A receipt to its member

`receipt.issued` (S-1602) is raised by the ledger whenever a transaction's
receipt is issued, and again when an officer presses **Send** on the
receipt. Its placeholders are `member_name`, `receipt_no`, `reference`,
`kind` (Deposit, Withdrawal, Transfer, Reversal), `amount` (the bare
figure, `7,000.00` — the wording carries "Rs"), `account` and `link`. The
link opens the receipt without a sign-in for thirty days; where the link
cannot be made — no `MEMBER_SESSION_SECRET`, or no `PUBLIC_APP_URL` and no
`ENTRA_REDIRECT_URI` to take an origin from — `{{link}}` reads "Ask at your
branch for a printed copy." rather than nothing. How the link is signed and
what opens it is in `docs/ledger.md`.

Since migration 0089 the receipt can travel as a document too: `{{link}}`
with `.pdf` on the end serves the sheet as a one-page PDF
(`src/lib/ledger/receipt-pdf.ts`, drawn with jsPDF on the server, the same
token so message and file expire together). Whether a wording carries it is
its own switch — **Attach the receipt as a PDF** at Configuration →
Notification wording, per channel, off by default. On WhatsApp it goes as
the template's document header, which Meta fetches from the link itself, so
the template registered with Meta must have a document header or Meta
refuses the message; on email it goes as an attachment, fetched at send
time; a gateway receives its address under `attachment`. What was attached
is stored on the notification row, so a retry sends the same document.

## An exit, at every stage

A closure, a resignation and a demised claim (S-1705, M17) each raise four
events — `closure.*`, `resignation.*`, `demised.*` for `submitted`,
`under_review`, `approved` and `rejected` — with an email and a WhatsApp
template each (migration 0080), edited like any other. `submitted` goes
when the request reaches its chain; `under_review` when a reviewer forwards
it to a further step, with their comment; `rejected` with the reason;
`approved` at the payout, not at the decision — the money leaving is what
the member or claimant hears about, with the amount, the method and the
receipt number. A request the matrix posts at once raises only `approved`.

A closure or a resignation writes to the member, at the address their
application recorded, exactly as a receipt does. A claim writes to the
claimant — the nominee's email and mobile as captured, or the ones the
officer recorded for another person — and never to the deceased member's
own address. Placeholders: `recipient_name`, `member_name`, `reference`,
`account`, `amount` (bare figure; the wording carries "Rs"), plus `comment`
on the review and rejection events and `method` and `receipt_no` on the
payout. `src/lib/ledger/exit-notifications.ts` raises them.

## A member's own transactions

The ledger raises seven events about a member's own money (S-1803, M18,
migration 0081), email and WhatsApp wording each, edited like any other:
`deposit.posted` once the money is on the account, with the balance;
`withdrawal.submitted` when a withdrawal reaches its chain,
`withdrawal.under_review` when a reviewer forwards it, with their comment,
`withdrawal.disbursed` at the payout, with the method, receipt number and
balance, `withdrawal.rejected` with the reason; `transfer.posted` to the
holder of each side that is an account here, naming both accounts and
that holder's own balance — one message when both sides are theirs, from
the account the money left; and `balance.near_floor`, an advisory when a
posted withdrawal or transfer leaves an account within
`balance.near_floor_margin` (Configuration → Fee schedules, seeded Rs 500,
0 for none) of its type's minimum balance. A withdrawal resubmitted after
a return does not tell the member again that it is in.

The address is the one the holder's application recorded, exactly as a
receipt's. Placeholders: `member_name`, `reference` (a transfer's own),
`amount` and `account` on every one; `balance` on a posting; `comment` on
the review and rejection; `method` and `receipt_no` on the payout;
`from_account` and `to_account` on a transfer; `floor` on the advisory.
Amounts are bare figures — the wording carries "Rs".
`src/lib/ledger/transaction-notifications.ts` raises them, after the
transaction has committed and never failing it.

## The office

Five events go to staff, by email only — `app_user` has an email and
nothing else (S-1804, S-1805, `src/lib/notifications/staff.ts`):

- `transaction.awaiting`, to every active holder of a step's role when a
  transaction arrives at that step — on submission, on a reviewer's
  forward, and on resubmission after a return — except whoever sent it
  there. Every kind, exits included. Placeholders add `step` and
  `captured_by`.
- `transaction.returned`, to the officer who captured it when a reviewer
  returns it, with `returned_by` and the `comment`.
- `receipt.voided`, to every active holder of `receipt.void` other than the
  user who voided, for a transaction's receipt and a fee receipt alike:
  `receipt_no`, `voided_by` and the `reason`.
- `job.stalled`, to every active System Administrator when a job run has
  been left open for more than six hours — `job`, `run_id`, `attempt`,
  `started_at`, `last_update`.
- `job.failed`, the same people, when a job's most recent run failed —
  `job`, `run_id`, `attempt`, `started_at`, `finished_at`, `error`.

The first three carry `recipient_name`, `kind`, `reference`, `member_name`,
`amount`, `account` and `link` — the transaction or receipt page at
`PUBLIC_APP_URL` (or the origin of `ENTRA_REDIRECT_URI`); with neither set
the placeholder reads "Sign in to open it." A deactivated user is not
written to, whatever roles they still hold. The two job events carry
`recipient_name` and a `link` to the Jobs report, and are written once per
run: `docs/jobs.md`.

## A member's standing

Two events about a membership itself (S-804, S-805, migration 0086),
email and WhatsApp wording each: `member.dormant`, when the nightly
dormancy job marks a member dormant — `member_name`, `member_no`,
`last_activity` (the day, in words) and `months` (the threshold) — and
`member.reactivated`, when an officer brings them back, with the `reason`
they gave. The address is the one the member's application recorded; a
legacy member with no application is marked and reactivated all the same,
and told nothing. `src/lib/members/dormancy.ts` raises both after the
status has committed and never failing it.

Two more since the app's details updates are decided (migration 0087):
`member.details.applied`, with `fields` — the labels of what changed,
comma-separated — and `member.details.declined`, with the `reason` the
officer wrote. `src/lib/members/details-requests.ts` raises them after the
decision has committed, through the same `tellMember` the dormancy job
uses, so a member with no application on file is decided about and told
nothing.

## Push, to the member app

A third channel (migration 0118): the member app's phones. The same
templates, outbox and retry as the other two, edited at **Configuration →
Notification wording** like any other — for push the subject is the
notification's **title** and the body its text, and a phone shows a line
or two, so both are short.

**Who it reaches.** The recipient of a push row is not an address but who
it is for: `member:<id>`, `customer:<id>` or `everyone`. The phones behind
that are `member_device` rows — one per app install, registered by the app
on every start (`POST /api/v1/member/me/devices`), tied to the session
that registered it — and they are read **at send time**, so a phone
registered after the row was written still hears a retry, and one whose
session has since been revoked does not. Signing out, a branch revoking a
lost phone, a member who has left: each silences the phone with the
session. A member with no phone signed in gets no row at all, rather than a
`sent` nobody received.

**What is sent.** A member's own money, the moment it posts:
`deposit.posted`, `withdrawal.disbursed`, `transfer.posted` (the ledger
passes the phone alongside the address for every member event, so a push
wording added to any other — `withdrawal.submitted`, `balance.near_floor`
— works the same way). And the app's own news, to everyone signed in:
`partner.added` when an outlet becomes a partner on **Configuration →
Member app** (`outlet_name`, `category`, `discount`), `promotion.published`
when a promotion card goes live there (`title`, `body`) — once each, when
it happens, not on every edit; a card scheduled for a later date is not
announced on that date, since nothing watches the calendar. Each
notification carries the event code as data, which is how the app knows
which screen to open on a tap.

**Through Firebase (`fcm`).** The app is built against a Firebase project
(its `google-services.json`, see the app's `docs/push-notifications.md`);
the server sends to that project as a service account:

1. Firebase console → the project → **Project settings → Service
   accounts → Generate new private key**. The key file is a credential:
   it lives in the environment, never in the repository.
2. Set:

   ```
   NOTIFY_PUSH_DELIVERY=fcm
   NOTIFY_PUSH_SERVICE_ACCOUNT=<the key file, as one line of JSON, or base64>
   ```

Two calls, no SDK: the service account's JWT is exchanged for an hour's
access token (held in memory), then one request per phone, twenty at a
time. A phone Firebase reports as gone (`UNREGISTERED`: the app was
uninstalled, or its token rotated) is **disabled** rather than retried for
thirty hours; a provider that cannot be reached fails the row for the retry
job as any other channel's would. A broadcast is one row and many sends:
it stands as `sent` once every reachable phone was written to, with any
shortfall in the server log.

**Through a gateway (`http`).** `NOTIFY_PUSH_DELIVERY=http` with
`NOTIFY_PUSH_WEBHOOK_URL` (and `_TOKEN`) posts
`{ channel: "push", to: <device token>, platform, subject, message, data }`
per phone, for a relay of the Society's own.

**Proving it works.** A test send to a push wording takes a member's **AB
Number** rather than an address: the message goes to every phone that
member has signed in on. It refuses, naming the reason, for a member with
none.

**What a phone can see.** A notification is shown on the lock screen by
default, as a bank's is; the default wording names the account and the
amount. The Society can edit the wording to say less. Nothing but the
rendered title and text, the event code and the record id reaches the
phone — never a NIC, a balance beyond what the wording carries, or an
internal link.

## Retrying, and giving up

`notification-retry` (see `docs/jobs.md`) attempts everything whose backoff has
elapsed. Waits are 5m, 15m, 1h, 6h, 24h, giving up after six attempts — a
little over thirty hours, so an overnight outage still delivers the next
morning. Run it every fifteen minutes.

A retry re-sends **what is on the row**, never a re-render: the same text, and
for WhatsApp the same positional values. A wording change between the failure
and the retry does not rewrite a message already in flight.

Giving up marks the row `abandoned` rather than deleting it. Giving up on a
message is itself something staff need to be able to see.
