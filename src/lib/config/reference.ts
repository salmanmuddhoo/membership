// Reference configuration: the values the business changes without a release
// (M2 Feature 2.2, S-205 to S-210).
//
// Every write goes through withConfigurationActor. That is not a convention
// this module chooses to follow — migration 0010 puts a trigger on each of
// these tables that refuses a change it cannot attribute, so a write outside
// the wrapper fails at the database. The audit entry is therefore written by
// the database in the same transaction as the change, and this module does not
// write one itself: two trails would only disagree.
import type { PoolClient } from 'pg';
import { query, withConfigurationActor } from '../db/pool';
import type { ConfigurationActor } from '../db/pool';

// A refusal the caller should show the person who asked, as opposed to a
// defect. Mirrors AdminError in ../admin/roles.ts.
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_found' | 'invalid' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Actor {
  userId: string;
  email: string;
}

function actorFor(actor: Actor): ConfigurationActor {
  return { userId: actor.userId, description: actor.email };
}

// ---------------------------------------------------------------------------
// S-205 · Membership types and their field rules
// ---------------------------------------------------------------------------
export type FieldSubject = 'applicant' | 'nominee' | 'guardian' | 'beneficiary';

export interface MembershipTypeField {
  id: string;
  fieldKey: string;
  label: string;
  dataType: string;
  choices: string[];
  subject: FieldSubject;
  isVisible: boolean;
  isMandatory: boolean;
  sortOrder: number;
}

export interface MembershipType {
  id: string;
  code: string;
  name: string;
  description: string;
  checklistId: string | null;
  checklistName: string | null;
  feeScheduleId: string | null;
  feeScheduleName: string | null;
  isActive: boolean;
  sortOrder: number;
  fields: MembershipTypeField[];
}

export async function listMembershipTypes(): Promise<MembershipType[]> {
  const types = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    checklist_id: string | null;
    checklist_name: string | null;
    fee_schedule_id: string | null;
    fee_schedule_name: string | null;
    is_active: boolean;
    sort_order: number;
  }>(
    `select m.id, m.code, m.name, m.description,
            m.checklist_id, c.name as checklist_name,
            m.fee_schedule_id, f.name as fee_schedule_name,
            m.is_active, m.sort_order
       from membership_type m
       left join document_checklist c on c.id = m.checklist_id
       left join fee_schedule f       on f.id = m.fee_schedule_id
      order by m.sort_order, m.name`
  );

  // One query for all fields rather than one per type: the number of types is
  // small but unbounded, and a query per row in a loop is how a page that was
  // fast in testing becomes slow in use.
  const fields = await query<{
    id: string;
    membership_type_id: string;
    field_key: string;
    label: string;
    data_type: string;
    choices: string[];
    subject: FieldSubject;
    is_visible: boolean;
    is_mandatory: boolean;
    sort_order: number;
  }>(
    `select id, membership_type_id, field_key, label, data_type, choices,
            subject, is_visible, is_mandatory, sort_order
       from membership_type_field
      order by subject, sort_order, label`
  );

  const byType = new Map<string, MembershipTypeField[]>();
  for (const f of fields.rows) {
    const list = byType.get(f.membership_type_id) ?? [];
    list.push({
      id: f.id,
      fieldKey: f.field_key,
      label: f.label,
      dataType: f.data_type,
      choices: f.choices,
      subject: f.subject,
      isVisible: f.is_visible,
      isMandatory: f.is_mandatory,
      sortOrder: f.sort_order,
    });
    byType.set(f.membership_type_id, list);
  }

  return types.rows.map(t => ({
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    checklistId: t.checklist_id,
    checklistName: t.checklist_name,
    feeScheduleId: t.fee_schedule_id,
    feeScheduleName: t.fee_schedule_name,
    isActive: t.is_active,
    sortOrder: t.sort_order,
    fields: byType.get(t.id) ?? [],
  }));
}

