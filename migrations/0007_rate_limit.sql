-- Rate limiting state (S-111).
--
-- Kept in the database rather than in process memory because the application
-- runs as serverless functions: each instance has its own memory, so an
-- in-process counter would let a caller multiply their allowance by however
-- many instances happen to be warm. A shared counter is the only kind that
-- means anything here.
--
-- A fixed window, not a sliding one: a sliding window needs a row per request,
-- which is a write amplification this does not warrant. The trade-off is that a
-- caller can burst across a window boundary, which is acceptable for slowing
-- abuse rather than enforcing a precise quota.

create table rate_limit_window (
    -- Who is being limited — an application user id today, but text so an API
    -- key or an address can be limited later without a migration.
    subject       text        not null,
    -- Start of the fixed window this count belongs to.
    window_start  timestamptz not null,
    request_count integer     not null default 0,

    primary key (subject, window_start)
);

-- Supports the sweep of expired windows.
create index rate_limit_window_expiry_idx on rate_limit_window (window_start);

comment on table rate_limit_window is
    'Fixed-window request counters. Rows older than a few windows are dead '
    'weight and are swept opportunistically; nothing reads them.';
