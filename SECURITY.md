# Security policy

This platform handles member personal, KYC and financial data for Al Barakah
MCSL. Every change is subject to the controls below, which implement Section 30
of the Functional Requirements Document.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the System Administrator /
technical lead. Do not open a public issue, and do not include live credentials
or member data in a report.

## The merge gate

No change reaches `main` or `production` without passing an automated security
audit **and** a human review. The audit runs on every pull request without
anyone having to trigger it.

| Check                            | Tool              | Blocks a merge           |
| -------------------------------- | ----------------- | ------------------------ |
| Secrets in code or git history   | Gitleaks          | Any finding              |
| Static analysis (SAST)           | Semgrep           | `ERROR` severity         |
| Dependency vulnerabilities (SCA) | pnpm audit, Trivy | `high` and `critical`    |
| Misconfiguration                 | Trivy             | Reported, does not block |

Thresholds are configurable at the top of
`.github/workflows/security-audit.yml`. Medium and low findings are recorded
against the run and tracked as backlog items rather than blocking the merge.

## Escalation

Every audit run is recorded: pass/fail per check, the commit it relates to, and
full reports attached as build artifacts for 90 days.

A **critical finding that recurs or is left unresolved** is escalated to the
System Administrator / technical lead, and no further changes are merged to the
affected component until it is remediated.

Beyond the per-merge gate, a deeper manual security review or penetration test
should be scheduled periodically — quarterly is the target — given the
sensitivity of the data held.

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
