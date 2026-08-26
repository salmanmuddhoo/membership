-- Reference configuration: membership types, account types, fee schedules,
-- document checklists and workflow definitions (M2 Feature 2.2, S-205 to S-210).
--
-- Everything here is data the business changes without a release. That is the
-- point of the feature, and it is also its risk: a table an administrator can
-- edit is a table an auditor must be able to reconstruct. So every table in
-- this migration carries the configuration-audit trigger defined at the end,
-- which refuses a write that cannot name who made it.

-- ---------------------------------------------------------------------------
-- S-207 · Fee schedules
-- ---------------------------------------------------------------------------
-- Amounts are versioned rather than edited in place. The acceptance criterion
-- is that changing the entrance fee leaves existing receipts untouched, and a
-- schedule whose amounts are overwritten cannot honour that however careful the
-- application is: the row a receipt pointed at would silently mean something
-- else. So a change creates a new version, and anything that has already
-- charged a fee keeps pointing at the version it charged.
create table fee_schedule (
    id          uuid        primary key default gen_random_uuid(),
    code        text        not null unique,
    name        text        not null,
    description text        not null default '',
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create trigger fee_schedule_set_updated_at
    before update on fee_schedule
    for each row execute function set_updated_at();

create table fee_schedule_version (
    id            uuid        primary key default gen_random_uuid(),
    schedule_id   uuid        not null references fee_schedule(id) on delete cascade,
    version_no    integer     not null,

    -- The window during which this version's amounts applied. superseded_at is
    -- null for the version currently in force.
    effective_from timestamptz not null default now(),
    superseded_at  timestamptz,

    created_by    uuid        references app_user(id),
    created_at    timestamptz not null default now(),

    unique (schedule_id, version_no)
);

-- At most one live version per schedule. A partial unique index says this in a
-- way the database enforces, rather than leaving it to the writing code.
create unique index fee_schedule_version_current_idx
    on fee_schedule_version (schedule_id) where superseded_at is null;

-- The components the FRD names (7.8.1, 7.8.3). Held as a check constraint
-- rather than a lookup table because adding a component is a code change:
-- something has to know how to charge it.
create table fee_component (
    id          uuid        primary key default gen_random_uuid(),
    version_id  uuid        not null references fee_schedule_version(id) on delete cascade,
    code        text        not null
        check (code in ('entrance', 'takaful', 'shares', 'msa_deposit', 'processing')),
    amount      numeric(14, 2) not null check (amount >= 0),

    -- 'not_applicable' is why this column is not a boolean: the FRD leaves the
    -- minor MSA deposit and the processing fee unconfirmed (7.10.6, 7.8.3), and
    -- "we have decided this does not apply" must be distinguishable from
    -- "nobody has configured it yet".
    requirement text        not null default 'required'
        check (requirement in ('required', 'optional', 'not_applicable')),

    sort_order  integer     not null default 0,

    unique (version_id, code)
);

-- ---------------------------------------------------------------------------
-- S-208 · Document types and dynamic checklists
-- ---------------------------------------------------------------------------
create table document_type (
    id              uuid        primary key default gen_random_uuid(),
    code            text        not null unique,
    name            text        not null,
    description     text        not null default '',

    -- Whether an instance of this document carries an expiry date the system
    -- should track (a passport does; a birth certificate does not).
    tracks_expiry   boolean     not null default false,

    is_active       boolean     not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create trigger document_type_set_updated_at
    before update on document_type
    for each row execute function set_updated_at();

create table document_checklist (
    id          uuid        primary key default gen_random_uuid(),
    code        text        not null unique,
    name        text        not null,
    description text        not null default '',
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create trigger document_checklist_set_updated_at
    before update on document_checklist
    for each row execute function set_updated_at();

-- One row per (document, subject) pair. 'subject' is who the document is
-- about, which is not the same as whose application it is: an Individual
-- application requires an ID card for the applicant AND one for the nominee
-- (FRD 8.4.1), and a minor's application adds a guardian and a Takaful
-- beneficiary (7.10.5).
create table document_checklist_item (
    id               uuid        primary key default gen_random_uuid(),
    checklist_id     uuid        not null references document_checklist(id) on delete cascade,
    document_type_id uuid        not null references document_type(id),

    subject          text        not null
        check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary')),

    requirement      text        not null default 'required'
        check (requirement in ('required', 'optional')),

    sort_order       integer     not null default 0,

    unique (checklist_id, document_type_id, subject)
);

create index document_checklist_item_checklist_idx
    on document_checklist_item (checklist_id, subject, sort_order);

-- ---------------------------------------------------------------------------
-- S-205 · Membership types and their field rules
-- ---------------------------------------------------------------------------
create table membership_type (
    id           uuid        primary key default gen_random_uuid(),
    code         text        not null unique,
    name         text        not null,
    description  text        not null default '',

    -- Which checklist and which fee schedule apply to this type (S-205). Both
    -- are nullable so a type can be drafted before its schedule exists, and
    -- both restrict deletion: a checklist in use must be reassigned first.
    checklist_id     uuid    references document_checklist(id),
    fee_schedule_id  uuid    references fee_schedule(id),

    is_active    boolean     not null default true,
    sort_order   integer     not null default 0,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create trigger membership_type_set_updated_at
    before update on membership_type
    for each row execute function set_updated_at();

-- Which fields the application form shows for this type, and which of them the
-- applicant must fill in (FRD Section 5). The form renders from these rows, so
-- adding a field to the Corporate form is configuration.
create table membership_type_field (
    id                 uuid        primary key default gen_random_uuid(),
    membership_type_id uuid        not null references membership_type(id) on delete cascade,

    -- Matches the key the capture form and the printed form use.
    field_key          text        not null,
    label              text        not null,

    data_type          text        not null default 'text'
        check (data_type in ('text', 'number', 'date', 'email', 'phone', 'choice')),

    -- Permitted values for data_type = 'choice' (Gender, Marital status).
    choices            jsonb       not null default '[]'::jsonb,

    subject            text        not null default 'applicant'
        check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary')),

    is_visible         boolean     not null default true,
    is_mandatory       boolean     not null default false,
    sort_order         integer     not null default 0,

    unique (membership_type_id, subject, field_key),

    -- A hidden field cannot be mandatory: the applicant would have no way to
    -- satisfy it and capture would deadlock.
    constraint membership_type_field_hidden_is_optional
        check (is_visible or not is_mandatory)
);

create index membership_type_field_form_idx
    on membership_type_field (membership_type_id, subject, sort_order);

-- ---------------------------------------------------------------------------
-- S-206 · Account types and the default product
-- ---------------------------------------------------------------------------
create table account_type (
    id                     uuid        primary key default gen_random_uuid(),
    code                   text        not null unique,
    name                   text        not null,
    category               text        not null default 'savings',

    minimum_opening_amount numeric(14, 2) not null default 0
        check (minimum_opening_amount >= 0),

    -- Documents needed to open this account, reusing the checklist machinery
    -- rather than a second parallel mechanism (FRD 7.6, 7.7).
    checklist_id           uuid        references document_checklist(id),

    requires_approval      boolean     not null default false,
    default_status         text        not null default 'active'
        check (default_status in ('active', 'pending', 'inactive', 'dormant')),

    -- The product opened automatically when a membership is approved: the MSA
    -- today, something else after a configuration change (S-206, FRD 7.6).
    is_membership_default  boolean     not null default false,

    is_active              boolean     not null default true,
    sort_order             integer     not null default 0,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create trigger account_type_set_updated_at
    before update on account_type
    for each row execute function set_updated_at();

-- At most one default. "Exactly one" also needs at least one, which no
-- constraint can express against a table that starts empty — the seed below
-- provides it and the service refuses to clear the last one.
create unique index account_type_single_default_idx
    on account_type ((is_membership_default)) where is_membership_default;

-- ---------------------------------------------------------------------------
-- S-209 · Workflow definitions
-- ---------------------------------------------------------------------------
-- Statuses are configuration (decision 8), so Abeyance — which the FRD lists
-- in 7.4.3 but the business has not confirmed for phase 1 — can be enabled
-- without a release.
create table workflow_status (
    id          uuid        primary key default gen_random_uuid(),
    entity_type text        not null,
    code        text        not null,
    name        text        not null,
    description text        not null default '',

    -- A terminal status ends the workflow: nothing transitions out of it.
    is_terminal boolean     not null default false,

    is_active   boolean     not null default true,
    sort_order  integer     not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (entity_type, code)
);

create trigger workflow_status_set_updated_at
    before update on workflow_status
    for each row execute function set_updated_at();

create table workflow_definition (
    id          uuid        primary key default gen_random_uuid(),
    code        text        not null unique,
    name        text        not null,
    description text        not null default '',
    entity_type text        not null,
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create trigger workflow_definition_set_updated_at
    before update on workflow_definition
    for each row execute function set_updated_at();

-- A step is assigned to a ROLE, never to a person (decision 4): any holder of
-- the role may act, so the chain does not stall when one officer is away.
create table workflow_step (
    id             uuid        primary key default gen_random_uuid(),
    definition_id  uuid        not null references workflow_definition(id) on delete cascade,

    step_no        integer     not null,
    code           text        not null,
    name           text        not null,

    role_id        uuid        not null references role(id),

    -- The transition this step performs, named by status code rather than by a
    -- foreign key so a status can be renamed without rewriting the chain.
    from_status    text        not null,
    to_status      text        not null,

    -- Disabled steps stay in the chain and are skipped. The Regional Manager
    -- review ships this way (decision 2): visible to an administrator who may
    -- later enable it, rather than absent and forgotten.
    is_enabled     boolean     not null default true,

    -- How many distinct holders of the role must act before the step completes.
    -- 1 everywhere today; the column exists so a board quorum can be turned on
    -- without a migration.
    quorum_count   integer     not null default 1 check (quorum_count >= 1),

    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),

    unique (definition_id, step_no),
    unique (definition_id, code)
);

comment on column workflow_step.to_status is
    'The status the record enters once this step completes. Equal to '
    'from_status for a gate: a step that must be acted on before the chain '
    'proceeds but does not itself move the record. The Regional Manager '
    'oversight is one, which is why no constraint requires the two to differ '
    '— FRD 7.4.3 confirms no status for it, and inventing one would put a '
    'state in the model the business has not agreed to.';

create trigger workflow_step_set_updated_at
    before update on workflow_step
    for each row execute function set_updated_at();

create index workflow_step_chain_idx
    on workflow_step (definition_id, step_no);

-- ---------------------------------------------------------------------------
-- S-210 · Configuration changes are audited
-- ---------------------------------------------------------------------------
-- Auditing in the service layer would work until the day someone adds a table
-- and forgets the call. A trigger cannot be forgotten, so the guarantee the
-- story asks for — *every* configuration change recorded — is enforced here
-- rather than by convention.
--
-- The difficulty is that a trigger does not know who is acting. It reads the
-- actor from two session settings that the application sets inside the same
-- transaction as the change (see withConfigurationActor in src/lib/db/pool.ts),
-- and raises if they are absent. That makes an unattributable configuration
-- change impossible rather than merely discouraged: the write fails.
--
-- SECURITY DEFINER for the same reason as record_config_history: this must be
-- able to write audit_event even where the invoker's own privileges are being
-- tightened, and a pinned search_path stops the definer rights being hijacked
-- through name resolution.
create or replace function record_configuration_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    actor_id    uuid;
    actor_label text;
    row_id      text;
    old_json    jsonb;
    new_json    jsonb;
begin
    -- current_setting(..., true) returns null rather than raising when unset.
    actor_label := nullif(current_setting('albarakah.actor_description', true), '');
    actor_id    := nullif(current_setting('albarakah.actor_user_id', true), '')::uuid;

    if actor_label is null then
        raise exception
            'configuration change to % has no actor; wrap the write in '
            'withConfigurationActor()', tg_table_name
            using errcode = 'restrict_violation';
    end if;

    if (tg_op = 'DELETE') then
        old_json := to_jsonb(old);
        row_id   := old.id::text;
    else
        new_json := to_jsonb(new);
        row_id   := new.id::text;
        if (tg_op = 'UPDATE') then
            old_json := to_jsonb(old);
            -- An UPDATE that changes nothing but the timestamp is noise in the
            -- trail, and set_updated_at() guarantees one on every write.
            if (old_json - 'updated_at') = (new_json - 'updated_at') then
                return new;
            end if;
        end if;
    end if;

    insert into audit_event (
        actor_user_id, actor_description, action,
        entity_type, entity_id, previous_value, new_value
    ) values (
        actor_id,
        actor_label,
        'config.' || tg_table_name || '.' || lower(tg_op),
        tg_table_name,
        row_id,
        old_json,
        new_json
    );

    if (tg_op = 'DELETE') then return old; end if;
    return new;
end;
$$;

-- Attached to every table this migration creates. Stated as a loop so that the
-- list is the definition of "configuration" rather than nine copies of the same
-- three lines that can drift apart.
do $$
declare
    t text;
begin
    foreach t in array array[
        'fee_schedule', 'fee_schedule_version', 'fee_component',
        'document_type', 'document_checklist', 'document_checklist_item',
        'membership_type', 'membership_type_field',
        'account_type',
        'workflow_status', 'workflow_definition', 'workflow_step'
    ] loop
        execute format(
            'create trigger %I after insert or update or delete on %I '
            'for each row execute function record_configuration_change()',
            t || '_audit', t
        );
    end loop;
end
$$;

comment on function record_configuration_change() is
    'Writes every reference-configuration change to the append-only audit '
    'trail, and refuses any change whose actor the session has not declared '
    '(S-210).';

-- ---------------------------------------------------------------------------
-- Seed: the configuration the FRD confirms
-- ---------------------------------------------------------------------------
-- Seeds run as the migration owner, which the trigger above still requires an
-- actor for. The migration names itself: this is a real actor, and an auditor
-- reading the trail sees that these rows arrived with the schema rather than
-- from someone's console.
set local albarakah.actor_description = 'migration 0010_reference_configuration';

-- Document types (FRD 8.4.1, 7.10.5, 8.5).
insert into document_type (code, name, description, tracks_expiry) values
    ('id_card',            'Identity Card',            'National Identity Card', true),
    ('utility_bill',       'Utility Bill',             'Proof of address', false),
    ('birth_certificate',  'Birth Certificate',        'Required where the applicant is a minor', false),
    ('marriage_certificate','Marriage Certificate',    'Where applicable to the applicant''s circumstances', false),
    ('cert_registration',  'Certificate of Registration', 'Corporate applicants', false),
    ('memorandum',         'Memorandum or Constitution',  'Corporate applicants', false),
    ('written_resolution', 'Written Resolution',       'Corporate applicants', false),
    ('signed_form',        'Signed Application Form',  'The scanned form carrying all four signatures (FRD 8.5)', false);

-- Checklists, one per applicant type (FRD 8.4.1).
insert into document_checklist (code, name, description) values
    ('individual_kyc', 'Individual membership KYC',
     'KYC documents for an individual applicant and their nominee.'),
    ('corporate_kyc',  'Corporate membership KYC',
     'KYC documents for a corporate applicant and their nominee.'),
    ('minor_kyc',      'Minor membership KYC',
     'Adds the guardian and Takaful beneficiary subjects (FRD 7.10.5).'),
    ('msa_opening',    'MSA account opening',
     'Documents required to open a Multiplier Savings Account.');

insert into document_checklist_item
    (checklist_id, document_type_id, subject, requirement, sort_order)
select c.id, d.id, v.subject, v.requirement, v.sort_order
  from (values
    -- Individual: ID card and utility bill for the applicant, ID card for the
    -- nominee, birth certificate optional (required only for a minor, which is
    -- its own checklist), signed form always.
    ('individual_kyc', 'id_card',            'applicant',   'required', 1),
    ('individual_kyc', 'utility_bill',       'applicant',   'required', 2),
    ('individual_kyc', 'marriage_certificate','applicant',  'optional', 3),
    ('individual_kyc', 'signed_form',        'applicant',   'required', 4),
    ('individual_kyc', 'id_card',            'nominee',     'required', 5),

    ('corporate_kyc',  'cert_registration',  'applicant',   'required', 1),
    ('corporate_kyc',  'utility_bill',       'applicant',   'required', 2),
    ('corporate_kyc',  'memorandum',         'applicant',   'required', 3),
    ('corporate_kyc',  'written_resolution', 'applicant',   'required', 4),
    ('corporate_kyc',  'signed_form',        'applicant',   'required', 5),
    ('corporate_kyc',  'id_card',            'nominee',     'required', 6),

    ('minor_kyc',      'birth_certificate',  'applicant',   'required', 1),
    ('minor_kyc',      'id_card',            'applicant',   'optional', 2),
    ('minor_kyc',      'signed_form',        'applicant',   'required', 3),
    ('minor_kyc',      'id_card',            'guardian',    'required', 4),
    ('minor_kyc',      'utility_bill',       'guardian',    'required', 5),
    ('minor_kyc',      'id_card',            'nominee',     'required', 6),
    ('minor_kyc',      'id_card',            'beneficiary', 'required', 7),

    ('msa_opening',    'id_card',            'applicant',   'required', 1)
  ) as v(checklist_code, document_code, subject, requirement, sort_order)
  join document_checklist c on c.code = v.checklist_code
  join document_type d      on d.code = v.document_code;

-- Fee schedules (FRD 7.8.1, 7.10.6). Each opens at version 1.
insert into fee_schedule (code, name, description) values
    ('individual_membership', 'Individual membership',
     'Fees collected when an individual application is captured (FRD 7.8.1).'),
    ('corporate_membership',  'Corporate membership',
     'Corporate fees. Mirrors the individual schedule until the business confirms otherwise.'),
    ('minor_membership',      'Minor membership',
     'FRD 7.10.6. The MSA deposit is not applicable at application time, pending the open point in FRD Section 29.');

insert into fee_schedule_version (schedule_id, version_no)
select id, 1 from fee_schedule;

insert into fee_component (version_id, code, amount, requirement, sort_order)
select v.id, c.code, c.amount, c.requirement, c.sort_order
  from (values
    ('individual_membership', 'entrance',    1500.00, 'required',       1),
    ('individual_membership', 'takaful',     2000.00, 'required',       2),
    ('individual_membership', 'shares',      5000.00, 'required',       3),
    ('individual_membership', 'msa_deposit', 5000.00, 'required',       4),
    -- FRD 7.8.3 describes a processing fee but confirms no amount, so it ships
    -- configured and switched off rather than guessed at.
    ('individual_membership', 'processing',     0.00, 'not_applicable', 5),

    ('corporate_membership',  'entrance',    1500.00, 'required',       1),
    ('corporate_membership',  'takaful',     2000.00, 'required',       2),
    ('corporate_membership',  'shares',      5000.00, 'required',       3),
    ('corporate_membership',  'msa_deposit', 5000.00, 'required',       4),
    ('corporate_membership',  'processing',     0.00, 'not_applicable', 5),

    -- Rs 8,500, and explicitly no MSA deposit (FRD 7.10.6).
    ('minor_membership',      'entrance',    1500.00, 'required',       1),
    ('minor_membership',      'takaful',     2000.00, 'required',       2),
    ('minor_membership',      'shares',      5000.00, 'required',       3),
    ('minor_membership',      'msa_deposit',    0.00, 'not_applicable', 4),
    ('minor_membership',      'processing',     0.00, 'not_applicable', 5)
  ) as c(schedule_code, code, amount, requirement, sort_order)
  join fee_schedule s on s.code = c.schedule_code
  join fee_schedule_version v
    on v.schedule_id = s.id and v.superseded_at is null;

-- Membership types (FRD Section 5).
insert into membership_type
    (code, name, description, checklist_id, fee_schedule_id, sort_order)
select t.code, t.name, t.description, c.id, s.id, t.sort_order
  from (values
    ('individual', 'Individual', 'A natural person (FRD 5.1).',
     'individual_kyc', 'individual_membership', 1),
    ('corporate',  'Corporate',  'A registered entity (FRD 5.2).',
     'corporate_kyc',  'corporate_membership',  2),
    ('minor',      'Minor',      'A minor applicant with a guardian (FRD 7.10).',
     'minor_kyc',      'minor_membership',      3)
  ) as t(code, name, description, checklist_code, schedule_code, sort_order)
  join document_checklist c on c.code = t.checklist_code
  join fee_schedule s       on s.code = t.schedule_code;

-- The fields each type's form shows (FRD 5.1, 5.2, 5.3). The nominee block is
-- part of every application, so it is repeated per type rather than shared:
-- the business may later require different nominee fields for a corporate
-- applicant, and separate rows let that happen by configuration.
insert into membership_type_field
    (membership_type_id, field_key, label, data_type, choices, subject,
     is_mandatory, sort_order)
select m.id, f.field_key, f.label, f.data_type, f.choices::jsonb, f.subject,
       f.is_mandatory, f.sort_order
  from (values
    -- FRD 5.1 — Individual applicant.
    ('individual', 'surname',        'Surname',        'text',   '[]', 'applicant', true,  1),
    ('individual', 'name',           'Name',           'text',   '[]', 'applicant', true,  2),
    ('individual', 'nic',            'NIC',            'text',   '[]', 'applicant', true,  3),
    ('individual', 'gender',         'Gender',         'choice', '["Male","Female"]', 'applicant', true, 4),
    ('individual', 'marital_status', 'Marital status', 'choice', '["Single","Married","Others"]', 'applicant', false, 5),
    ('individual', 'address',        'Address',        'text',   '[]', 'applicant', true,  6),
    ('individual', 'mobile',         'Mobile',         'phone',  '[]', 'applicant', true,  7),
    ('individual', 'telephone',      'Telephone',      'phone',  '[]', 'applicant', false, 8),
    ('individual', 'email',          'Email',          'email',  '[]', 'applicant', false, 9),

    -- FRD 5.2 — Corporate applicant. No NIC, no gender; a contact person instead.
    ('corporate',  'name',             'Registered entity name',   'text',  '[]', 'applicant', true,  1),
    ('corporate',  'registration_no',  'Registration No.',         'text',  '[]', 'applicant', true,  2),
    ('corporate',  'address',          'Address',                  'text',  '[]', 'applicant', true,  3),
    ('corporate',  'mobile',           'Mobile',                   'phone', '[]', 'applicant', true,  4),
    ('corporate',  'telephone',        'Telephone',                'phone', '[]', 'applicant', false, 5),
    ('corporate',  'email',            'Email',                    'email', '[]', 'applicant', false, 6),
    ('corporate',  'contact_person',   'Contact Person',           'text',  '[]', 'applicant', true,  7),
    ('corporate',  'contact_telephone','Contact Person — Telephone','phone','[]', 'applicant', true,  8),

    -- FRD 7.10.1 — the minor's own particulars, plus date of birth, which is
    -- what makes minority checkable rather than asserted.
    ('minor',      'surname',        'Surname',        'text',   '[]', 'applicant', true,  1),
    ('minor',      'name',           'Name',           'text',   '[]', 'applicant', true,  2),
    ('minor',      'date_of_birth',  'Date of birth',  'date',   '[]', 'applicant', true,  3),
    ('minor',      'gender',         'Gender',         'choice', '["Male","Female"]', 'applicant', true, 4),
    ('minor',      'address',        'Address',        'text',   '[]', 'applicant', true,  5),
    ('minor',      'nic',            'NIC',            'text',   '[]', 'applicant', false, 6),

    -- FRD 7.10.2 — the guardian, captured on the minor's form only.
    ('minor',      'surname',        'Guardian surname',       'text', '[]', 'guardian', true, 1),
    ('minor',      'name',           'Guardian name',          'text', '[]', 'guardian', true, 2),
    ('minor',      'nic',            'Guardian NIC',           'text', '[]', 'guardian', true, 3),
    ('minor',      'member_id',      'Guardian Member ID',     'text', '[]', 'guardian', true, 4),
    ('minor',      'relationship',   'Relationship to minor',  'text', '[]', 'guardian', true, 5),
    ('minor',      'mobile',         'Guardian mobile',        'phone','[]', 'guardian', true, 6),

    -- FRD 5.3 — the nominee block, on every application.
    ('individual', 'surname',   'Nominee surname',   'text',  '[]', 'nominee', true,  1),
    ('individual', 'name',      'Nominee name',      'text',  '[]', 'nominee', true,  2),
    ('individual', 'nic',       'Nominee NIC',       'text',  '[]', 'nominee', true,  3),
    ('individual', 'address',   'Nominee address',   'text',  '[]', 'nominee', true,  4),
    ('individual', 'mobile',    'Nominee mobile',    'phone', '[]', 'nominee', false, 5),
    ('individual', 'telephone', 'Nominee telephone', 'phone', '[]', 'nominee', false, 6),
    ('individual', 'email',     'Nominee email',     'email', '[]', 'nominee', false, 7),

    ('corporate',  'surname',   'Nominee surname',   'text',  '[]', 'nominee', true,  1),
    ('corporate',  'name',      'Nominee name',      'text',  '[]', 'nominee', true,  2),
    ('corporate',  'nic',       'Nominee NIC',       'text',  '[]', 'nominee', true,  3),
    ('corporate',  'address',   'Nominee address',   'text',  '[]', 'nominee', true,  4),
    ('corporate',  'mobile',    'Nominee mobile',    'phone', '[]', 'nominee', false, 5),

    -- FRD 7.10.3/7.10.4 — successor guardian as nominee, and the Takaful
    -- beneficiary, which exists only on the minor's form.
    ('minor',      'surname',   'Successor guardian surname', 'text', '[]', 'nominee', true, 1),
    ('minor',      'name',      'Successor guardian name',    'text', '[]', 'nominee', true, 2),
    ('minor',      'nic',       'Successor guardian NIC',     'text', '[]', 'nominee', true, 3),
    ('minor',      'surname',   'Beneficiary surname',        'text', '[]', 'beneficiary', true, 1),
    ('minor',      'name',      'Beneficiary name',           'text', '[]', 'beneficiary', true, 2),
    ('minor',      'nic',       'Beneficiary NIC',            'text', '[]', 'beneficiary', true, 3)
  ) as f(type_code, field_key, label, data_type, choices, subject, is_mandatory, sort_order)
  join membership_type m on m.code = f.type_code;

-- Account types (FRD 7.6). The MSA is the membership default.
insert into account_type
    (code, name, category, minimum_opening_amount, checklist_id,
     requires_approval, default_status, is_membership_default, sort_order)
select a.code, a.name, a.category, a.minimum_opening_amount, c.id,
       a.requires_approval, a.default_status, a.is_membership_default, a.sort_order
  from (values
    ('msa', 'Multiplier Savings Account', 'savings', 5000.00,
     'msa_opening', false, 'active', true, 1)
  ) as a(code, name, category, minimum_opening_amount, checklist_code,
         requires_approval, default_status, is_membership_default, sort_order)
  join document_checklist c on c.code = a.checklist_code;

-- Statuses for the membership application (FRD 7.4.3). Abeyance ships inactive
-- rather than absent: the FRD names it, the business has not confirmed it for
-- phase 1, and decision 8 says statuses are configuration.
insert into workflow_status
    (entity_type, code, name, description, is_terminal, is_active, sort_order)
values
    ('membership_application', 'new', 'New',
     'Captured and submitted by regional staff for central processing.', false, true, 1),
    ('membership_application', 'submitted_for_review', 'Submit for Review',
     'Under review by the Secretary.', false, true, 2),
    ('membership_application', 'submitted_for_approval', 'Submit for Approval',
     'Passed Secretary review; awaiting the President''s decision.', false, true, 3),
    ('membership_application', 'approved', 'Approved',
     'Approved; Member and default account created.', true, true, 4),
    ('membership_application', 'rejected', 'Rejected',
     'Declined and returned to staff with a comment; fees refunded.', true, true, 5),
    ('membership_application', 'abeyance', 'Abeyance',
     'Deferred pending further information. Inactive until the business confirms it.',
     false, false, 6);

-- The roles the approval chain assigns steps to. Migration 0006 deliberately
-- left business roles to "the modules that define what they may do" — the
-- workflow is that module, so they arrive here, with no permissions yet: what
-- each may do is granted by the milestone that builds it.
insert into role (code, name, description) values
    ('regional_officer', 'Regional Officer',
     'Captures applications, prints and uploads the signed form, records the receipt (FRD 6).'),
    ('regional_manager', 'Regional Manager',
     'Optional regional oversight before central submission (FRD 7.4.2).'),
    ('secretary', 'Secretary',
     'Central review of submitted applications (FRD 7.4.2).'),
    ('president', 'President / Chairperson',
     'Final approval or rejection (FRD 7.4.2).')
on conflict (code) do nothing;

insert into workflow_definition (code, name, description, entity_type) values
    ('membership_application_approval', 'Membership application approval',
     'The confirmed chain: capture, then Secretary review, then President decision.',
     'membership_application');

-- The chain. Regional Manager sits between capture and review as an enabled=
-- false step (decision 2): it exists so an administrator can switch it on, and
-- its from/to statuses already line up so switching it on does not need a
-- migration.
insert into workflow_step
    (definition_id, step_no, code, name, role_id, from_status, to_status,
     is_enabled, quorum_count)
select d.id, s.step_no, s.code, s.name, r.id, s.from_status, s.to_status,
       s.is_enabled, s.quorum_count
  from (values
    (1, 'capture',  'Capture and submit',  'regional_officer',
     'new', 'submitted_for_review', true, 1),
    (2, 'regional_review', 'Regional oversight', 'regional_manager',
     'submitted_for_review', 'submitted_for_review', false, 1),
    (3, 'secretary_review', 'Secretary review', 'secretary',
     'submitted_for_review', 'submitted_for_approval', true, 1),
    (4, 'president_decision', 'President decision', 'president',
     'submitted_for_approval', 'approved', true, 1)
  ) as s(step_no, code, name, role_code, from_status, to_status,
         is_enabled, quorum_count)
  join workflow_definition d on d.code = 'membership_application_approval'
  join role r on r.code = s.role_code;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into permission (code, description) values
    ('config.view',   'View reference configuration: membership and account types, fees, checklists and workflows'),
    ('config.manage', 'Change reference configuration'),
    ('fee.manage',    'Change fee schedules')
on conflict (code) do nothing;

-- config.* goes to the System Administrator, who FRD Section 6 makes
-- responsible for "workflows, account types, fees, documents, configuration".
-- fee.manage goes there too for now; S-207 names the Treasurer as its owner,
-- and that role gains it in the milestone that gives the Treasurer a workload.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code in ('config.view', 'config.manage', 'fee.manage')
 where r.code = 'system_administrator'
on conflict do nothing;
