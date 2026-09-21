-- Documents: what was filed, where it went, and whether anyone has checked it
-- (M4, S-405 to S-410).
--
-- SharePoint is the repository; this schema is the system of record for
-- everything ABOUT a document (FRD 8.3). That split is deliberate: a file can
-- be moved or re-shared in SharePoint without this system losing track of what
-- it is, who filed it, or whether the Secretary has verified it.
set local albarakah.actor_description = 'migration 0013_documents';

-- ---------------------------------------------------------------------------
-- S-406 · The document
-- ---------------------------------------------------------------------------
-- One row per logical document — "the applicant's ID card" — not per file. The
-- files are versions below, so replacing a poor scan (S-409) keeps one item on
-- the checklist with two versions behind it.
--
-- There is deliberately NO row for a document that has not been filed. Missing
-- is the absence of a row, computed against the configured checklist, rather
-- than a state someone has to remember to create. A checklist item with no
-- document is missing; that cannot drift out of step with reality.
create table document (
    id               uuid        primary key default gen_random_uuid(),

    document_type_id uuid        not null references document_type(id),

    -- Who the document is ABOUT, matching the checklist's subject.
    subject          text        not null
        check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary')),

    -- Filed against an application before approval, a member after. Exactly
    -- one is set: a document belongs to one or the other, and a check makes
    -- that true rather than conventional.
    application_id   uuid        references membership_application(id) on delete cascade,
    member_id        uuid        references member(id),

    -- FRD 8.4: Uploaded, Under Review, Verified, Rejected, Expired. Missing is
    -- not here, because a missing document has no row.
    state            text        not null default 'uploaded'
        check (state in ('uploaded', 'under_review', 'verified', 'rejected', 'expired')),

    -- Mandatory when the state is rejected; the person who has to fix it needs
    -- to know what is wrong. Enforced by the service, which can say so.
    rejection_reason text,

    verified_by      uuid        references app_user(id),
    verified_at      timestamptz,

    -- Only for document types configured to track expiry (S-208).
    expires_at       timestamptz,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),

    constraint document_belongs_to_exactly_one
        check ((application_id is not null) <> (member_id is not null))
);

create trigger document_set_updated_at
    before update on document
    for each row execute function set_updated_at();

-- One document per (owner, type, subject). A second ID card for the same
-- nominee is a replacement, not a new item.
create unique index document_unique_for_application_idx
    on document (application_id, document_type_id, subject)
    where application_id is not null;
create unique index document_unique_for_member_idx
    on document (member_id, document_type_id, subject)
    where member_id is not null;

create index document_state_idx on document (state, updated_at desc);
create index document_expiry_idx on document (expires_at)
    where expires_at is not null and state = 'verified';

-- ---------------------------------------------------------------------------
-- S-402, S-408, S-409 · The files
-- ---------------------------------------------------------------------------
-- A version starts as `pending` and becomes `committed` only when SharePoint
-- has confirmed the bytes are there. That two-step is the whole of S-408: an
-- upload that fails, or a browser that closes mid-transfer, leaves a pending
-- row that no checklist counts, so nothing can read as filed when it is not.
create table document_version (
    id                uuid        primary key default gen_random_uuid(),
    document_id       uuid        not null references document(id) on delete cascade,

    version_no        integer     not null,

    state             text        not null default 'pending'
        check (state in ('pending', 'committed', 'failed')),

    file_name         text        not null,
    content_type      text        not null,
    size_bytes        bigint      not null check (size_bytes > 0),

    -- Where it went. item_id is Graph's own identifier and survives a move;
    -- the path is what a human recognises and is refreshed when it changes.
    sharepoint_item_id text,
    sharepoint_path    text        not null,

    -- S-402: recorded at commit so the archived file can be proved unchanged
    -- later. The signed form is the reason this matters — what we hold must be
    -- what the applicant signed.
    checksum_sha256    text,

    uploaded_by       uuid        not null references app_user(id),
    created_at        timestamptz not null default now(),
    committed_at      timestamptz,

    -- Set when a later version replaces this one (S-409). The file itself is
    -- never deleted.
    superseded_at     timestamptz,

    unique (document_id, version_no)
);

-- At most one live version per document.
create unique index document_version_current_idx
    on document_version (document_id)
    where state = 'committed' and superseded_at is null;

create index document_version_pending_idx
    on document_version (created_at) where state = 'pending';

-- ---------------------------------------------------------------------------
-- S-405 · SharePoint folders
-- ---------------------------------------------------------------------------
-- Recording what has been created lets folder creation be skipped when it
-- already exists, without asking Graph every time.
create table sharepoint_folder (
    id          uuid        primary key default gen_random_uuid(),
    path        text        not null unique,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
-- document.upload already guards /api/v1/documents/upload-ticket, which the M1
-- spike added. The permission was never seeded, so that endpoint has been
-- unreachable by anyone — deny-by-default doing its job, but not usefully.
insert into permission (code, description) values
    ('document.view',   'View documents filed against an application or member'),
    ('document.upload', 'File a document against an application or member'),
    ('document.verify', 'Verify or reject a filed document')
on conflict (code) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from (values
    ('regional_officer', 'document.view'),
    ('regional_officer', 'document.upload'),
    ('regional_manager', 'document.view'),
    ('secretary',        'document.view'),
    ('secretary',        'document.upload'),
    -- Verification is the Secretary's central check (FRD 8.5): the officer who
    -- filed a document is not the person who confirms it is what it claims.
    ('secretary',        'document.verify'),
    ('president',        'document.view'),
    ('system_administrator', 'document.view')
  ) as g(role_code, permission_code)
  join role r       on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict do nothing;

-- The officer who filed a document may not be the one who verifies it. Same
-- shape as the application rules seeded in 0009, and trustworthy for the same
-- reason: the check reads the append-only audit trail.
insert into segregation_rule
    (entity_type, earlier_action, later_action, description)
values
    ('document',
     'document.filed',
     'document.verified',
     'The person who filed a document may not verify it.')
on conflict do nothing;
