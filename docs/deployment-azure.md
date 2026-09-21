# Putting production on Azure

This guide is for someone who has never used Azure. Follow it with the Azure
portal open in another window. Every step is something to click or type, and
after each one it says what you should see, so you can tell it worked before
moving on.

## What you are about to do

The Test site stays exactly where it is, on Vercel. Nothing about it changes,
and nothing you do here can break it. What you are setting up is a second,
separate home for the real system — the one the branch actually uses — on
Microsoft Azure.

The code already knows how to run in both places. That work is done: when
Vercel builds the site it produces a Vercel version, and when Azure builds it
it produces an Azure version, from the same repository, with no switch for you
to remember.

You will create four things: somewhere to keep them all, a database, the web
app itself, and a way for GitHub to send new code across. Then you point the
Society's domain name at it.

Set aside an afternoon. Most of the time is waiting for Azure to finish
creating things. None of it needs you to write code.

## Before you start

You need all of these in hand. If one is missing, get it first — stopping
halfway to chase a password is how mistakes happen.

- [ ] **An Azure subscription**, and to know who pays the bill. If the Society
      has never used Azure, someone has to create the account and add a card.
- [ ] **Administrator access to the GitHub repository**, so you can add
      secrets and change the workflow.
- [ ] **Access to the staff sign-in app registration** in Microsoft Entra. It
      already exists — it is what officers sign in through today. You will add
      one address to it.
