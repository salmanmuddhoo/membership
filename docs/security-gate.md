# Security gate — how it works and what you must configure

This covers Milestone M0. The automated half is in the repository; the branch
protection half must be switched on in GitHub by a repository administrator,
because it cannot be set from code.

## What runs automatically

Two workflows run on every pull request into `main` and `production`:

| Workflow                               | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `.github/workflows/ci.yml`             | Install, formatting, type-check, production build       |
| `.github/workflows/security-audit.yml` | Secrets, SAST, dependency and misconfiguration scanning |

The security audit also runs weekly on a schedule, so a newly disclosed
advisory surfaces even during a quiet period.

### Blocking thresholds

Set at the top of `security-audit.yml` (FRD 30.2 requires these be
configurable):

```yaml
AUDIT_BLOCK_LEVEL: high # pnpm audit
TRIVY_BLOCK_SEVERITY: HIGH,CRITICAL
SEMGREP_BLOCK_SEVERITY: ERROR
```

## Enforcement status

Branch protection is **not currently enabled**, by decision of the maintainer,
who controls merges and deployment directly. The workflows below still run on
every pull request and report pass/fail — they simply do not mechanically block
a merge today.

The settings in the next section are what to apply when that changes (for
example when a second maintainer joins). No development work is needed: the
workflows already emit the status checks GitHub needs.

## What to configure in GitHub when enforcement is turned on

Go to **Settings → Branches → Add branch ruleset** (or Branch protection
rules) and apply the following to **`main`** and **`production`**:

1. **Require a pull request before merging** — blocks direct pushes.
2. **Require approvals: 1** — the human review the FRD requires alongside the
   automated audit.
3. **Dismiss stale approvals when new commits are pushed.**
4. **Require status checks to pass before merging**, selecting:
   - `Type-check & build`
   - `Secrets scan`
   - `Static analysis`
   - `Dependency analysis`
   - `Audit record`
5. **Require branches to be up to date before merging.**
6. **Do not allow bypassing the above settings** — including for
   administrators. This is the setting most often left off, and it is the one
   that makes the gate real.
7. **Block force pushes** and **restrict deletions**.

> The status check names only appear in GitHub's picker after the workflows
> have run at least once. Merge this milestone's pull request first, then add
> the checks.

### One caveat while there is a single maintainer

GitHub does not allow the author of a pull request to approve it. With one
maintainer, "Require approvals: 1" means your own pull requests cannot be
merged without a second person.

Choose one:

- **Add a second reviewer** — the correct long-term answer, and required before
  `Require review from Code Owners` is switched on.
- **Leave approvals at 0 for now** and rely on the automated checks, then raise
  it to 1 as soon as a second reviewer exists.

Whichever you pick, keep the **status checks required** — those work regardless
of team size.

## Coverage and limitations

- Semgrep parses TypeScript and JavaScript. Astro component files are not
  parsed by it, which is one more reason business logic belongs in `src/lib`
  rather than in `.astro` files (architecture decision AD-02).
- Scanner images are referenced by tag. Once the first green run establishes
  known-good versions, pin them to digests.
- The gate covers code and dependencies. It does not replace the periodic
  manual review or penetration test described in `SECURITY.md`.
