-- Which membership types may open an account of a given type (officer
-- feedback: Corporate must never be offered HSA, and every other permutation
-- in the eligibility matrix should be something an administrator sets, not
-- something wired into the capture code).
--
-- No row for a type at all means unrestricted — every account type already
-- configured keeps working exactly as it does today, open to every
-- membership type, until an administrator opts one INTO restriction by
-- adding rows for it. That is the cheaper default: most account types (a
-- term deposit, say) have no reason to be restricted at all, and forcing
-- every one of them to enumerate every membership type just to keep
-- functioning would be busywork with no behaviour behind it.
set local albarakah.actor_description = 'migration 0040_account_type_eligibility';

create table account_type_membership_type (
    id                  uuid primary key default gen_random_uuid(),
    account_type_id     uuid not null references account_type(id) on delete cascade,
    membership_type_id  uuid not null references membership_type(id) on delete cascade,
    unique (account_type_id, membership_type_id)
);

-- The read direction capture.ts's own validation takes (does membership type
-- X appear among account type Y's rows) is covered by the unique index
-- above, whose leading column is account_type_id. This is the other
-- direction: an administrator's own account-types screen reading "which
-- membership types are currently ticked for this account type" the other
-- way round is the same query, and the officer-facing "what may this
-- membership type open" reads by membership_type_id instead.
create index account_type_membership_type_membership_type_id_idx
    on account_type_membership_type (membership_type_id);

-- Not part of migration 0010's own trigger-attaching loop — that file is
-- already on main and stays exactly as it shipped (CLAUDE.md) — but the same
-- function, audited under this table's own name exactly as every other
-- reference-configuration table is.
create trigger account_type_membership_type_audit
    after insert or update or delete on account_type_membership_type
    for each row execute function record_configuration_change();

comment on table account_type_membership_type is
    'Which membership types may open an account of this type (S-206). No '
    'row for a type = open to every membership type.';