- [ ] **The Society's production domain name**, and access to wherever its DNS
      is managed (the registrar's control panel, usually).
- [ ] **The current production values** for the settings listed in step 4 —
      the SharePoint/Graph details, the notification gateway tokens, and so
      on. The list is in that step; gather them before you start typing.
- [ ] **Somewhere safe to write down passwords.** You will create a database
      password that cannot be recovered if you lose it.
- [ ] **Confirmation that the `production` branch is up to date with `main`.**
      Step 5 explains why and how to check — this is worth ten seconds now
      rather than a confusing failure later.

## The pieces, and what each one is for

- **Resource group** — a folder that holds everything for this project. It
  lets you find it all in one place, see one bill for it, and delete the lot
  if you ever want to start over.
- **Azure Database for PostgreSQL** — where every member, application,
  payment and audit record is stored. This is the part that matters most; the
  web app can be rebuilt in twenty minutes, the data cannot.
- **App Service** — the computer that runs the website. You do not manage the
  machine itself; you give Azure the code and it runs it.
- **Application settings** — the passwords, addresses and switches the app
  reads when it starts. They live in Azure rather than in the code, so a
  secret is never committed to GitHub.
- **Key Vault** (optional, later) — a safe for those passwords, so they can be
  changed without touching the web app. You can start without it.

## Step 1 — Create the folder (resource group)

1. Sign in at **portal.azure.com**.
2. In the search box at the top, type **Resource groups** and click it.
3. Click **Create**.
4. **Subscription**: pick the Society's subscription.
5. **Resource group**: name it something you will recognise, for example
   `albarakah-production`.
6. **Region**: choose **South Africa North**. This is the closest Azure region
   to Mauritius, and every other piece will go in the same one — the database
   and the web app talking to each other across regions is slow in a way you
   would feel on every page.
7. Click **Review + create**, then **Create**.

**You should see** the resource group appear in the list within a few seconds.

> Keep every piece in this one resource group and this one region. Mixing
> regions is the single most common cause of a site that works but feels slow.

## Step 2 — Create the database

1. In the search box, type **Azure Database for PostgreSQL** and click it.
2. Click **Create**, then choose **Flexible server**.
3. **Resource group**: the one you just made.
4. **Server name**: something like `albarakah-production-db`. This becomes part
   of its address, so it has to be unique across all of Azure — if it is taken,
   add something to it.
5. **Region**: **South Africa North**, the same as the folder.
6. **PostgreSQL version**: choose 16 unless you have a reason not to. It is
   what the system is developed against.
7. **Workload type**: for a society of this size, **Development** or the
   smallest Production tier is enough to start. You can increase it later
   without rebuilding; you cannot easily decrease it, so start small.
8. **Authentication method**: PostgreSQL authentication only.
9. **Admin username** and **password**: make up both and **write them down
   somewhere safe now**. Azure will not show you the password again, and
   recovering from losing it means resetting it and updating every setting
   that uses it.
10. Click **Next: Networking**.
11. **Connectivity method**: **Public access**. (There is a more private
    option using a virtual network. It is better, and it is also a lot more to
    set up. Start here; `docs/database.md` discusses moving to it later.)
12. Tick **Allow public access from any Azure service within Azure to this
    server**. This is a firewall rule — a list of who is allowed to connect at
    all. This particular rule lets your web app, which is also inside Azure,
    reach the database.
13. Add a second firewall rule for **your own computer's IP address**, so you
    can connect from your machine to run the first setup. Azure offers a button
    to add your current address.
14. **SSL/TLS**: leave encryption **on**. It is on by default. Do not turn it
    off — it is what stops the connection between the app and the database
    being readable in transit.
15. Click **Review + create**, then **Create**.

**You should see** a deployment page. Creating a database server takes five to
ten minutes. Wait for "Your deployment is complete".

16. When it is done, open the server and find its **Server name** — it looks
    like `albarakah-production-db.postgres.database.azure.com`. Write it down;
    you need it in step 4.

Then create the database itself inside the server:

17. In the server's left-hand menu, find **Databases**, and add one named
    `albarakah`.

> **If you skip the firewall rules**, the site will load but every page will
> fail with a database error. That is the symptom to recognise.

### One more thing this server needs before anything can be built on it

The admin account you just made is not the one the application connects as
day to day — that is a separate, much more limited account named
`albarakah_app`, which can read and write rows but is not allowed to change
the database's structure. Nothing creates it for you. Do this now, while the
server is fresh in your mind, rather than after a migration fails on it.

18. Still on the server, find **Server parameters** in the left-hand menu.
    Search for **`azure.extensions`**, and add `PGCRYPTO` and `CITEXT` to its
    value — a comma-separated list; add to whatever is already there rather
    than replacing it. Click **Save**. (Azure blocks every extension by
    default; the very first migration needs these two.)
19. Open **Cloud Shell** — the `>_` icon in the portal's top toolbar. Accept
    the defaults if it asks to create storage, and choose **Bash** if asked.
    It comes with `psql` already installed; nothing to download.
20. Run, with your own server name and admin username in place of the two
    placeholders:

    ```
    psql "host=<server-name>.postgres.database.azure.com port=5432 dbname=albarakah user=<admin-username> sslmode=require"
    ```

    It asks for the admin password — paste it. Nothing appears on screen
    while you do; that is normal for a password prompt, not a fault.

21. **You should see** a prompt reading `albarakah=>`. Paste this, making up
    a **new** password where marked — never the admin's own — and putting
    your own admin username in place of the one placeholder that needs it:

    ```sql
    CREATE ROLE albarakah_app WITH LOGIN PASSWORD '<make one up>';
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT ALL ON SCHEMA public TO "<admin-username>";
    GRANT CONNECT ON DATABASE albarakah TO albarakah_app;
    GRANT USAGE ON SCHEMA public TO albarakah_app;
    ```

    That third line is easy to think unnecessary — surely the admin account
    can already do everything? On Azure specifically, no: this admin is a
    member of a powerful group role, not a true Postgres superuser the way
    the `postgres` account is on your own machine, and it does not bypass
    permission checks the way a real superuser does. It could create things
    in `public` only because of a default right every account starts with,
    and the line above it — a real hardening step, not a mistake — just took
    that default away from every account, admin included. This puts it back,
    for the admin specifically, without reopening it to everyone.

22. **Write that password down now.** It is `albarakah_app`'s own, and it is
    what `DATABASE_URL` in step 4 is built from — not the admin's password,
    which goes only into `DATABASE_MIGRATION_URL` in step 6.
23. Type `\q` and press Enter to leave `psql`.

## Step 3 — Create the web app

1. In the search box, type **App Services** and click it.
2. Click **Create**, then **Web App**.
3. **Resource group**: the same one.
4. **Name**: something like `albarakah-production`. This gives you a free
   address to test with — `albarakah-production.azurewebsites.net` — before the
   real domain is pointed at it.
5. **Publish**: **Code**.
6. **Runtime stack**: **Node 22 LTS**. This matches what the project is built
   and tested with.
7. **Operating System**: **Linux**.
8. **Region**: **South Africa North**, the same as everything else.
9. **Pricing plan**: choose a **Basic** plan or better. Avoid the Free tier —
   it stops the app when it is idle, so the first officer in each morning
   would wait a long time for the first page.
10. Click **Review + create**, then **Create**.

**You should see** "Your deployment is complete" after a minute or two. Click
**Go to resource**, then open the address shown at the top right. You will get
a placeholder page — there is no code on it yet. That is correct.

Now tell it how to start the app:

11. In the web app's left-hand menu, open **Configuration** (on some
    subscriptions this sits under **Settings**).
