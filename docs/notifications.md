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

The gateway receives `{ channel, to, subject, message }` as JSON.

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
   rejected at send time.
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

The gateway receives `{ channel, to, message }`. Note that the 24-hour rule
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

| What you see                                    | What it is                                             |
| ----------------------------------------------- | ------------------------------------------------------ |
| `No email provider is configured`               | `NOTIFY_EMAIL_DELIVERY` unset, or missing its settings |
| Graph `ErrorAccessDenied` / `Authorization_...` | `Mail.Send` not granted, or consent not given          |
| Graph `ErrorInvalidUser`                        | `NOTIFY_EMAIL_FROM` is not a mailbox in that tenant    |
| `template name does not exist`                  | The name here does not match an approved Meta template |
| `(#132001)`                                     | Template exists but not in that language               |
| Sent, but nothing arrives on WhatsApp           | Trial number: recipient not on Meta's allowed list     |

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