// Which checklist and which fee schedule this type uses (S-205).
export async function setMembershipTypeReferences(
  typeId: string,
  refs: { checklistId: string | null; feeScheduleId: string | null },
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update membership_type
          set checklist_id = $2, fee_schedule_id = $3
        where id = $1`,
      [typeId, refs.checklistId, refs.feeScheduleId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That membership type no longer exists.',
        'not_found'
      );
    }
  });
}

// Whether a field appears on the form and whether it must be filled in.
export async function setFieldRule(
  fieldId: string,
  rule: { isVisible: boolean; isMandatory: boolean },
  actor: Actor
): Promise<void> {
  // The database refuses a hidden-but-mandatory field, which would deadlock
  // capture. Catching it here turns a constraint name into a sentence.
  if (!rule.isVisible && rule.isMandatory) {
    throw new ConfigError(
      'A field that is hidden cannot be mandatory — nobody could fill it in.'
    );
  }

  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update membership_type_field
          set is_visible = $2, is_mandatory = $3
        where id = $1`,
      [fieldId, rule.isVisible, rule.isMandatory]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That field no longer exists.', 'not_found');
    }
  });
}

// ---------------------------------------------------------------------------
// S-206 · Account types and the default product
// ---------------------------------------------------------------------------
export interface AccountType {
  id: string;
  code: string;
  name: string;
  category: string;
  minimumOpeningAmount: string;
  checklistId: string | null;
  checklistName: string | null;
  requiresApproval: boolean;
  defaultStatus: string;
  isMembershipDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

// numeric comes back from node-postgres as a string, and it stays one all the
// way to the page. Money through a float is a rounding error waiting for a
// reconciliation to find it.
export async function listAccountTypes(): Promise<AccountType[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    category: string;
    minimum_opening_amount: string;
    checklist_id: string | null;
    checklist_name: string | null;
    requires_approval: boolean;
    default_status: string;
    is_membership_default: boolean;
    is_active: boolean;
    sort_order: number;
  }>(
    `select a.id, a.code, a.name, a.category, a.minimum_opening_amount,
            a.checklist_id, c.name as checklist_name,
            a.requires_approval, a.default_status, a.is_membership_default,
            a.is_active, a.sort_order
       from account_type a
       left join document_checklist c on c.id = a.checklist_id
      order by a.sort_order, a.name`
  );

  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    minimumOpeningAmount: r.minimum_opening_amount,
    checklistId: r.checklist_id,
    checklistName: r.checklist_name,
    requiresApproval: r.requires_approval,
    defaultStatus: r.default_status,
    isMembershipDefault: r.is_membership_default,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

export interface AccountTypeInput {
  code: string;
  name: string;
  category: string;
  minimumOpeningAmount: string;
  checklistId: string | null;
  requiresApproval: boolean;
  defaultStatus: string;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function validateAmount(amount: string): void {
  if (!AMOUNT_PATTERN.test(amount.trim())) {
    throw new ConfigError(
      'An amount must be a number with at most two decimal places.'
    );
  }
}

export async function createAccountType(
  input: AccountTypeInput,
  actor: Actor
): Promise<string> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ConfigError(
      'A code must start with a letter and contain only lowercase letters, ' +
        'digits and underscores.'
    );
  }
  if (!input.name.trim()) throw new ConfigError('A name is required.');
  validateAmount(input.minimumOpeningAmount);

