-- Officer feedback: a migrated member's own account page said "opened on
-- 9 Sept 2026" — technically true (migration sets status 'approved' the
-- same as a live approval does), but reads as if a counter transaction
-- happened that day rather than a historical record landing in the
-- system. "migrated on" is what actually happened; "opened on" stays true
-- for an account a live approval — S-308, S-613, S-614 alike — actually
-- opened.
--
-- Per account, not per member: a migrated member can go on to open a
-- further account live (S-613) after the import, and that one really was
-- opened, not migrated — the two need to read differently on the same
-- page for the same person.
set local albarakah.actor_description = 'migration 0050_account_opened_via_migration';

alter table account
    add column opened_via_migration boolean not null default false;

comment on column account.opened_via_migration is
    'Set only by the legacy import (migration/members.ts''s own '
    'openMigrationAccount, and createMemberFromApplication when it opens '
    'Shares/MSA for a migrated member) — never by a live approval. Read by '
    'the member/customer detail page to say "migrated on", not "opened", '
    'for this account''s own date.';
