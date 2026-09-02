-- S-610: a minor reaching the age of majority becomes a full member without
-- anyone having to notice and act by hand.
--
-- FRD 7.10.10 asks for this to be configured, not assumed — "what the
-- Society requires at majority" was an open point, and the age of majority
-- itself is a fact about a jurisdiction, not something this schema should
-- guess. Both columns are nullable and ship null: the feature exists, inert,
-- until an administrator sets both — the same shape S-602's nominee_count
-- and S-609's quorum_count shipped in.
--
-- Detected from configuration alone, same reasoning as S-602's percentage
-- field: majority_age and majority_transition_type_id are set together or
-- not at all (enforced by the service, not the database — a partial state
-- is meaningless rather than dangerous, so a check constraint would be
-- fussier than the mistake is worth), and the scheduled job below finds
-- nothing to do for a type that has not configured them.
set local albarakah.actor_description = 'migration 0023_majority_transition';

alter table membership_type
    add column majority_age integer
        check (majority_age is null or majority_age between 1 and 100),
    add column majority_transition_type_id uuid
        references membership_type(id);

comment on column membership_type.majority_age is
    'Age at which a member of this type automatically becomes a member of '
    'majority_transition_type_id (S-610). Null means no automatic '
    'transition. Set together with majority_transition_type_id.';

comment on column membership_type.majority_transition_type_id is
    'The type a member of this type becomes at majority_age (S-610). Null '
    'means no automatic transition. Set together with majority_age.';
