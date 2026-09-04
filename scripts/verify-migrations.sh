#!/usr/bin/env bash
# Refuse a change that edits a migration already applied somewhere (S-102).
#
# The runner records a checksum for every migration it applies and refuses a
# file that no longer matches. That is right — a silent divergence between a
# file and the database it claims to describe is far worse — but it fails at
# deploy time, after the merge. Worse, it aborts BEFORE applying anything, so
# every later migration is skipped too and the database falls quietly behind
# the code with no symptom except features that do not work. That is exactly
# what happened between 26 and 27 August 2026.
#
# This catches the same mistake in review, next to the diff that causes it.
#
#   scripts/verify-migrations.sh              compares against origin/main
#   scripts/verify-migrations.sh <base-ref>   compares against something else
#
# Written in shell rather than TypeScript on purpose: it is entirely a
# question about git history, and the security gate blocks child_process in
# application code — rightly, so this does not smuggle it in through a script.
set -euo pipefail

base="${1:-origin/main}"

if ! merge_base=$(git merge-base "$base" HEAD 2>/dev/null); then
  echo "Cannot compare against '$base': it is not in this checkout." >&2
  echo "Fetch it, or pass a ref that is." >&2
  exit 1
fi

if [ "$merge_base" = "$(git rev-parse HEAD)" ]; then
  echo "No commits beyond $base; nothing to check."
  exit 0
fi

# --diff-filter excludes additions: a NEW migration is the whole point.
changed=$(git diff --name-status --diff-filter=MDR "$merge_base..HEAD" -- migrations/ \
          | grep '\.sql$' || true)

[ -z "$changed" ] && { echo "No existing migration has been modified."; exit 0; }

# One narrow, named exception: migrations/0030_non_member_signed_form.sql
# never once applied successfully anywhere — every attempt from the day it
# merged (PR #83) through PR #88 failed on a pre-existing row and rolled
# back, so no environment ever recorded its checksum, and every migration
# after it was silently skipped the whole time. The usual harm this check
# exists to prevent (a recorded checksum going stale) cannot happen for a
# migration nothing ever recorded. Fixed in the PR that added this
# exception (an `on conflict do nothing` guard) — never add a second name
# here without the same "never once applied" evidence; the fix belongs in a
# new migration otherwise, exactly as this check insists everywhere else.
grandfathered='migrations/0030_non_member_signed_form.sql'

offending=""
while IFS=$'\t' read -r status path _rest; do
  [ -z "${path:-}" ] && continue

  if [ "$path" = "$grandfathered" ]; then
    echo "  grandfathered (never applied anywhere — see script comment): $path"
    continue
  fi

  if [ "${status:0:1}" = "M" ]; then
    # A modification that restores the file to a state it already had before
    # the base is a revert, not an edit: it can only move a database TOWARDS
    # what some environment already recorded, never away from it. That is how
    # a mistaken edit is legitimately undone, so allow it and say so.
    now=$(git rev-parse "HEAD:$path")
    if git log --format=%H "$merge_base" -- "$path" \
       | while read -r commit; do git rev-parse "$commit:$path" 2>/dev/null || true; done \
       | grep -qx "$now"; then
      echo "  reverted to an earlier committed version (allowed): $path"
      continue
    fi
  fi

  offending="${offending}  ${status}  ${path}"$'\n'
done <<< "$changed"

if [ -z "$offending" ]; then
  echo "No existing migration has been changed to anything new."
  exit 0
fi

{
  echo "Migrations are forward-only, and these already exist on $base:"
  echo
  printf '%s' "$offending"
  echo
  echo "Any environment that has applied one of these recorded its old checksum,"
  echo "so the runner will refuse it — and refuse every migration after it,"
  echo "leaving that database behind the code with no other symptom."
  echo "Put the change in a NEW migration instead."
} >&2
exit 1
