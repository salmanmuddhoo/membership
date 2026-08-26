# Access control

Who someone is, and what they may do, are two separate questions answered in
two separate places.

| Question                     | Answered by                              | Where                         |
| ---------------------------- | ---------------------------------------- | ----------------------------- |
| Are you authenticated?       | Microsoft Entra External ID              | `src/lib/auth`                |
| Do you have an account here? | `app_user`, matched on the Entra subject | `src/lib/access/principal.ts` |
| May you reach this route?    | roles → permissions, deny by default     | `src/lib/access/authorise.ts` |

A valid Entra session is **not** an account. Someone can authenticate against
the tenant and still be refused, because this system decides separately whether
it knows them and whether they are still active.

## Deny by default

`src/middleware.ts` runs before every page. A route is reachable only if it is
one of:

- **public** — `/login`, `/auth/*`, `/denied`
- **open to every signed-in user** — listed in `OPEN_TO_ALL_USERS`
- **declared** — listed in `ROUTE_PERMISSIONS`, and the user holds that permission

Anything else is refused. Adding a page and forgetting to protect it therefore
produces a visible refusal in testing rather than a silent hole in production.

A **system administrator** may reach an _undeclared_ route — someone has to be
able to open a newly added page before its permission exists. They are **not**
exempt from a permission a route _does_ declare: an explicit rule means what it
says, and exempting a role would make the map advisory rather than binding.

Prefixes ending in `/` cover everything beneath them, so a sub-page added later
inherits protection. The longest matching prefix wins, so a specific rule can
tighten a broader one.

## Permissions are data

Effective permissions are the union of every role the user holds, read from the
database **on each request**. There is no cache and no copy in the session, so
revoking a role takes effect on that person's very next click rather than when
their session happens to expire.

## Provisioning an account

Accounts are created by **email address**, never by Entra subject. The OIDC
`sub` claim is _pairwise_ — unique to this application — and appears nowhere in
the Azure portal, so there is nothing an administrator could look up.

```bash
pnpm access:grant --email person@albarakah.mu --name "Their Name" --role officer
pnpm access:grant --email person@albarakah.mu --list
```

The account is created with **no subject**. The first time that person signs in
successfully, the subject on their token is bound to the waiting record, and
every later sign-in matches on the subject directly.

### The condition this rests on

Binding by email trusts the email claim in the token. That is safe **only
because self-service sign-up is disabled on the tenant**: every account is
created by an administrator, so nobody can obtain a token bearing an address
they were not given.

> **Verified 26 August 2026.** Self-service sign-up is confirmed disabled on the
> Al Barakah Entra External ID tenant. Re-check this at each security review,
> and treat it as a control rather than a setting: it is what makes the binding
> below safe.

**If self-service sign-up is ever enabled, this becomes a way to claim someone
else's pre-provisioned account, and `claimPreProvisionedAccount` must be removed
in the same change.** The binding is otherwise tightly constrained — it updates
only a row that is active and still unbound, so an account can be claimed once
and only once, a departed member of staff cannot reactivate themselves by
signing in, and two concurrent sign-ins cannot both take the same account.

## What is recorded

Every refusal is written to the append-only audit trail before the redirect:

| Action                    | Written when                                                                  |
| ------------------------- | ----------------------------------------------------------------------------- |
| `access.session_rejected` | A valid session belongs to nobody here, or to a deactivated account           |
| `access.denied`           | A known user was refused a route, with the reason and the permission required |

The refusal page itself says only that access was denied. It does not
distinguish "you have no account" from "you lack this permission" — both are a
refusal to the person in front of it, and spelling out which would tell an
unknown caller whether an account exists. The distinction is in the audit trail,
where an administrator can see it.