  return withConfigurationActor(actorFor(actor), async client => {
    const existing = await client.query(
      'select 1 from account_type where code = $1',
      [code]
    );
    if (existing.rowCount) {
      throw new ConfigError(
        `An account type with code ${code} already exists.`,
        'conflict'
      );
    }

    const result = await client.query<{ id: string }>(
      `insert into account_type
         (code, name, category, minimum_opening_amount, checklist_id,
          requires_approval, default_status,
          sort_order)
       values ($1, $2, $3, $4, $5, $6, $7,
               coalesce((select max(sort_order) + 1 from account_type), 1))
       returning id`,
      [
        code,
        input.name.trim(),
        input.category.trim() || 'savings',
        input.minimumOpeningAmount.trim(),
        input.checklistId,
        input.requiresApproval,
        input.defaultStatus,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updateAccountType(
  id: string,
  input: Omit<AccountTypeInput, 'code'> & { isActive: boolean },
  actor: Actor
): Promise<void> {
  if (!input.name.trim()) throw new ConfigError('A name is required.');
  validateAmount(input.minimumOpeningAmount);

  await withConfigurationActor(actorFor(actor), async client => {
    // Deactivating the default product would leave a membership approval with
    // no account to open. Refuse rather than discover it at approval time.
    if (!input.isActive) {
      const isDefault = await client.query(
        'select 1 from account_type where id = $1 and is_membership_default',
        [id]
      );
      if (isDefault.rowCount) {
        throw new ConfigError(
          'This is the membership default product. Make another type the ' +
            'default before deactivating it.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      `update account_type
          set name = $2, category = $3, minimum_opening_amount = $4,
              checklist_id = $5, requires_approval = $6, default_status = $7,
              is_active = $8
        where id = $1`,
      [
        id,
        input.name.trim(),
        input.category.trim() || 'savings',
        input.minimumOpeningAmount.trim(),
        input.checklistId,
        input.requiresApproval,
        input.defaultStatus,
        input.isActive,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }
  });
}

// S-206: "Given the default is changed Then subsequent approvals open the new
// type." A partial unique index allows only one default row, so the old one is
// cleared inside the same transaction as the new one is set — attempting it
// the other way round would trip the index.
export async function setMembershipDefault(
  accountTypeId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const target = await client.query<{ is_active: boolean }>(
      'select is_active from account_type where id = $1',
      [accountTypeId]
    );
    if (target.rowCount === 0) {
      throw new ConfigError('That account type no longer exists.', 'not_found');
    }
    if (!target.rows[0].is_active) {
      throw new ConfigError(
        'An inactive account type cannot be the membership default.'
      );
    }

    await client.query(
      'update account_type set is_membership_default = false where is_membership_default and id <> $1',
      [accountTypeId]
    );
    await client.query(
      'update account_type set is_membership_default = true where id = $1',
      [accountTypeId]
    );
  });
}

// The product a membership approval opens. Read at approval time rather than
// cached, so a change takes effect on the next approval (S-206).
export async function getMembershipDefaultAccountType(): Promise<AccountType | null> {
  const all = await listAccountTypes();
  return all.find(a => a.isMembershipDefault) ?? null;
}

// ---------------------------------------------------------------------------
// S-207 · Fee schedules
// ---------------------------------------------------------------------------
export type FeeRequirement = 'required' | 'optional' | 'not_applicable';

export const FEE_COMPONENTS = [
  'entrance',
  'takaful',
  'shares',
  'msa_deposit',
  'processing',
] as const;

export type FeeComponentCode = (typeof FEE_COMPONENTS)[number];

export interface FeeComponent {
  code: FeeComponentCode;
  amount: string;
  requirement: FeeRequirement;
  sortOrder: number;
}

export interface FeeScheduleVersion {
  id: string;
  versionNo: number;
  effectiveFrom: Date;
  supersededAt: Date | null;
  components: FeeComponent[];
}

export interface FeeSchedule {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  current: FeeScheduleVersion | null;
  // Superseded versions, newest first. An amount that was charged is readable
  // for as long as the receipt that charged it exists.
  history: FeeScheduleVersion[];
}

interface VersionRow {
  version_id: string;
  schedule_id: string;
  version_no: number;
  effective_from: Date;
  superseded_at: Date | null;
}

interface ComponentRow {
  version_id: string;
  code: FeeComponentCode;
  amount: string;
  requirement: FeeRequirement;
  sort_order: number;
}

function assembleVersions(
  versions: VersionRow[],
  components: ComponentRow[]
): Map<string, FeeScheduleVersion[]> {
  const byVersion = new Map<string, FeeComponent[]>();
  for (const c of components) {
    const list = byVersion.get(c.version_id) ?? [];
    list.push({
      code: c.code,
      amount: c.amount,
      requirement: c.requirement,
      sortOrder: c.sort_order,
    });
    byVersion.set(c.version_id, list);
  }

  const bySchedule = new Map<string, FeeScheduleVersion[]>();
  for (const v of versions) {
    const list = bySchedule.get(v.schedule_id) ?? [];
    list.push({
      id: v.version_id,
      versionNo: v.version_no,
      effectiveFrom: v.effective_from,
      supersededAt: v.superseded_at,
      components: byVersion.get(v.version_id) ?? [],
    });
    bySchedule.set(v.schedule_id, list);
  }
  return bySchedule;
}

export async function listFeeSchedules(): Promise<FeeSchedule[]> {
  const schedules = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    is_active: boolean;
  }>(
    'select id, code, name, description, is_active from fee_schedule order by name'
  );

  const versions = await query<VersionRow>(
    `select id as version_id, schedule_id, version_no, effective_from, superseded_at
       from fee_schedule_version
      order by schedule_id, version_no desc`
  );

  const components = await query<ComponentRow>(
    `select version_id, code, amount, requirement, sort_order
       from fee_component
      order by sort_order, code`
  );

  const bySchedule = assembleVersions(versions.rows, components.rows);

  return schedules.rows.map(s => {
    const all = bySchedule.get(s.id) ?? [];
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      isActive: s.is_active,
      current: all.find(v => v.supersededAt === null) ?? null,
      history: all.filter(v => v.supersededAt !== null),
    };
  });
}

// Amounts in force for one schedule right now. What a capture screen asks for.
export async function getCurrentFees(
  scheduleCode: string
): Promise<FeeComponent[]> {
  const result = await query<ComponentRow>(
    `select c.version_id, c.code, c.amount, c.requirement, c.sort_order
       from fee_component c
       join fee_schedule_version v on v.id = c.version_id
       join fee_schedule s         on s.id = v.schedule_id
      where s.code = $1 and v.superseded_at is null
      order by c.sort_order, c.code`,
    [scheduleCode]
  );
  return result.rows.map(r => ({
    code: r.code,
    amount: r.amount,
    requirement: r.requirement,
    sortOrder: r.sort_order,
  }));
}

// Publish a new set of amounts (S-207).
//
// The change is a NEW VERSION, never an edit of the live one. That is what
// makes "existing receipts are untouched" a property of the schema rather than
// a promise: a receipt records the version it charged, and that row's amounts
// can no longer change.
export async function publishFeeVersion(
  scheduleId: string,
  components: ReadonlyArray<{
    code: FeeComponentCode;
    amount: string;
    requirement: FeeRequirement;
  }>,
  actor: Actor
): Promise<string> {
  if (components.length === 0) {
    throw new ConfigError('A fee version must state at least one component.');
  }

  const seen = new Set<string>();
  for (const c of components) {
    if (!FEE_COMPONENTS.includes(c.code)) {
      throw new ConfigError(`Unknown fee component ${c.code}.`);
    }
    if (seen.has(c.code)) {
      throw new ConfigError(`Fee component ${c.code} is listed twice.`);
    }
    seen.add(c.code);
    validateAmount(c.amount);
    if (c.requirement === 'required' && Number(c.amount) === 0) {
      throw new ConfigError(
        `${c.code} is marked required but its amount is zero. Mark it ` +
          'optional or not applicable instead.'
      );
    }
  }

  return withConfigurationActor(actorFor(actor), async client => {
    const schedule = await client.query(
      'select 1 from fee_schedule where id = $1',
      [scheduleId]
    );
    if (schedule.rowCount === 0) {
      throw new ConfigError('That fee schedule no longer exists.', 'not_found');
    }

    // Close the live version before opening the next one: the partial unique
    // index permits only one un-superseded version per schedule.
    await client.query(
      `update fee_schedule_version
          set superseded_at = now()
        where schedule_id = $1 and superseded_at is null`,
      [scheduleId]
    );

    const version = await client.query<{ id: string }>(
      `insert into fee_schedule_version (schedule_id, version_no, created_by)
       values ($1,
               coalesce((select max(version_no) + 1 from fee_schedule_version
                          where schedule_id = $1), 1),
               $2)
       returning id`,
      [scheduleId, actor.userId]
    );
    const versionId = version.rows[0].id;

    for (const [index, c] of components.entries()) {
      await client.query(
        `insert into fee_component (version_id, code, amount, requirement, sort_order)
         values ($1, $2, $3, $4, $5)`,
        [versionId, c.code, c.amount, c.requirement, index + 1]
      );
    }

    return versionId;
  });
}

// ---------------------------------------------------------------------------
// S-208 · Document types and dynamic checklists
// ---------------------------------------------------------------------------
export interface DocumentType {
  id: string;
  code: string;
  name: string;
  description: string;
  tracksExpiry: boolean;
  isActive: boolean;
}

export interface ChecklistItem {
  id: string;
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  tracksExpiry: boolean;
  subject: FieldSubject;
  requirement: 'required' | 'optional';
  sortOrder: number;
}

export interface DocumentChecklist {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  items: ChecklistItem[];
}

export async function listDocumentTypes(): Promise<DocumentType[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    tracks_expiry: boolean;
    is_active: boolean;
  }>(
    `select id, code, name, description, tracks_expiry, is_active
       from document_type order by name`
  );
  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    tracksExpiry: r.tracks_expiry,
    isActive: r.is_active,
  }));
}

export async function listChecklists(): Promise<DocumentChecklist[]> {
  const lists = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    is_active: boolean;
  }>(
    'select id, code, name, description, is_active from document_checklist order by name'
  );

  const items = await query<{
    id: string;
    checklist_id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `select i.id, i.checklist_id, i.document_type_id,
            d.code as document_code, d.name as document_name, d.tracks_expiry,
            i.subject, i.requirement, i.sort_order
       from document_checklist_item i
       join document_type d on d.id = i.document_type_id
      order by i.subject, i.sort_order, d.name`
  );

  const byList = new Map<string, ChecklistItem[]>();
  for (const i of items.rows) {
    const list = byList.get(i.checklist_id) ?? [];
    list.push({
      id: i.id,
      documentTypeId: i.document_type_id,
      documentCode: i.document_code,
      documentName: i.document_name,
      tracksExpiry: i.tracks_expiry,
      subject: i.subject,
      requirement: i.requirement,
      sortOrder: i.sort_order,
    });
    byList.set(i.checklist_id, list);
  }

  return lists.rows.map(l => ({
    id: l.id,
    code: l.code,
    name: l.name,
    description: l.description,
    isActive: l.is_active,
    items: byList.get(l.id) ?? [],
  }));
}

export async function addChecklistItem(
  checklistId: string,
  item: {
    documentTypeId: string;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
  },
  actor: Actor
): Promise<string> {
  return withConfigurationActor(actorFor(actor), async client => {
    const duplicate = await client.query(
      `select 1 from document_checklist_item
        where checklist_id = $1 and document_type_id = $2 and subject = $3`,
      [checklistId, item.documentTypeId, item.subject]
    );
    if (duplicate.rowCount) {
      throw new ConfigError(
        'That document is already on this checklist for that subject.',
        'conflict'
      );
    }

    const result = await client.query<{ id: string }>(
      `insert into document_checklist_item
         (checklist_id, document_type_id, subject, requirement, sort_order)
       values ($1, $2, $3, $4,
               coalesce((select max(sort_order) + 1
                           from document_checklist_item
                          where checklist_id = $1), 1))
       returning id`,
      [checklistId, item.documentTypeId, item.subject, item.requirement]
    );
    return result.rows[0].id;
  });
}

export async function setChecklistItemRequirement(
  itemId: string,
  requirement: 'required' | 'optional',
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'update document_checklist_item set requirement = $2 where id = $1',
      [itemId, requirement]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That checklist item no longer exists.',
        'not_found'
      );
    }
  });
}

export async function removeChecklistItem(
  itemId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'delete from document_checklist_item where id = $1',
      [itemId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError(
        'That checklist item no longer exists.',
        'not_found'
      );
    }
  });
}

// The checklist that applies to an applicant of this membership type (S-208).
// Grouped by subject because that is how the capture screen presents it: the
// applicant's documents, then the nominee's, then the guardian's.
export async function checklistForMembershipType(
  membershipTypeCode: string
): Promise<Map<FieldSubject, ChecklistItem[]>> {
  const result = await query<{
    id: string;
    document_type_id: string;
    document_code: string;
    document_name: string;
    tracks_expiry: boolean;
    subject: FieldSubject;
    requirement: 'required' | 'optional';
    sort_order: number;
  }>(
    `select i.id, i.document_type_id, d.code as document_code,
            d.name as document_name, d.tracks_expiry,
            i.subject, i.requirement, i.sort_order
       from membership_type m
       join document_checklist_item i on i.checklist_id = m.checklist_id
       join document_type d on d.id = i.document_type_id
      where m.code = $1 and d.is_active
      order by i.subject, i.sort_order`,
    [membershipTypeCode]
  );

  const bySubject = new Map<FieldSubject, ChecklistItem[]>();
  for (const r of result.rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push({
      id: r.id,
      documentTypeId: r.document_type_id,
      documentCode: r.document_code,
      documentName: r.document_name,
      tracksExpiry: r.tracks_expiry,
      subject: r.subject,
      requirement: r.requirement,
      sortOrder: r.sort_order,
    });
    bySubject.set(r.subject, list);
  }
  return bySubject;
}

// ---------------------------------------------------------------------------
// S-209 · Workflow definitions
// ---------------------------------------------------------------------------
export interface WorkflowStep {
  id: string;
  stepNo: number;
  code: string;
  name: string;
  roleId: string;
  roleName: string;
  fromStatus: string;
  toStatus: string;
  isEnabled: boolean;
  quorumCount: number;
}

export interface WorkflowDefinition {
  id: string;
  code: string;
  name: string;
  description: string;
  entityType: string;
  isActive: boolean;
  steps: WorkflowStep[];
}

export interface WorkflowStatus {
  id: string;
  entityType: string;
  code: string;
  name: string;
  description: string;
  isTerminal: boolean;
  isActive: boolean;
  sortOrder: number;
}

export async function listWorkflowStatuses(
  entityType?: string
): Promise<WorkflowStatus[]> {
  const result = await query<{
    id: string;
    entity_type: string;
    code: string;
    name: string;
    description: string;
    is_terminal: boolean;
    is_active: boolean;
    sort_order: number;
  }>(
    `select id, entity_type, code, name, description, is_terminal, is_active,
            sort_order
       from workflow_status
      where $1::text is null or entity_type = $1::text
      order by entity_type, sort_order`,
    [entityType ?? null]
  );
  return result.rows.map(r => ({
    id: r.id,
    entityType: r.entity_type,
    code: r.code,
    name: r.name,
    description: r.description,
    isTerminal: r.is_terminal,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const definitions = await query<{
    id: string;
    code: string;
    name: string;
    description: string;
    entity_type: string;
    is_active: boolean;
  }>(
    `select id, code, name, description, entity_type, is_active
       from workflow_definition order by name`
  );

  const steps = await query<{
    id: string;
    definition_id: string;
    step_no: number;
    code: string;
    name: string;
    role_id: string;
    role_name: string;
    from_status: string;
    to_status: string;
    is_enabled: boolean;
    quorum_count: number;
  }>(
    `select s.id, s.definition_id, s.step_no, s.code, s.name,
            s.role_id, r.name as role_name,
            s.from_status, s.to_status, s.is_enabled, s.quorum_count
       from workflow_step s
       join role r on r.id = s.role_id
      order by s.definition_id, s.step_no`
  );

  const byDefinition = new Map<string, WorkflowStep[]>();
  for (const s of steps.rows) {
    const list = byDefinition.get(s.definition_id) ?? [];
    list.push({
      id: s.id,
      stepNo: s.step_no,
      code: s.code,
      name: s.name,
      roleId: s.role_id,
      roleName: s.role_name,
      fromStatus: s.from_status,
      toStatus: s.to_status,
      isEnabled: s.is_enabled,
      quorumCount: s.quorum_count,
    });
    byDefinition.set(s.definition_id, list);
  }

  return definitions.rows.map(d => ({
    id: d.id,
    code: d.code,
    name: d.name,
    description: d.description,
    entityType: d.entity_type,
    isActive: d.is_active,
    steps: byDefinition.get(d.id) ?? [],
  }));
}

// The steps that actually run: disabled ones are configuration an administrator
// can see, not stages the chain waits at. This is what a workflow engine should
// consult, so that enabling the Regional Manager review (decision 2) changes
// behaviour with no code change.
export async function activeChain(
  definitionCode: string
): Promise<WorkflowStep[]> {
  const all = await listWorkflows();
  const definition = all.find(d => d.code === definitionCode);
  if (!definition) {
    throw new ConfigError(`Unknown workflow ${definitionCode}.`, 'not_found');
  }
  return definition.steps.filter(s => s.isEnabled);
}

export async function setStepEnabled(
  stepId: string,
  isEnabled: boolean,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    // Disabling every step would leave an application with no way forward.
    if (!isEnabled) {
      const remaining = await client.query<{ count: string }>(
        `select count(*) as count
           from workflow_step
          where definition_id = (select definition_id from workflow_step where id = $1)
            and is_enabled and id <> $1`,
        [stepId]
      );
      if (Number(remaining.rows[0]?.count ?? 0) === 0) {
        throw new ConfigError(
          'This is the last enabled step. A workflow with no steps could ' +
            'never complete.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      'update workflow_step set is_enabled = $2 where id = $1',
      [stepId, isEnabled]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStepRole(
  stepId: string,
  roleId: string,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const role = await client.query('select 1 from role where id = $1', [
      roleId,
    ]);
    if (role.rowCount === 0) {
      throw new ConfigError('That role no longer exists.', 'not_found');
    }
    const result = await client.query(
      'update workflow_step set role_id = $2 where id = $1',
      [stepId, roleId]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStepQuorum(
  stepId: string,
  quorumCount: number,
  actor: Actor
): Promise<void> {
  if (!Number.isInteger(quorumCount) || quorumCount < 1) {
    throw new ConfigError('A quorum must be a whole number of at least one.');
  }
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'update workflow_step set quorum_count = $2 where id = $1',
      [stepId, quorumCount]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That step no longer exists.', 'not_found');
    }
  });
}

export async function setStatusActive(
  statusId: string,
  isActive: boolean,
  actor: Actor
): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    // A status a step transitions into cannot be switched off, or the chain
    // would move a record into a state the configuration says does not exist.
    if (!isActive) {
      const inUse = await client.query<{ name: string }>(
        `select s.name
           from workflow_step s
           join workflow_status st
             on st.code in (s.from_status, s.to_status)
            and st.entity_type = (select entity_type from workflow_definition
                                   where id = s.definition_id)
          where st.id = $1 and s.is_enabled
          limit 1`,
        [statusId]
      );
      if (inUse.rowCount) {
        throw new ConfigError(
          `The step "${inUse.rows[0].name}" uses this status. Disable that ` +
            'step first.',
          'conflict'
        );
      }
    }

    const result = await client.query(
      'update workflow_status set is_active = $2 where id = $1',
      [statusId, isActive]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That status no longer exists.', 'not_found');
    }
  });
}
