// Configuration export and import (officer request).
//
// One workbook, a sheet per area of configuration: the settings, document
// types and checklists, fee schedules and the fees in force, membership
// types and their fields, account types and who may hold them, payment
// methods, bank accounts, the workflows and approval rules, notification
// wording and retention periods. "Configuration" here is exactly the set of
// tables carrying the configuration-audit trigger (0010 onwards) plus the
// settings table (0003) — reference data an administrator changes without a
// release, never members, money or documents.
//
// A row is identified by its natural key — a code, or the codes of what it
// belongs to — never by its database id, and a reference to another row is
// that row's code. Ids differ between environments; codes do not, so a file
// exported from one database imports into another.
//
// Import adds and changes rows. It never deletes one: configuration rows are
// referenced by applications, accounts and transactions, and a row missing
// from a file is far more often a trimmed file than an intent to delete.
// The whole file is read and checked first, then applied in one transaction
// under the importer's name, so every change reaches the audit trail through
// the same trigger an edit on screen does; one problem and nothing changes.
// A check applies the same way and rolls back, so what it reports is what an
// import would do.
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { recordAudit } from '../access/audit';
import { query, withConfigurationActor } from '../db/pool';
import { FEE_COMPONENTS, maskAccountNumber } from './reference';
import {
  MAXIMUM_PERIOD_MONTHS,
  MINIMUM_PERIOD_MONTHS,
} from '../retention/policy';

type ColumnType = 'text' | 'int' | 'number' | 'bool' | 'json' | 'date';

interface ColumnSpec {
  header: string;
  column: string;
  type: ColumnType;
  // An empty cell is null rather than ''.
  nullable?: boolean;
  // Part of the row's identity: matched, never changed.
  key?: boolean;
  // Shown for reference, never written.
  readOnly?: boolean;
  // A reference to another row, written in the file as that row's code.
  ref?: string;
}

interface SheetSpec {
  sheet: string;
  table: string;
  columns: ColumnSpec[];
  order: string;
  // Needed, beyond config.manage, to change anything on this sheet.
  permission?: string;
  // A rule the table's own constraints do not carry: what the row's page
  // refuses on screen, refused here too.
  check?: (values: Record<string, unknown>) => string | null;
}

const code = (header = 'Code'): ColumnSpec => ({
  header,
  column: 'code',
  type: 'text',
  key: true,
});

