-- The expiry a replacement upload is FOR (M4 correction).
set local albarakah.actor_description = 'migration 0016_document_version_intended_expiry';

-- This column belongs to 0013 by rights, and was added to that file after it
-- had already been applied to an environment. Migrations are forward-only for
-- exactly this reason: the runner compares each file against what it recorded
-- and refuses to go on when they differ, so every later migration stopped
-- applying too. 0013 has been restored to what was actually applied, and the
-- change it gained lives here instead.
--
-- Why the column exists: an expiry date supplied with an upload cannot be
-- written to the document when the upload BEGINS, because an upload that never
-- arrives would then have moved the expiry of the document it was replacing —
-- a document that is still the live one. It is parked on the version and
-- applied to the document at commit, when the file is known to be there.
alter table document_version
    add column if not exists intended_expires_at timestamptz;

comment on column document_version.intended_expires_at is
    'The expiry this upload is for, applied to the document only at commit.';
