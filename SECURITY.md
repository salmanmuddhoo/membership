# Security policy

This platform handles member personal, KYC and financial data for Al Barakah
MCSL. Every change is subject to the controls below, which implement Section 30
of the Functional Requirements Document.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the System Administrator /
technical lead. Do not open a public issue, and do not include live credentials
or member data in a report.

## The merge gate

The automated audit runs on every pull request into `main` and `production`
without anyone having to trigger it, and reports a pass or fail per check.

> **Current enforcement posture.** Branch protection is deliberately **not**
> enabled, and there is no second reviewer. Enforcement rests with the sole
> maintainer, who controls what is merged and deployed. The audit therefore
> **informs** the merge decision rather than mechanically blocking it.
>
> This is a conscious deviation from FRD 30.2, which specifies automatic
> blocking and a second human approval. It is recorded here so the control
> environment is described accurately. Revisit when a second maintainer joins:
> the workflows already emit the required status checks, so enforcement is a
> settings change, not development work. See `docs/security-gate.md`.

The table below states what each check reports as a failure — which is what
would block a merge once branch protection is switched on.

| Check                            | Tool              | Reported as failing      |
| -------------------------------- | ----------------- | ------------------------ |
| Secrets in code or git history   | Gitleaks          | Any finding              |
| Static analysis (SAST)           | Semgrep           | `ERROR` severity         |
| Dependency vulnerabilities (SCA) | pnpm audit, Trivy | `high` and `critical`    |
| Misconfiguration                 | Trivy             | Reported, does not block |

Thresholds are configurable at the top of
`.github/workflows/security-audit.yml`. Medium and low findings are recorded
against the run and tracked as backlog items rather than treated as failures.

A failing audit must be resolved before the change is merged. With enforcement
currently manual, that responsibility sits with the maintainer.

## Escalation

Every audit run is recorded: pass/fail per check, the commit it relates to, and
full reports attached as build artifacts for 90 days.

A **critical finding that recurs or is left unresolved** is escalated to the
System Administrator / technical lead, and no further changes are merged to the
affected component until it is remediated.

Beyond the per-merge gate, a deeper manual security review or penetration test
should be scheduled periodically — quarterly is the target — given the
sensitivity of the data held.

## Tenant configuration this design depends on

One access-control decision depends on a setting outside this repository, so it
is recorded here rather than only in code:

| Setting                                | Required state | Last verified  |
| -------------------------------------- | -------------- | -------------- |
| Entra External ID self-service sign-up | **Disabled**   | 26 August 2026 |

Staff accounts are pre-provisioned by email and bound to an Entra identity on
first sign-in (see `docs/access-control.md`). That binding trusts the email
claim, which is only sound while every account is created by an administrator.
**Enabling self-service sign-up would turn it into a way to claim someone
else's pre-provisioned account**, and the binding must be removed in the same
change. Re-check at each periodic review.

## Handling secrets

- Never commit credentials, tokens, client secrets or connection strings.
- `.env` is git-ignored. `.env.example` holds variable **names** and
  placeholders only.
- Real values live in the Vercel environment, scoped per environment.
- The Entra client secret expires; track its expiry date and rotate before it
  lapses, or sign-in fails.
- If a secret is ever committed, treat it as compromised: rotate it first, then
  remove it from history.

## Allowlisted findings

Exceptions live in `.gitleaks.toml` and each one states why it is safe. Blanket
allowlisting is not permitted — an exception that cannot be justified in a
sentence should not be added.

## A deployed page can be missing without anything failing

The Vercel adapter emits a **closed allow-list** of routes in
`.vercel/output/config.json`, ending in a catch-all that returns 404. That list
is generated at build time and frozen into the deployment, so a page absent
from it is unreachable no matter what the database, the permissions or the
application configuration say.

This matters for a security review because the symptom is indistinguishable
from a permission problem at a glance, and the instinct is to start granting
permissions to fix it. It is worth knowing the difference:

| Symptom               | Cause                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| Redirect to `/denied` | The route exists; the caller lacks the permission it declares                 |
| **404**               | The route is not in the deployed build's allow-list — authorisation never ran |

`pnpm verify:routes` checks the build output against `src/pages` and fails if
any page would 404. It runs in CI after the build. Never respond to a 404 on a
page you believe exists by widening permissions: check which commit is
deployed first.