// In dependency order: a sheet only refers to sheets above it (and, for a
// membership type's transition at majority, to its own).
const SHEETS: SheetSpec[] = [
  {
    sheet: 'Document types',
    table: 'document_type',
    order: 'code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      { header: 'Tracks expiry', column: 'tracks_expiry', type: 'bool' },
      { header: 'Active', column: 'is_active', type: 'bool' },
    ],
  },
  {
    sheet: 'Checklists',
    table: 'document_checklist',
    order: 'code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      { header: 'Active', column: 'is_active', type: 'bool' },
    ],
  },
  {
    sheet: 'Checklist items',
    table: 'document_checklist_item',
    order: '1, sort_order, 2, 3',
    columns: [
      {
        header: 'Checklist',
        column: 'checklist_id',
        type: 'text',
        key: true,
        ref: 'document_checklist',
      },
      {
        header: 'Document type',
        column: 'document_type_id',
        type: 'text',
        key: true,
        ref: 'document_type',
      },
      { header: 'Subject', column: 'subject', type: 'text', key: true },
      { header: 'Requirement', column: 'requirement', type: 'text' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Fee schedules',
    table: 'fee_schedule',
    order: 'code',
    permission: 'fee.manage',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      { header: 'Active', column: 'is_active', type: 'bool' },
    ],
  },
  // 'Fees' sits here: see FEES below.
  {
    sheet: 'Membership types',
    table: 'membership_type',
    order: 'sort_order, code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      {
        header: 'Checklist',
        column: 'checklist_id',
        type: 'text',
        nullable: true,
        ref: 'document_checklist',
      },
      {
        header: 'Non-member checklist',
        column: 'non_member_checklist_id',
        type: 'text',
        nullable: true,
        ref: 'document_checklist',
      },
      {
        header: 'Fee schedule',
        column: 'fee_schedule_id',
        type: 'text',
        nullable: true,
        ref: 'fee_schedule',
      },
      { header: 'Nominees', column: 'nominee_count', type: 'int' },
      {
        header: 'Majority age',
        column: 'majority_age',
        type: 'int',
        nullable: true,
      },
      {
        header: 'Becomes at majority',
        column: 'majority_transition_type_id',
        type: 'text',
        nullable: true,
        ref: 'membership_type',
      },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Membership fields',
    table: 'membership_type_field',
    order: '1, subject, sort_order, field_key',
    columns: [
      {
        header: 'Membership type',
        column: 'membership_type_id',
        type: 'text',
        key: true,
        ref: 'membership_type',
      },
      { header: 'Subject', column: 'subject', type: 'text', key: true },
      { header: 'Field', column: 'field_key', type: 'text', key: true },
      { header: 'Label', column: 'label', type: 'text' },
      { header: 'Data type', column: 'data_type', type: 'text' },
      { header: 'Choices', column: 'choices', type: 'json' },
      { header: 'Visible', column: 'is_visible', type: 'bool' },
      { header: 'Mandatory', column: 'is_mandatory', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Account types',
    table: 'account_type',
    order: 'sort_order, code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Category', column: 'category', type: 'text' },
      {
        header: 'Number prefix',
        column: 'number_prefix',
        type: 'text',
        nullable: true,
      },
      {
        header: 'Minimum opening amount',
        column: 'minimum_opening_amount',
        type: 'number',
      },
      { header: 'Minimum balance', column: 'minimum_balance', type: 'number' },
      {
        header: 'Maximum transaction amount',
        column: 'maximum_transaction_amount',
        type: 'number',
        nullable: true,
      },
      {
        header: 'Checklist',
        column: 'checklist_id',
        type: 'text',
        nullable: true,
        ref: 'document_checklist',
      },
      {
        header: 'Requires approval',
        column: 'requires_approval',
        type: 'bool',
      },
      { header: 'Default status', column: 'default_status', type: 'text' },
      {
        header: 'Opened with membership',
        column: 'is_membership_default',
        type: 'bool',
      },
      { header: 'Allows deposit', column: 'allows_deposit', type: 'bool' },
      {
        header: 'Allows withdrawal',
        column: 'allows_withdrawal',
        type: 'bool',
      },
      { header: 'Allows transfer', column: 'allows_transfer', type: 'bool' },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Account eligibility',
    table: 'account_type_membership_type',
    order: '1, 2',
    columns: [
      {
        header: 'Account type',
        column: 'account_type_id',
        type: 'text',
        key: true,
        ref: 'account_type',
      },
      {
        header: 'Membership type',
        column: 'membership_type_id',
        type: 'text',
        key: true,
        ref: 'membership_type',
      },
    ],
  },
  {
    sheet: 'Payment methods',
    table: 'payment_method',
    order: 'sort_order, code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Cash', column: 'is_cash', type: 'bool' },
      {
        header: 'Needs a reference',
        column: 'requires_reference',
        type: 'bool',
      },
      { header: 'Touches a bank', column: 'touches_bank', type: 'bool' },
      { header: 'System', column: 'is_system', type: 'bool', readOnly: true },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Bank accounts',
    table: 'bank_account',
    order: 'sort_order, code',
    permission: 'bank_account.manage',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Bank', column: 'bank_name', type: 'text' },
      { header: 'Account number', column: 'account_number', type: 'text' },
      { header: 'Currency', column: 'currency', type: 'text' },
      { header: 'Opening balance', column: 'opening_balance', type: 'number' },
      { header: 'Opening date', column: 'opening_date', type: 'date' },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Workflow statuses',
    table: 'workflow_status',
    order: 'entity_type, sort_order, code',
    columns: [
      { header: 'Entity', column: 'entity_type', type: 'text', key: true },
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      { header: 'Terminal', column: 'is_terminal', type: 'bool' },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Workflows',
    table: 'workflow_definition',
    order: 'code',
    columns: [
      code(),
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      { header: 'Entity', column: 'entity_type', type: 'text' },
      { header: 'Active', column: 'is_active', type: 'bool' },
    ],
  },
  {
    sheet: 'Workflow steps',
    table: 'workflow_step',
    order: '1, step_no',
    columns: [
      {
        header: 'Workflow',
        column: 'definition_id',
        type: 'text',
        key: true,
        ref: 'workflow_definition',
      },
      code('Step'),
      { header: 'Step number', column: 'step_no', type: 'int' },
      { header: 'Name', column: 'name', type: 'text' },
      { header: 'Role', column: 'role_id', type: 'text', ref: 'role' },
      { header: 'From status', column: 'from_status', type: 'text' },
      { header: 'To status', column: 'to_status', type: 'text' },
      { header: 'Enabled', column: 'is_enabled', type: 'bool' },
      { header: 'Quorum', column: 'quorum_count', type: 'int' },
    ],
  },
  {
    sheet: 'Approval rules',
    table: 'approval_rule',
    order: 'kind, sort_order, amount_from',
    columns: [
      { header: 'Kind', column: 'kind', type: 'text', key: true },
      {
        header: 'Account type',
        column: 'account_type_id',
        type: 'text',
        nullable: true,
        key: true,
        ref: 'account_type',
      },
      {
        header: 'Recorded by role',
        column: 'initiating_role_id',
        type: 'text',
        nullable: true,
        key: true,
        ref: 'role',
      },
      {
        header: 'Amount from',
        column: 'amount_from',
        type: 'number',
        key: true,
      },
      {
        header: 'Amount to',
        column: 'amount_to',
        type: 'number',
        nullable: true,
      },
      {
        header: 'Workflow',
        column: 'workflow_definition_id',
        type: 'text',
        nullable: true,
        ref: 'workflow_definition',
      },
      { header: 'Note', column: 'note', type: 'text' },
      { header: 'Active', column: 'is_active', type: 'bool' },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
  {
    sheet: 'Notifications',
    table: 'notification_template',
    order: 'event_code, channel',
    columns: [
      { header: 'Event', column: 'event_code', type: 'text', key: true },
      { header: 'Channel', column: 'channel', type: 'text', key: true },
      { header: 'Subject', column: 'subject', type: 'text', nullable: true },
      { header: 'Body', column: 'body', type: 'text' },
      { header: 'Description', column: 'description', type: 'text' },
      {
        header: 'WhatsApp template',
        column: 'provider_template_name',
        type: 'text',
        nullable: true,
      },
      {
        header: 'WhatsApp language',
        column: 'provider_template_language',
        type: 'text',
      },
      {
        header: 'Attaches the document',
        column: 'attaches_document',
        type: 'bool',
      },
      { header: 'Active', column: 'is_active', type: 'bool' },
    ],
  },
  {
    sheet: 'Retention',
    table: 'retention_policy',
    order: 'sort_order, code',
    permission: 'retention.manage',
    // The one setting that schedules records for destruction: held to the
    // same bounds as the Retention page.
    check: values => {
      const months = values.period_months;
      if (months === null || months === undefined) return null;
      return Number(months) < MINIMUM_PERIOD_MONTHS ||
        Number(months) > MAXIMUM_PERIOD_MONTHS
        ? `Months must be between ${MINIMUM_PERIOD_MONTHS} and ${MAXIMUM_PERIOD_MONTHS}.`
        : null;
    },
    columns: [
      code(),
      { header: 'Label', column: 'label', type: 'text' },
      {
        header: 'Months',
        column: 'period_months',
        type: 'int',
        nullable: true,
      },
      { header: 'Sort order', column: 'sort_order', type: 'int' },
    ],
  },
];

// The fees in force: one row per component of each schedule's current
// version. Amounts are never edited in place (S-207) — a receipt points at
// the version it charged — so a schedule whose rows differ from its current
// version gets a new version, exactly as publishing one on the Fees page
// does.
const FEES = 'Fees';
const FEE_HEADERS = ['Fee schedule', 'Component', 'Amount', 'Requirement'];
const SETTINGS = 'Settings';
const SETTING_HEADERS = ['Key', 'Value', 'Type', 'Description'];

const SHEET_ORDER = [
  SETTINGS,
  ...SHEETS.slice(0, 4).map(s => s.sheet),
  FEES,
  ...SHEETS.slice(4).map(s => s.sheet),
];

export class ConfigImportError extends Error {
  constructor(readonly problems: ImportProblem[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the file.`
    );
    this.name = 'ConfigImportError';
  }
}

export interface ImportProblem {
  sheet: string;
  // The spreadsheet row, as the officer sees it; null for the sheet itself.
  row: number | null;
  message: string;
}

export interface SheetOutcome {
  sheet: string;
  added: number;
  changed: number;
  unchanged: number;
}

export interface ImportOutcome {
  applied: boolean;
  sheets: SheetOutcome[];
}

export interface ExchangePrincipal {
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function selectFor(spec: SheetSpec, alias = 't'): string {
  const parts = spec.columns.map(c => {
    const source = `${alias}.${c.column}`;
    if (c.ref) {
      return `(select r.code from ${c.ref} r where r.id = ${source}) as ${c.column}`;
    }
    if (c.type === 'number' || c.type === 'date') {
      return `${source}::text as ${c.column}`;
    }
    return source;
  });
  return `select ${alias}.id, ${parts.join(', ')} from ${spec.table} ${alias}`;
}

function styleHeader(sheet: ExcelJS.Worksheet, headers: string[]) {
  const row = sheet.getRow(1);
  headers.forEach((header, i) => {
    const cell = row.getCell(i + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD1FAE5' },
    };
    sheet.getColumn(i + 1).width = Math.max(
      14,
      Math.min(40, header.length + 6)
    );
  });
  row.commit();
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function cellFor(type: ColumnType, value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
      return Number(value);
    case 'int':
      return Number(value);
    case 'bool':
      return Boolean(value);
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

export async function exportConfiguration(
  principal: ExchangePrincipal
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Al Barakah MCSL';
  workbook.created = new Date();

  const settings = await query<{
    key: string;
    value: unknown;
    value_type: string;
    description: string;
  }>(
    'select key, value, value_type, description from config_entry order by key'
  );
  const settingsSheet = workbook.addWorksheet(SETTINGS);
  styleHeader(settingsSheet, SETTING_HEADERS);
  settingsSheet.getColumn(2).width = 40;
  settingsSheet.getColumn(4).width = 60;
  for (const s of settings.rows) {
    settingsSheet.addRow([
      s.key,
      settingCell(s.value_type, s.value),
      s.value_type,
      s.description,
    ]);
  }

  // Bank account numbers go out whole only to someone who may change them.
  const bankNumbersWhole = principal.permissions.has('bank_account.manage');
  const bankVisible =
    bankNumbersWhole || principal.permissions.has('bank_account.view');

  for (const name of SHEET_ORDER.slice(1)) {
    if (name === FEES) {
      await exportFees(workbook);
      continue;
    }
    const spec = SHEETS.find(s => s.sheet === name)!;
    if (spec.table === 'bank_account' && !bankVisible) continue;
    const rows = await query<Record<string, unknown>>(
      `${selectFor(spec)} order by ${spec.order}`
    );
    const sheet = workbook.addWorksheet(spec.sheet);
    styleHeader(
      sheet,
      spec.columns.map(c => c.header)
    );
    for (const row of rows.rows) {
      sheet.addRow(
        spec.columns.map(c => {
          let value = row[c.column];
          if (
            c.column === 'account_number' &&
            !bankNumbersWhole &&
            typeof value === 'string'
          ) {
            value = maskAccountNumber(value);
          }
          return cellFor(c.type, value);
        })
      );
    }
    // Codes and account numbers are text: 0001 stays 0001.
    spec.columns.forEach((c, i) => {
      if (c.type === 'text') sheet.getColumn(i + 1).numFmt = '@';
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function settingCell(valueType: string, value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (valueType) {
    case 'number':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    case 'string':
    case 'date':
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

async function exportFees(workbook: ExcelJS.Workbook) {
  const rows = await query<{
    schedule: string;
    code: string;
    amount: string;
    requirement: string;
  }>(
    `select s.code as schedule, c.code, c.amount::text as amount, c.requirement
       from fee_schedule s
       join fee_schedule_version v
         on v.schedule_id = s.id and v.superseded_at is null
       join fee_component c on c.version_id = v.id
      order by s.code, c.sort_order, c.code`
  );
  const sheet = workbook.addWorksheet(FEES);
  styleHeader(sheet, FEE_HEADERS);
  for (const r of rows.rows) {
    sheet.addRow([r.schedule, r.code, Number(r.amount), r.requirement]);
  }
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------
type Cell = ExcelJS.CellValue;

// The text of a cell as typed: not trimmed, since a notification body's
// line breaks and spacing are part of it.
function rawText(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map(p => p.text).join('');
  if ('result' in value) {
    const result = value.result;
    if (result === null || result === undefined) return '';
    if (typeof result === 'object' && !(result instanceof Date)) return '';
    return rawText(result as Cell);
  }
  if ('text' in value) return String((value as { text: unknown }).text ?? '');
  return '';
}

function isBlank(value: Cell): boolean {
  return rawText(value).trim() === '';
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parseCell(type: ColumnType, nullable: boolean, cell: Cell): Parsed {
  const text = rawText(cell);
  if (text.trim() === '') {
    if (nullable) return { ok: true, value: null };
    if (type === 'text' || type === 'json') {
      return { ok: true, value: type === 'json' ? [] : '' };
    }
    return { ok: false, message: 'is empty' };
  }
  switch (type) {
    case 'text':
      return {
        ok: true,
        value: typeof cell === 'number' ? String(cell) : text,
      };
    case 'int': {
      const n = typeof cell === 'number' ? cell : Number(text.trim());
      if (!Number.isInteger(n))
        return { ok: false, message: 'is not a whole number' };
      return { ok: true, value: n };
    }
    case 'number': {
      const n =
        typeof cell === 'number' ? cell : Number(text.trim().replace(/,/g, ''));
      if (!Number.isFinite(n)) return { ok: false, message: 'is not a number' };
      return { ok: true, value: n };
    }
    case 'bool': {
      if (typeof cell === 'boolean') return { ok: true, value: cell };
      const t = text.trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t))
        return { ok: true, value: true };
      if (['false', 'no', 'n', '0'].includes(t))
        return { ok: true, value: false };
      return { ok: false, message: 'is not TRUE or FALSE' };
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, message: 'is not valid JSON' };
      }
    case 'date': {
      if (cell instanceof Date) {
        return { ok: true, value: cell.toISOString().slice(0, 10) };
      }
      const t = text.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) {
        return { ok: false, message: 'is not a date (YYYY-MM-DD)' };
      }
      return { ok: true, value: t };
    }
  }
}

// Keys in a stable order, so {"a":1,"b":2} and {"b":2,"a":1} compare equal.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        k =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function same(type: ColumnType, a: unknown, b: unknown): boolean {
  // An empty text and no text are the same thing to an officer, and an
  // Excel cell keeps a line break as LF whatever it was stored as: a body
  // saved with CRLF would otherwise read as changed on every import.
  const plain = (v: unknown) =>
    typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v;
  if (type === 'text' && (a ?? '') === '' && (b ?? '') === '') return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (type === 'number') return Number(a) === Number(b);
  if (type === 'json') return canonical(a) === canonical(b);
  return plain(a) === plain(b);
}

interface SheetRows {
  // Column header (lower-cased) → value, per spreadsheet row.
  rows: { rowNumber: number; cells: Map<string, Cell> }[];
  headers: string[];
}

function readSheet(sheet: ExcelJS.Worksheet): SheetRows {
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = rawText(cell.value).trim();
  });
  const rows: SheetRows['rows'] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = new Map<string, Cell>();
    let any = false;
    headers.forEach((header, i) => {
      if (!header) return;
      const value = row.getCell(i + 1).value;
      if (!isBlank(value)) any = true;
      cells.set(header.toLowerCase(), value);
    });
    if (any) rows.push({ rowNumber, cells });
  });
  return { rows, headers: headers.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
class CheckOnly extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super('check only');
  }
}

export async function importConfiguration(
  buffer: Buffer,
  principal: ExchangePrincipal,
  options: { apply: boolean }
): Promise<ImportOutcome> {
  if (!principal.permissions.has('config.manage')) {
    throw new ConfigImportError([
      {
        sheet: '',
        row: null,
        message: 'You may not change the configuration.',
      },
    ]);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ConfigImportError([
      {
        sheet: '',
        row: null,
        message: 'That file could not be read as an Excel workbook.',
      },
    ]);
  }

  const problems: ImportProblem[] = [];
  const sheets = new Map<string, SheetRows>();
  workbook.eachSheet(ws => {
    const known = SHEET_ORDER.find(
      n => n.toLowerCase() === ws.name.trim().toLowerCase()
    );
    if (!known) {
      problems.push({
        sheet: ws.name,
        row: null,
        message: 'Not a configuration sheet. Rename or remove it.',
      });
      return;
    }
    sheets.set(known, readSheet(ws));
  });
  if (sheets.size === 0 && problems.length === 0) {
    problems.push({
      sheet: '',
      row: null,
      message: 'The file has no configuration sheets.',
    });
  }
  if (problems.length) throw new ConfigImportError(problems);

  const actorDescription = `${principal.email} (configuration import)`;
  try {
    return await withConfigurationActor(
      { userId: principal.userId, description: actorDescription },
      async client => {
        const outcome: ImportOutcome = { applied: options.apply, sheets: [] };
        for (const name of SHEET_ORDER) {
          const rows = sheets.get(name);
          if (!rows) continue;
          let result: SheetOutcome;
          if (name === SETTINGS) {
            result = await importSettings(client, rows, principal, problems);
          } else if (name === FEES) {
            result = await importFees(client, rows, principal, problems);
          } else {
            const spec = SHEETS.find(s => s.sheet === name)!;
            result = await importSheet(client, spec, rows, principal, problems);
          }
          outcome.sheets.push(result);
        }
        if (problems.length) throw new ConfigImportError(problems);
        if (!options.apply) throw new CheckOnly(outcome);
        await recordAudit(
          {
            actorUserId: principal.userId,
            actorDescription: principal.email,
            action: 'config.import',
            entityType: 'configuration',
            entityId: 'workbook',
            newValue: outcome.sheets,
          },
          client
        );
        return outcome;
      }
    );
  } catch (error) {
    if (error instanceof CheckOnly) return error.outcome;
    throw error;
  }
}

// Postgres' own words for a refused write, in the officer's.
function dbProblem(error: unknown): string {
  const e = error as { code?: string; constraint?: string; column?: string };
  switch (e.code) {
    case '23514':
      return `a value is not one this field accepts (${e.constraint ?? 'check'})`;
    case '23505':
      return 'it would duplicate a row already there';
    case '23502':
      return `${e.column ?? 'a required column'} is empty`;
    case '23503':
      return 'it refers to something that does not exist';
    case '22P02':
    case '22003':
      return 'a value is not in the right form';
    default:
      return error instanceof Error ? error.message : 'the database refused it';
  }
}

async function withSavepoint<T>(
  client: pg.PoolClient,
  fn: () => Promise<T>
): Promise<T> {
  await client.query('savepoint config_row');
  try {
    const result = await fn();
    await client.query('release savepoint config_row');
    return result;
  } catch (error) {
    await client.query('rollback to savepoint config_row');
    throw error;
  }
}

async function idForCode(
  client: pg.PoolClient,
  table: string,
  codeValue: string
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `select id from ${table} where code = $1`,
    [codeValue]
  );
  return found.rows[0]?.id ?? null;
}

async function importSheet(
  client: pg.PoolClient,
  spec: SheetSpec,
  data: SheetRows,
  principal: ExchangePrincipal,
  problems: ImportProblem[]
): Promise<SheetOutcome> {
  const outcome: SheetOutcome = {
    sheet: spec.sheet,
    added: 0,
    changed: 0,
    unchanged: 0,
  };
  const byHeader = new Map(spec.columns.map(c => [c.header.toLowerCase(), c]));
  const present = new Set<string>();
  for (const header of data.headers) {
    const column = byHeader.get(header.toLowerCase());
    if (!column) {
      problems.push({
        sheet: spec.sheet,
        row: 1,
        message: `No column called "${header}".`,
      });
      continue;
    }
    present.add(column.column);
  }
  for (const c of spec.columns.filter(c => c.key)) {
    if (!present.has(c.column)) {
      problems.push({
        sheet: spec.sheet,
        row: 1,
        message: `The "${c.header}" column is missing.`,
      });
    }
  }
  if (problems.some(p => p.sheet === spec.sheet)) return outcome;

  const writable = spec.columns.filter(
    c => present.has(c.column) && !c.readOnly && !c.key
  );
  const keys = spec.columns.filter(c => c.key);
  // A reference to a row of this same sheet waits until every row is in.
  const deferred = writable.filter(c => c.ref === spec.table);
  const later: {
    id: string;
    values: Record<string, unknown>;
    rowNumber: number;
    // Counted here only if the self-reference is its one change.
    countHere: boolean;
  }[] = [];
  const seen = new Set<string>();
  const may = !spec.permission || principal.permissions.has(spec.permission);
  const immediate = writable.filter(c => !deferred.includes(c));

  for (const { rowNumber, cells } of data.rows) {
    const values: Record<string, unknown> = {};
    let bad = false;
    for (const c of spec.columns) {
      if (!present.has(c.column) || c.readOnly) continue;
      const parsed = parseCell(
        c.ref ? 'text' : c.type,
        Boolean(c.nullable),
        cells.get(c.header.toLowerCase()) ?? null
      );
      if (!parsed.ok) {
        problems.push({
          sheet: spec.sheet,
          row: rowNumber,
          message: `${c.header} ${parsed.message}.`,
        });
        bad = true;
        continue;
      }
      let value = parsed.value;
      if ((c.key || c.ref) && typeof value === 'string') value = value.trim();
      if (c.ref && value !== null && c.ref !== spec.table) {
        const id = await idForCode(client, c.ref, String(value));
        if (!id) {
          problems.push({
            sheet: spec.sheet,
            row: rowNumber,
            message: `${c.header} "${String(value)}" does not exist.`,
          });
          bad = true;
          continue;
        }
        value = id;
      }
      values[c.column] = value;
    }
    if (bad) continue;
    const refused = spec.check?.(values);
    if (refused) {
      problems.push({ sheet: spec.sheet, row: rowNumber, message: refused });
      continue;
    }

    const identity = keys
      .map(k => String(values[k.column] ?? ''))
      .join('\u0000');
    if (seen.has(identity)) {
      problems.push({
        sheet: spec.sheet,
        row: rowNumber,
        message: 'This row appears twice in the sheet.',
      });
      continue;
    }
    seen.add(identity);

    const existing = await client.query<Record<string, unknown>>(
      `${selectFor({ ...spec, columns: spec.columns.map(c => ({ ...c, ref: undefined })) })}
        where ${keys.map((k, i) => `t.${k.column} is not distinct from $${i + 1}`).join(' and ')}`,
      keys.map(k => values[k.column])
    );
    const current = existing.rows[0];

    try {
      if (current) {
        const changes = immediate.filter(c => {
          const value = values[c.column];
          // A masked account number (an export without bank_account.manage)
          // leaves the number on file as it is.
          if (
            c.column === 'account_number' &&
            typeof value === 'string' &&
            value.includes('•')
          ) {
            return false;
          }
          return !same(c.type, current[c.column], value);
        });
        if (changes.length && !may) {
          problems.push({
            sheet: spec.sheet,
            row: rowNumber,
            message: 'You may not change this.',
          });
          continue;
        }
        if (changes.length) {
          await withSavepoint(client, () =>
            client.query(
              `update ${spec.table}
                  set ${changes.map((c, i) => `${c.column} = $${i + 2}`).join(', ')}
                where id = $1`,
              [current.id, ...changes.map(c => dbValue(c, values[c.column]))]
            )
          );
          outcome.changed += 1;
        }
        if (deferred.length) {
          later.push({
            id: String(current.id),
            values,
            rowNumber,
            countHere: changes.length === 0,
          });
        } else if (changes.length === 0) {
          outcome.unchanged += 1;
        }
      } else {
        if (!may) {
          problems.push({
            sheet: spec.sheet,
            row: rowNumber,
            message: 'You may not add this.',
          });
          continue;
        }
        const columns = [...keys, ...immediate];
        const inserted = await withSavepoint(client, () =>
          client.query<{ id: string }>(
            `insert into ${spec.table} (${columns.map(c => c.column).join(', ')})
             values (${columns.map((_, i) => `$${i + 1}`).join(', ')})
             returning id`,
            columns.map(c => dbValue(c, values[c.column]))
          )
        );
        outcome.added += 1;
        if (deferred.length) {
          later.push({
            id: inserted.rows[0].id,
            values,
            rowNumber,
            countHere: false,
          });
        }
      }
    } catch (error) {
      problems.push({
        sheet: spec.sheet,
        row: rowNumber,
        message: `Refused: ${dbProblem(error)}.`,
      });
    }
  }

  // References within the sheet, now every row of it is in.
  for (const { id, values, rowNumber, countHere } of later) {
    let changed = false;
    for (const c of deferred) {
      const target =
        values[c.column] === null || values[c.column] === undefined
          ? null
          : await idForCode(client, spec.table, String(values[c.column]));
      if (values[c.column] && !target) {
        problems.push({
          sheet: spec.sheet,
          row: rowNumber,
          message: `${c.header} "${String(values[c.column])}" does not exist.`,
        });
        continue;
      }
      const now = await client.query<{ value: string | null }>(
        `select ${c.column} as value from ${spec.table} where id = $1`,
        [id]
      );
      if ((now.rows[0]?.value ?? null) === target) continue;
      if (!may) {
        problems.push({
          sheet: spec.sheet,
          row: rowNumber,
          message: 'You may not change this.',
        });
        continue;
      }
      try {
        await withSavepoint(client, () =>
          client.query(
            `update ${spec.table} set ${c.column} = $2 where id = $1`,
            [id, target]
          )
        );
        changed = true;
      } catch (error) {
        problems.push({
          sheet: spec.sheet,
          row: rowNumber,
          message: `Refused: ${dbProblem(error)}.`,
        });
      }
    }
    if (countHere) {
      if (changed) outcome.changed += 1;
      else outcome.unchanged += 1;
    }
  }
  return outcome;
}

function dbValue(column: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.type === 'json') return JSON.stringify(value);
  if (column.type === 'number') return String(value);
  return value;
}

async function importSettings(
  client: pg.PoolClient,
  data: SheetRows,
  principal: ExchangePrincipal,
  problems: ImportProblem[]
): Promise<SheetOutcome> {
  const outcome: SheetOutcome = {
    sheet: SETTINGS,
    added: 0,
    changed: 0,
    unchanged: 0,
  };
  const headers = new Set(data.headers.map(h => h.toLowerCase()));
  for (const h of data.headers) {
    if (!SETTING_HEADERS.some(s => s.toLowerCase() === h.toLowerCase())) {
      problems.push({
        sheet: SETTINGS,
        row: 1,
        message: `No column called "${h}".`,
      });
    }
  }
  if (!headers.has('key') || !headers.has('value')) {
    problems.push({
      sheet: SETTINGS,
      row: 1,
      message: 'The "Key" and "Value" columns are needed.',
    });
    return outcome;
  }
  const current = await client.query<{
    key: string;
    value: unknown;
    value_type: string;
  }>('select key, value, value_type from config_entry');
  const byKey = new Map(current.rows.map(r => [r.key, r]));
  for (const { rowNumber, cells } of data.rows) {
    const key = rawText(cells.get('key') ?? null).trim();
    const entry = byKey.get(key);
    if (!entry) {
      problems.push({
        sheet: SETTINGS,
        row: rowNumber,
        message: `"${key}" is not a setting.`,
      });
      continue;
    }
    const cell = cells.get('value') ?? null;
    const type: ColumnType =
      entry.value_type === 'number'
        ? 'number'
        : entry.value_type === 'boolean'
          ? 'bool'
          : entry.value_type === 'json'
            ? 'json'
            : entry.value_type === 'date'
              ? 'date'
              : 'text';
    const parsed = parseCell(type, false, cell);
    if (!parsed.ok) {
      problems.push({
        sheet: SETTINGS,
        row: rowNumber,
        message: `The value of ${key} ${parsed.message}.`,
      });
      continue;
    }
    if (
      same(
        type === 'text' || type === 'date' ? 'text' : type,
        entry.value,
        parsed.value
      )
    ) {
      outcome.unchanged += 1;
      continue;
    }
    await client.query(
      `update config_entry set value = $2::jsonb, updated_by = $3 where key = $1`,
      [key, JSON.stringify(parsed.value), principal.userId]
    );
    outcome.changed += 1;
  }
  return outcome;
}

async function importFees(
  client: pg.PoolClient,
  data: SheetRows,
  principal: ExchangePrincipal,
  problems: ImportProblem[]
): Promise<SheetOutcome> {
  const outcome: SheetOutcome = {
    sheet: FEES,
    added: 0,
    changed: 0,
    unchanged: 0,
  };
  const lower = FEE_HEADERS.map(h => h.toLowerCase());
  for (const h of data.headers) {
    if (!lower.includes(h.toLowerCase())) {
      problems.push({
        sheet: FEES,
        row: 1,
        message: `No column called "${h}".`,
      });
    }
  }
  for (const h of FEE_HEADERS) {
    if (!data.headers.some(x => x.toLowerCase() === h.toLowerCase())) {
      problems.push({
        sheet: FEES,
        row: 1,
        message: `The "${h}" column is missing.`,
      });
    }
  }
  if (problems.some(p => p.sheet === FEES)) return outcome;

  const bySchedule = new Map<
    string,
    { rowNumber: number; code: string; amount: number; requirement: string }[]
  >();
  for (const { rowNumber, cells } of data.rows) {
    const schedule = rawText(cells.get('fee schedule') ?? null).trim();
    const component = rawText(cells.get('component') ?? null).trim();
    const amount = parseCell('number', false, cells.get('amount') ?? null);
    const requirement =
      rawText(cells.get('requirement') ?? null).trim() || 'required';
    if (!schedule || !component) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: 'Fee schedule and Component are needed.',
      });
      continue;
    }
    if (!(FEE_COMPONENTS as readonly string[]).includes(component)) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: `"${component}" is not a fee component.`,
      });
      continue;
    }
    if (!amount.ok) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: `Amount ${amount.message}.`,
      });
      continue;
    }
    const value = amount.value as number;
    if (value < 0) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: 'Amount cannot be negative.',
      });
      continue;
    }
    if (!['required', 'optional', 'not_applicable'].includes(requirement)) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: 'Requirement is required, optional or not_applicable.',
      });
      continue;
    }
    if (requirement === 'required' && value === 0) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: `${component} is required but its amount is zero.`,
      });
      continue;
    }
    const list = bySchedule.get(schedule) ?? [];
    if (list.some(c => c.code === component)) {
      problems.push({
        sheet: FEES,
        row: rowNumber,
        message: `${component} appears twice for ${schedule}.`,
      });
      continue;
    }
    list.push({ rowNumber, code: component, amount: value, requirement });
    bySchedule.set(schedule, list);
  }

  const may = principal.permissions.has('fee.manage');
  for (const [schedule, components] of bySchedule) {
    const scheduleId = await idForCode(client, 'fee_schedule', schedule);
    if (!scheduleId) {
      problems.push({
        sheet: FEES,
        row: components[0].rowNumber,
        message: `Fee schedule "${schedule}" does not exist.`,
      });
      continue;
    }
    const current = await client.query<{
      code: string;
      amount: string;
      requirement: string;
    }>(
      `select c.code, c.amount::text as amount, c.requirement
         from fee_schedule_version v
         join fee_component c on c.version_id = v.id
        where v.schedule_id = $1 and v.superseded_at is null`,
      [scheduleId]
    );
    const unchanged =
      current.rows.length === components.length &&
      components.every(c =>
        current.rows.some(
          r =>
            r.code === c.code &&
            Number(r.amount) === c.amount &&
            r.requirement === c.requirement
        )
      );
    if (unchanged) {
      outcome.unchanged += 1;
      continue;
    }
    if (!may) {
      problems.push({
        sheet: FEES,
        row: components[0].rowNumber,
        message: 'You may not change fees.',
      });
      continue;
    }
    // A new version, as the Fees page publishes one: the live version is
    // closed first, since only one may be un-superseded.
    await client.query(
      `update fee_schedule_version set superseded_at = now()
        where schedule_id = $1 and superseded_at is null`,
      [scheduleId]
    );
    const version = await client.query<{ id: string }>(
      `insert into fee_schedule_version (schedule_id, version_no, created_by)
       values ($1, coalesce((select max(version_no) + 1 from fee_schedule_version
                              where schedule_id = $1), 1), $2)
       returning id`,
      [scheduleId, principal.userId]
    );
    for (const [index, c] of components.entries()) {
      await client.query(
        `insert into fee_component (version_id, code, amount, requirement, sort_order)
         values ($1, $2, $3, $4, $5)`,
        [version.rows[0].id, c.code, String(c.amount), c.requirement, index + 1]
      );
    }
    if (current.rows.length === 0) outcome.added += 1;
    else outcome.changed += 1;
  }
  return outcome;
}

export const CONFIGURATION_SHEETS = SHEET_ORDER;