12. Find **Startup Command** and set it to:

    ```
    node ./dist/server/entry.mjs
    ```

13. Click **Save**.

> That one line is what runs the built application. If it is left blank, Azure
> guesses, and the guess is usually wrong — the symptom is a site that returns
> an error page with no useful detail.

## Step 4 — Fill in the settings

An **application setting** is one named value the app reads when it starts —
a password, an address, a switch. They live in Azure, not in the code, which
is why no password is ever committed to GitHub.

1. In the web app's left-hand menu, open **Environment variables** (older
   portals call this **Configuration** → **Application settings**).
2. For each row in the table below, click **Add**, type the name in **Name**
   exactly as written, and the value in **Value**.
3. Click **Apply** / **Save** when you have entered them all. The app restarts.

Take the names exactly as they appear. They are matched letter for letter, and
a typo produces a setting the app never reads — with no error to tell you.

Five of them deserve attention before you start:

- **`DATABASE_URL`** is the whole connection in one line. Build it from what
  you wrote down in step 2:

  ```
  postgresql://USERNAME:PASSWORD@SERVERNAME.postgres.database.azure.com:5432/albarakah?sslmode=require
  ```

  Keep `?sslmode=require` on the end. It is what insists the connection is
  encrypted.

- **`PUBLIC_SITE_URL`** is the address the site will live at. Until your
  domain is pointed at Azure (step 7), use the `.azurewebsites.net` address.
  Change it when the domain goes live. It also has to be set on GitHub, as a
  build input — step 5 covers that.

- **`ENTRA_REDIRECT_URI`** is where Microsoft sends an officer back to after
  they sign in. It must match what is registered in Entra exactly — step 8
  covers both halves.

- **`HOST`** tells the app which connections to accept. Left unset, it accepts
  them only from inside its own container. Azure's own check arrives from
  outside that container, gets no answer, and eventually gives up and reports
  that the app failed to start — while the app's own log says it is listening,
  which is what makes this one hard to spot. Set it to `0.0.0.0` before you
  deploy.

