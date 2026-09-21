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

# Narrow, named exceptions: migrations that never once applied successfully
# anywhere, so no environment ever recorded a checksum for one to drift from.
# The harm this check exists to prevent cannot happen to a migration nothing
# ever recorded. Each entry needs that evidence — "it failed everywhere, on
# every attempt, from the day it merged" — and nothing weaker; the fix belongs
# in a NEW migration otherwise, exactly as this check insists everywhere else.
#
#   0030_non_member_signed_form.sql — its `insert into
#   document_checklist_item` carried no `on conflict` guard and hit a row an
#   administrator had already added by hand. Every attempt from the day it
#   merged (PR #83) through PR #88 rolled back, and every migration after it
#   was silently skipped the whole time. Fixed by the PR that added this
#   exception.
#
#   0053_notifications.sql — a SYNTAX error: PostgreSQL concatenates two
#   string literals separated by a newline, but the E'' prefix is only legal
#   on the first literal of such a group, and four of the seeded templates
#   put an E'' literal after a plain one. That is rejected at parse time by
#   every PostgreSQL there is, on every database, regardless of what is
#   already in it — so unlike 0030 this one could not even in principle have
#   applied somewhere. M9's two tables therefore existed nowhere, and 0054
#   onwards could never have been reached. Fixed by the PR that added this
#   exception (the bodies are joined with `||` instead).
grandfathered='
migrations/0030_non_member_signed_form.sql
migrations/0053_notifications.sql
'

offending=""
while IFS=$'\t' read -r status path _rest; do
  [ -z "${path:-}" ] && continue

  if printf '%s' "$grandfathered" | grep -qx -- "$path"; then
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