- **`WEBSITE_RUN_FROM_PACKAGE`**, set to `1`, is not one of the application's
  own settings — the app never reads it — but it goes in the same list, so add
  it now while you are here. GitHub builds and tests the code before it ever
  reaches Azure (step 5); this setting tells Azure to run that exact result
  rather than trying to build the code itself a second time, with tools
  (`npm`, not this project's `pnpm`) that do not match what was tested.

| Variable                          | For                                                                                                                       | Secret? | Production value                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_METADATA_URL`              | Entra OIDC metadata document URL (or use the two below instead)                                                           | No      | From the Entra app registration's Endpoints panel                                                                                                                                         |
| `ENTRA_AUTHORITY`                 | Entra CIAM authority, alternative to the metadata URL                                                                     | No      | `https://<tenant-subdomain>.ciamlogin.com/`                                                                                                                                               |
| `ENTRA_TENANT_ID`                 | Entra CIAM tenant id                                                                                                      | No      | GUID from the app registration                                                                                                                                                            |
| `ENTRA_CLIENT_ID`                 | Entra app registration client id (sign-in)                                                                                | No      | GUID                                                                                                                                                                                      |
| `ENTRA_CLIENT_SECRET`             | Entra app registration client secret (sign-in)                                                                            | **Yes** | Key Vault reference                                                                                                                                                                       |
| `ENTRA_REDIRECT_URI`              | OIDC callback URL — must match the app registration exactly                                                               | No      | `https://<production-domain>/auth/callback` — update in both places (step 4)                                                                                                              |
| `ENTRA_POST_LOGOUT_REDIRECT_URI`  | Where Entra sends the user after sign-out                                                                                 | No      | `https://<production-domain>/login`                                                                                                                                                       |
| `PUBLIC_SITE_URL`                 | The address this site is served at — Azure and Vercel each set their own; also needed on GitHub as a build input (step 5) | No      | `https://<production-domain>`; until the domain is live, the `.azurewebsites.net` address                                                                                                 |
| `HOST`                            | Network interface the app listens on — without it, Azure can't reach the container                                        | No      | `0.0.0.0` — makes the app listen on every interface, not just inside its own container                                                                                                    |
| `ENTRA_SCOPES`                    | OIDC scopes requested                                                                                                     | No      | `openid profile email offline_access` (the default if unset)                                                                                                                              |
| `AUTH_SESSION_SECRET`             | Signs the staff session cookie                                                                                            | **Yes** | Key Vault reference; `openssl rand -base64 40`. Rotating it signs out every staff member at once (`docs/runbook.md`).                                                                     |
| `DATABASE_URL`                    | Application's Postgres connection (least-privilege role, no DDL)                                                          | **Yes** | Key Vault reference; `postgresql://albarakah_app:<password>@<server>.postgres.database.azure.com:5432/albarakah?sslmode=verify-full`                                                      |
| `DATABASE_MIGRATION_URL`          | Schema-owner connection, used only by the migration workflow                                                              | **Yes** | Set as a **GitHub Environment secret**, not on App Service — the running app never needs it (`docs/database.md`)                                                                          |
| `DATABASE_POOL_MAX`               | Per-instance connection pool ceiling                                                                                      | No      | Default `3`; raise only with a reason (`docs/database.md`)                                                                                                                                |
| `DATABASE_IDLE_TIMEOUT_MS`        | How long an idle pooled connection is kept                                                                                | No      | Default `60000`                                                                                                                                                                           |
| `DATABASE_CONNECT_TIMEOUT_MS`     | Connection attempt timeout                                                                                                | No      | Default `10000`                                                                                                                                                                           |
| `DATABASE_ALLOW_INSECURE`         | Opens a **plaintext** connection, for a local TLS-less cluster                                                            | No      | **Do not set in Azure.** Refused outright whenever `PUBLIC_APP_ENV` reads as production (unset counts as production) — `src/lib/config.ts` throws on startup. **Local development only.** |
| `GRAPH_TENANT_ID`                 | Microsoft Graph app registration tenant (Al Barakah 365 tenant — different from Entra CIAM)                               | No      | GUID — see `docs/documents.md`                                                                                                                                                            |
| `GRAPH_CLIENT_ID`                 | Graph app registration client id                                                                                          | No      | GUID                                                                                                                                                                                      |
| `GRAPH_CLIENT_SECRET`             | Graph app registration client secret                                                                                      | **Yes** | Key Vault reference                                                                                                                                                                       |
| `GRAPH_DRIVE_ID`                  | The SharePoint document library documents are filed in                                                                    | No      | From `GET /sites/{site-id}/drives`; production must use its **own** site, separate from test (`docs/documents.md`)                                                                        |
| `RATE_LIMIT_MAX_REQUESTS`         | API rate limit, requests per subject per window                                                                           | No      | Default `300` (`docs/api.md`)                                                                                                                                                             |
| `RATE_LIMIT_WINDOW_SECONDS`       | API rate limit window length                                                                                              | No      | Default `60`                                                                                                                                                                              |
| `RATE_LIMIT_DISABLED`             | Switches the rate limiter off entirely                                                                                    | No      | **Do not set in production.** Local/test work only.                                                                                                                                       |
| `MEMBER_SESSION_SECRET`           | Signs the member mobile app's access tokens — its own secret, never `AUTH_SESSION_SECRET`                                 | **Yes** | Key Vault reference; `openssl rand -base64 40`, at least 32 characters. Rotating signs out every member app user.                                                                         |
| `MEMBER_OTP_DELIVERY`             | How member one-time codes are sent (`http` in production)                                                                 | No      | `http`                                                                                                                                                                                    |
| `MEMBER_OTP_WEBHOOK_URL`          | SMS/WhatsApp gateway URL for OTPs, when `MEMBER_OTP_DELIVERY=http`                                                        | No      | The Society's gateway URL                                                                                                                                                                 |
| `MEMBER_OTP_WEBHOOK_TOKEN`        | Bearer token for that gateway                                                                                             | **Yes** | Key Vault reference                                                                                                                                                                       |
| `MEMBER_OTP_FIXED_CODE`           | A fixed OTP accepted on every challenge, to test without a gateway                                                        | No      | **Do not set in production** — refused outright whenever `PUBLIC_APP_ENV` reads as production.                                                                                            |
| `MEMBER_ACCESS_TOKEN_SECONDS`     | Member app access token lifetime                                                                                          | No      | Default `3600`                                                                                                                                                                            |
| `MEMBER_REFRESH_TOKEN_DAYS`       | Member app refresh token lifetime                                                                                         | No      | Default `90`                                                                                                                                                                              |
| `NOTIFY_EMAIL_DELIVERY`           | Email channel: `graph` (Society's M365 mailbox) or `http` in production                                                   | No      | `graph`                                                                                                                                                                                   |
| `NOTIFY_EMAIL_FROM`               | Mailbox mail is sent as, for `graph` delivery — must be in the Graph tenant                                               | No      | e.g. `noreply@albarakah.mu`                                                                                                                                                               |
| `NOTIFY_EMAIL_WEBHOOK_URL`        | Gateway URL, if `NOTIFY_EMAIL_DELIVERY=http`                                                                              | No      | Only if using `http` delivery                                                                                                                                                             |
| `NOTIFY_EMAIL_WEBHOOK_TOKEN`      | Bearer token for that gateway                                                                                             | **Yes** | Key Vault reference, only if using `http` delivery                                                                                                                                        |
| `NOTIFY_WHATSAPP_DELIVERY`        | WhatsApp channel: `cloud_api` (Meta direct) or `http` in production                                                       | No      | `cloud_api`                                                                                                                                                                               |
| `NOTIFY_WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Business phone number id, for `cloud_api`                                                                   | No      | From Meta Business settings                                                                                                                                                               |
| `NOTIFY_WHATSAPP_TOKEN`           | Meta permanent system-user token, for `cloud_api`                                                                         | **Yes** | Key Vault reference. Rotating: WhatsApp sends fail and are retried, nothing lost (`docs/runbook.md`).                                                                                     |
| `NOTIFY_WHATSAPP_API_VERSION`     | Pin a specific Graph API version for WhatsApp                                                                             | No      | Optional                                                                                                                                                                                  |
| `NOTIFY_WHATSAPP_BASE_URL`        | Override the WhatsApp Cloud API base URL                                                                                  | No      | Optional                                                                                                                                                                                  |
| `NOTIFY_WHATSAPP_WEBHOOK_URL`     | Gateway URL, if either notify channel uses `http` delivery                                                                | No      | Only if using `http` delivery                                                                                                                                                             |
| `NOTIFY_WHATSAPP_WEBHOOK_TOKEN`   | Bearer token for that gateway                                                                                             | **Yes** | Key Vault reference, only if using `http` delivery                                                                                                                                        |
| `PUBLIC_APP_ENV`                  | UI "TEST" badge, and the safety flag every `*_ONLY`/insecure setting above checks                                         | No      | **Leave unset (or `production`) in production.** Set to `test` only on the test environment.                                                                                              |

### About the ones marked "Do not set"

A few settings exist only to make local development possible — connecting to a
database without encryption, accepting a fixed sign-in code, turning off rate
limiting. Setting any of them in production would weaken the system, so the
application refuses to start if it finds them. Leave them out entirely; do not
set them to `false` or `no`.

### Key Vault, later

Key Vault is a safe for passwords. Instead of the password itself, the setting
holds a pointer to the vault, and the web app is given permission to read it.
The gain is that changing a password no longer means editing the web app, and
you get a record of what read it and when.

It is worth doing, and it is not worth doing today. Get the site running with
the values typed in directly, then move the ones marked **Yes** in the Secret
column into a vault once you are not also learning everything else at the same
time. `docs/runbook.md` covers changing each secret.

## Step 5 — Let GitHub deploy for you

> **Before this step:** `production` has to actually hold the code this guide
> assumes — including the change that lets the build produce what Azure runs
> in the first place. If development has been happening on `main`,
> `production` can be a long way behind it. Ask whoever maintains the
> repository to confirm, or check yourself: on GitHub, compare the two
> branches (`.../compare/production...main`) and see whether anything is
> listed. Bringing `production` up to date is a pull request from `main` into
> `production`, then merged — `docs/environments.md` covers it, and it is
> **never** done by committing to `production` directly. Do this before the
> first deploy, not after it fails in a way that is hard to tell apart from
> everything else that could be wrong.

Rather than uploading files by hand every time, a workflow file already in the
repository — `.github/workflows/deploy-production.yml` — builds the site and
sends it to Azure automatically, every time `production` changes. You do not
need to write it, and you do not need Azure's own **Deployment Center**
wizard: that wizard needs to commit a file to the branch and hold a live
connection to GitHub, and either can fail with a bare error and nothing to
act on — for reasons as ordinary as a branch protection rule, unrelated to
anything you typed. The workflow file below sidesteps the wizard entirely; it
only needs one credential from you.

1. In the web app, open **Overview**, and click **Download publish profile**.
   This saves a small file. It is a credential — treat it like a password,
   and never commit it to the repository.
2. On GitHub, go to the repository's **Settings → Environments**. If an
   environment named **production** already exists (it does if the database
   migrations in step 6 have been set up before), open it; otherwise, create
   one with that exact name.
3. Add an **environment secret** named **`AZURE_WEBAPP_PUBLISH_PROFILE`**,
   and paste the entire contents of the file from step 1 as its value.
4. Open `.github/workflows/deploy-production.yml` in the repository and find
   the line `app-name: albarakah-production`. If you named the web app
   something else in step 3, change it here to match, exactly.
5. In the same **production** environment, add **`PUBLIC_SITE_URL`** as an
   **environment variable**, not a secret — GitHub's environment page has
   separate **Environment secrets** and **Environment variables** sections;
   this goes in **Variables**. Set it to the address the site is served at,
   scheme included, with no trailing slash. The build needs it to bake in
   the one address the site will trust, which is what keeps every form
   submission — sign-in included — from being refused.

**You should see**, the next time `production` changes, a run named **Deploy
to Azure** appear on GitHub's **Actions** tab.

To trigger the very first deploy right now rather than waiting for the next
code change: open the **Actions** tab, click **Deploy to Azure** in the list
on the left, then **Run workflow**, choosing the `production` branch.

**You should see** the run finish green, and the `.azurewebsites.net` address
now show the sign-in page instead of the placeholder.

### If you would rather use Azure's own wizard

Nothing else in this guide depends on it, and the workflow file above is the
one to trust. If you try the wizard anyway — **Deployment Center** → source
**GitHub** → pick the repository and the `production` branch — and it fails
with an error and no new file appears under `.github/workflows/`, check these
two things before anything else:

- **Settings → Branches** (or **Rules → Rulesets**) on GitHub, on the
  `production` branch: if **"Require a pull request before merging"** is
  switched on, Azure cannot push a file to it directly.
- Your GitHub profile's **Settings → Applications → Installed GitHub Apps**:
  find the Azure entry and confirm it has access to **this** repository, not
  only "selected repositories" that do not include it.

With the workflow file already in place, though, there is nothing the wizard
would still need to do.

## Step 6 — Set up the database tables

The database you created in step 2 is empty. The project applies its own
schema through migrations — numbered files, applied in order, recorded as they
go, so the same set never runs twice.

There is already a workflow for this at `.github/workflows/migrate.yml`. It
needs one secret, on the same **production** GitHub Environment as step 5's:

1. On GitHub, go to the repository's **Settings → Environments → production**
   (create it first if step 5 has not already).
2. Add an **environment secret** named **`DATABASE_MIGRATION_URL`**. Build it
   the same way as `DATABASE_URL` in step 4, but with the **admin** username
   and password from step 2 — never `albarakah_app`. Applying migrations
   needs permission to change the database's structure, which `albarakah_app`
   is deliberately never given:

   ```
   postgresql://<admin-username>:<admin-password>@<server-name>.postgres.database.azure.com:5432/albarakah?sslmode=require
   ```

3. Run the migrate workflow from the **Actions** tab (**Apply migrations** →
   **Run workflow** → choose **production**).

**You should see** it report the migrations it applied. Run it a second time:
it should report that there is nothing to do. That is how you know the record
of what has run is working.

> This secret belongs on GitHub, not in the web app's settings. The running
> site never needs the power to change the database structure, and giving it
> that power is worth avoiding.
>
> **If this fails with "password authentication failed for user
> `albarakah_app`"**, this secret has `albarakah_app`'s connection string in
> it rather than the admin's — an easy mix-up, since the two strings differ
> by only a username and a password. Rebuild it with the admin account. And
> if `albarakah_app` was never created at all (step 2, items 18–23), the
> error names the admin account instead, since Azure gives the same message
> either way rather than confirming which usernames exist.

## Step 7 — Point the domain at it

1. In the web app, open **Custom domains**.
2. Click **Add custom domain** and type the Society's domain.
3. Azure shows you the DNS records it needs. There are two:
   - a **TXT** record, usually named `asuid.www` or `asuid`, holding a long
     verification string. This proves you control the domain.
   - a **CNAME** record for `www` pointing at
     `albarakah-production.azurewebsites.net`, or an **A** record holding
     Azure's IP address if you are using the domain with no `www` in front.
4. Add those records in whichever control panel manages the Society's DNS.
5. Come back to Azure and click **Validate**.

**You should see** both checks go green. DNS changes can take anywhere from a
few minutes to a few hours to spread; if validation fails, wait and try again
before changing anything.

6. Once the domain is added, click **Add certificate** / **Create App Service
   Managed Certificate**. This is free and renews itself. It is what puts the
   padlock in the browser.
7. When the certificate is issued, go to **Configuration** → **General
   settings** and turn **HTTPS Only** to **On**, so anyone arriving on `http://`
   is moved to the secure address.
8. Go back to **Environment variables** and change **`PUBLIC_SITE_URL`** to
   the real domain. Change it in **Settings → Environments → production →
   Variables** on GitHub too (step 5) — both copies have to match, and the
   GitHub one only takes effect on the next deploy, not before.

> **The certificate will not issue** until the DNS records are correct and
> visible. If it keeps failing, check the records first rather than retrying.

## Step 8 — Update the sign-in settings

This is the step most likely to be missed, and the symptom is that nobody can
sign in.

When an officer signs in, Microsoft sends them back to a specific address. That
address has to be registered in advance, and it has to match exactly.

1. In the portal, go to **Microsoft Entra ID** → **App registrations** and open
   the staff sign-in registration (the one already used today).
2. Open **Authentication**.
3. Under **Redirect URIs**, add:

   ```
   https://YOUR-DOMAIN/auth/callback
   ```

4. Leave the existing Test entry in place. Both environments can be registered
   at once, and removing Test's would break Test.
5. Click **Save**.
6. Back in the web app's **Environment variables**, set **`ENTRA_REDIRECT_URI`**
   to that same address, character for character, and
   **`ENTRA_POST_LOGOUT_REDIRECT_URI`** to `https://YOUR-DOMAIN/login`.

> **If these two do not match**, sign-in fails with a message about a redirect
> URI that is not registered. It is not a subtle failure — but it is confusing
> the first time, because everything else works.

If the domain ever changes, both of these change with it.

## Step 9 — Check it worked

Open the site at the real domain and walk through this list:

1. **The sign-in page loads**, with a padlock in the address bar.
2. **You can sign in** as yourself and reach the dashboard.
3. **A page with data loads** — open Members. If the list appears, the app is
   talking to the database.
4. **A document opens** — open any member with a filed document and click
   View. If it opens, the SharePoint connection is working. If it fails, check
   the `GRAPH_*` settings against `docs/documents.md`.
5. **The test site still works.** Open the Vercel address and sign in there
   too. Nothing you have done should have touched it, and confirming that is
   worth thirty seconds.

### Watching it afterwards

- **Log stream** in the web app's menu shows what the app is printing, live.
  This is the first place to look when something is wrong. Right after a
  restart, a healthy startup shows two lines:

  ```
  [@astrojs/node] Server listening on
    local: http://localhost:8080
    network: http://10.0.0.4:8080
  ```

  The address on the `network:` line will not match the one above — it is
  whatever internal address this instance happens to have. What matters is
  that the line is there at all: it is what tells you Azure can reach the
  app. A single `Server listening on http://localhost:8080` line with
  nothing under it means the site looks like it started but cannot actually
  be reached — see the troubleshooting table below.

- **Application Insights** can be switched on for longer-term history and
  alerts. Useful, not urgent.
- Do **not** point Azure's built-in health check at `/api/v1/health`. That
  endpoint deliberately requires a signed-in account, so an anonymous probe
  gets a 401 and Azure would conclude the site is broken. Point it at `/login`,
  which is public, or leave the health check switched off.

Day-to-day operations — changing secrets, what to do when something breaks,
who to escalate to — are in `docs/runbook.md`.

## If something goes wrong

| What you see                                                                             | Usually means                                                                                             | What to do                                                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Site shows an error page with no detail                                                  | The startup command is wrong or missing                                                                   | Check it reads `node ./dist/server/entry.mjs` exactly (step 3), then look at the Log stream                                      |
| 503 error; Azure reports `ContainerStartupFailure` (230s probe timeout)                  | `HOST` is not set, so the server only listens on localhost inside its own container                       | Set `HOST` to `0.0.0.0` (step 4) and restart. Log stream showing no `network:` line under "Server listening" confirms this       |
| Every page fails with a database error                                                   | The firewall is not letting the app through, or `DATABASE_URL` is wrong                                   | Re-check the two firewall rules (step 2) and the connection string, including `?sslmode=require`                                 |
| Sign-in fails, message mentions a redirect URI                                           | The two halves of step 8 do not match                                                                     | Compare them character for character, including `https://` and any trailing slash                                                |
| Sign-in loops back to the sign-in page                                                   | `AUTH_SESSION_SECRET` is missing or changed                                                               | Check it is set; if you changed it, everyone is signed out once and that is expected                                             |
| Deployment succeeded but the old version is showing                                      | The build produced nothing, or the restart has not happened                                               | Check the GitHub Actions log for a failed build step; restart the web app                                                        |
| The certificate will not issue                                                           | DNS records are wrong or have not spread yet                                                              | Re-check the TXT and CNAME records, then wait — do not delete and recreate                                                       |
| Documents will not open                                                                  | The `GRAPH_*` settings are wrong or point at the test library                                             | Check them against `docs/documents.md`; production must use its own SharePoint site                                              |
| The GitHub Actions run fails at "Deploy to Azure Web App"                                | The publish profile secret is missing or wrong, or the web app name in the workflow file does not match   | Re-check the `AZURE_WEBAPP_PUBLISH_PROFILE` secret (step 5) and the `app-name` line in `.github/workflows/deploy-production.yml` |
| The run succeeds but the site still shows the placeholder or an old version              | `WEBSITE_RUN_FROM_PACKAGE` is not set to `1` (step 4), so Azure is trying to rebuild the code itself      | Add or fix that setting, then re-run the workflow from the Actions tab                                                           |
| Migrations fail: "password authentication failed for user ..."                           | `DATABASE_MIGRATION_URL` holds the wrong account, or `albarakah_app` was never created                    | See step 6's note directly below its instructions                                                                                |
| The first migration fails mentioning `pgcrypto` or `citext`                              | The two extensions were never allow-listed on the server                                                  | Step 2, item 18 — `azure.extensions` under Server parameters                                                                     |
| Migrations fail: "database ... does not exist"                                           | The database was created under a different name than `albarakah`                                          | Rename it to match — `ALTER DATABASE <what-you-called-it> RENAME TO albarakah;`, connected to a different database               |
| Migrations fail: "permission denied for schema public"                                   | The admin account lost its own rights on `public` when step 2's `REVOKE ALL ... FROM PUBLIC` ran          | Step 2, item 21 — the `GRANT ALL ON SCHEMA public TO "<admin-username>"` line restores it                                        |
| Sign-in and other forms fail: "Cross-site POST form submissions are forbidden"           | The address GitHub built the site with does not match the address it is served at — or was not set at all | Add or fix `PUBLIC_SITE_URL` as a GitHub environment **variable** (step 5); this takes effect on the next deploy, not a restart  |
| The GitHub Actions run fails: "PUBLIC_SITE_URL is not set on the production environment" | `PUBLIC_SITE_URL` was never added as a GitHub environment variable                                        | Add it in **Settings → Environments → production → Variables** (step 5), then re-run the workflow                                |

## What stays on Vercel

Test is untouched. It keeps deploying from the `main` branch exactly as it did
before, and nothing in this guide changes that.

The only thing worth setting there is **`PUBLIC_SITE_URL`**, in the Vercel
project's own environment variables, pointing at the test address. Without it
the site still works; it only affects how the app writes its own address into
links.

Two things changed in the repository that are worth knowing about, though
neither needs action from you:

- The security headers that used to be set in `vercel.json` are now set by the
  application itself, so both sites get them. `vercel.json` still pins the
  region and the caching of static files.
- The build chooses its own target. Vercel sets a marker that the build reads,
  so Test carries on producing a Vercel build with nothing configured.

## Words you will see

- **Resource group** — a folder holding everything for one project.
- **Region** — which of Microsoft's data centres it physically runs in.
- **App Service** — Azure's way of running a website without you managing the
  machine.
- **Flexible server** — the kind of PostgreSQL database to create. The other
  kind is older and being retired.
- **Firewall rule** — a line saying who is allowed to connect to the database.
- **Application setting** — one named value the app reads when it starts.
- **Key Vault** — a safe for passwords, which settings can point at instead of
  holding the password themselves.
- **Managed certificate** — the free HTTPS certificate Azure issues and renews
  for a domain you have proved you own.
- **Deployment Center** — where you connect Azure to GitHub so new code
  arrives on its own.
- **Startup command** — the one line Azure runs to start your app.
