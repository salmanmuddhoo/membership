// M7 · Legacy migration (docs/backlog.md): a System Administrator imports
// people straight from the legacy register, from an Excel sheet, with no
// capture, no review, no approval — the whole batch lands approved in one
// step.
//
// A migrated member is created exactly the way an ordinary approval creates
// one: membership_application (status 'approved') + application_party +
// member + accounts, via createMemberFromApplication (members/create.ts),
// reused as-is. A migrated non-member (customer) is created the same way a
// live customer_account application (S-614) would. Every existing page that
// reads either already knows how to show one — legacy_code (migrations
// 0047, 0049) is the only new thing a migrated record carries, kept as a
// searchable cross-reference (S-705).
//
// Third increment (migration 0049): not everyone in the legacy register is
// a Member. Officer direction — a row that names an AB Number is a member
// (an AB Number IS a Shares-and-MSA membership, the two always paired,
// S-309); a row with none, naming only an HSA/Investment-style account of
// its own, is a non-member (customer). Every such account carries its own
// legacy number — a member's own additional account included, an officer
// feedback correction to the second increment, which left it numberless the
// way a live approval's own S-613 account is. Its balance is then mandatory
// wherever its number is given: an account named without knowing what is in
// it is not something to leave for later the way an entirely unmentioned
// account is.
//
// Fourth increment, officer feedback — no new schema: 'guardian' and
// 'nominee' are subjects application_party has taken since migration 0010,
// and uniqueness is an application-level check here, not a database
// constraint (see the NIC/mobile note on validateRows below).
//   - Nominee 1 and Nominee 2 columns, on whatever type configures a
//     `nominee` subject — the same S-602 relaxation the live capture form
//     already gives problemsBlockingSubmission: only the first nominee is
//     ever mandatory, a second is never demanded. Officer feedback: Nominee
//     1 is mandatory for a non-member row exactly the same as a member row
//     — nobody migrated is left with no nominee on file just because they
//     hold no AB Number. Capped at 2 regardless of a type's own configured
//     nomineeCount; a family naming more can still add them from the
//     member's own record afterwards.
//   - Minor is eligible now. A `guardian` subject resolves the same way
//     problemsBlockingSubmission's own S-604 relaxation does (findGuardian,
//     exported from capture.ts) — an existing member, or an Individual
//     application still on its way to becoming one — never something an
//     Excel row invents on its own. The guardian has to already be on file
//     before their minor is: a batch naming both runs once for the
//     guardian, then again for the minor.
//   - NIC, mobile and account number are each unique to one member or
//     non-member, checked against the rest of the batch and against
//     everyone already on file (migrated or not).
//   - Officer feedback, fifth increment: the sheet asks only for the
//     Guardian Member ID now — surname, name, NIC and mobile are pulled
//     straight from the guardian's own record on import rather than
//     retyped (a second place for the same fact to go stale is not
//     something an Excel column should invite). Relationship to the minor
//     has no such source and is left for the member page's own edit
//     affordance. The Takaful beneficiary (subject `beneficiary`) is
//     captured in full, no longer deferred.
//
// Second increment (migration 0048): the member's own AB Number, carried
// unchanged from the legacy register rather than reassigned from the
// sequence; importing the same legacy code a second time updates the record
// on file instead of being refused; S-709's opening balances, recorded as
// one payment against the founding application, method 'migration'.
//
// Deliberately narrower than the full M7 spec still:
//   - Employment Details is left for the member's own record to fill in
//     later — nothing here requires it, the same as a member page already
//     tolerates an empty Employment Details section (and, since PR #123,
//     lets a regional officer add it directly from that page).
//   - Synchronous, not the queued job S-703 describes: an Excel sheet of
//     people is small enough (hundreds of rows, not millions) that a
//     request/response round trip is the simpler, sufficient tool. Re-runs
//     are how "at different stages" works — upload another sheet later for
//     more people, or the same one again to correct a detail or add a
//     balance that was not yet known.
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import ExcelJS from 'exceljs';
import { recordAudit, recordAuditQuietly } from '../access/audit';
import type { Actor } from '../applications/capture';
import {
  findGuardian,
  loadApplication,
  normalise,
} from '../applications/capture';
import {
  createMemberFromApplication,
  createMigratedCustomer,
  openMigrationAccount,
} from '../members/create';
import {
  listAccountTypes,
  listMembershipTypes,
  type AccountType,
  type MembershipType,
  type MembershipTypeField,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';
import { toInternational } from '../applications/phone';
import { MoneyError, fromCents, toCents } from '../payments/money';
import {
  hasMigrationBalance,
  migrationFeeVersionId,
  recordMigrationOpeningBalances,
  type MigrationBalanceLine,
} from '../payments/payments';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  type ReceiptAllocation,
} from '../payments/receipts';

export const PERMISSION_MIGRATE = 'system.migrate_members';
const ACTION_IMPORTED = 'member.migration.imported';
const ACTION_UPDATED = 'member.migration.updated';
const ACTION_CUSTOMER_IMPORTED = 'customer.migration.imported';
const ACTION_CUSTOMER_UPDATED = 'customer.migration.updated';

const LEGACY_CODE_COLUMN = 'Legacy Member Code';
const AB_NUMBER_COLUMN = 'AB Number';
const JOINED_COLUMN = 'Joined Date (optional)';
const SHARES_BALANCE_COLUMN = 'Shares Balance';
const MSA_BALANCE_COLUMN = 'MSA Deposit Balance';
const INSTRUCTIONS_SHEET = 'Instructions';

// How the template marks each column (officer request: what must be filled
// in has to be plain on the sheet itself). The header's fill says which:
// red, always required (also " *"); amber, required in some cases, the
// header's note saying when; grey, optional. Every rule a column carries
// is in its header note.
const REQUIRED_FILL = 'FFF4B6B6';
const CONDITIONAL_FILL = 'FFFFE08A';
const OPTIONAL_FILL = 'FFE5E7EB';

type ColumnKind = 'required' | 'conditional' | 'optional';

interface TemplateColumn {
  header: string;
  kind: ColumnKind;
  note?: string;
  text?: boolean; // keep as typed: no number or date conversion by Excel
  field?: MembershipTypeField; // a choice field gets its dropdown
}

const FILLS: Record<ColumnKind, string> = {
  required: REQUIRED_FILL,
  conditional: CONDITIONAL_FILL,
  optional: OPTIONAL_FILL,
};

const DATE_NOTE = 'Date as YYYY-MM-DD, e.g. 2000-06-15.';
const AMOUNT_NOTE = 'A plain amount, e.g. 1500 or 1500.50.';

function fieldNote(field: MembershipTypeField): string | undefined {
  if (field.dataType === 'date') return DATE_NOTE;
  if (field.subject !== 'applicant') {
    return field.dataType === 'choice' && field.choices.length > 0
      ? `One of: ${field.choices.join(', ')}.`
      : undefined;
  }
  if (field.fieldKey === 'nic') {
    return 'Unique: no two people in this file or on file may share a NIC.';
  }
  if (field.fieldKey === 'mobile') {
    return (
      '8 digits (e.g. 57001234) or with the country code (+230 5700 1234). ' +
      'Unique: no two people may share a mobile.'
    );
  }
  if (field.dataType === 'choice' && field.choices.length > 0) {
    return `One of: ${field.choices.join(', ')}.`;
  }
  return undefined;
}

function fieldColumn(
  field: MembershipTypeField,
  header: string,
  mandatory: boolean
): TemplateColumn {
  return {
    header: header + (mandatory ? ' *' : ''),
    kind: mandatory ? 'required' : 'optional',
    note: fieldNote(field),
    text:
      field.dataType === 'phone' ||
      field.fieldKey === 'nic' ||
      field.dataType === 'text',
    field,
  };
}

// 'AB' followed by digits, case-insensitive on the way in — the exact shape
// next_member_number() (migration 0018) itself generates, "AB" plus however
// many digits the register needs (no re-padding here: what is on the
// member's card is what is stored).
const AB_NUMBER_FORMAT = /^AB\d+$/i;

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly reason: 'forbidden' | 'invalid' = 'invalid'
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

function assertMayMigrate(permissions: ReadonlySet<string>): void {
  if (!permissions.has(PERMISSION_MIGRATE)) {
    throw new MigrationError(
      'You do not have permission to import members.',
      'forbidden'
    );
  }
}

// Fourth increment (docs/backlog.md M7): every active type
// is eligible now, Minor included — a type with a `guardian` subject
// resolves its guardian the same way problemsBlockingSubmission does
// (findGuardian, exported from capture.ts for exactly this): an existing
// member, or an Individual application still on its way to becoming one.
// A minor's guardian is either already on file or a member row of the same
// upload (officer direction: the Individual sheet goes first, then Minor).
// validateRows checks every row that needs no guardian before any that
// does, and returns them in that order, so a batch imports the guardian
// before the minor who names them.
function eligible(type: MembershipType): boolean {
  return type.isActive;
}

export async function eligibleMembershipTypesForMigration(): Promise<
  MembershipType[]
> {
  return (await listMembershipTypes()).filter(eligible);
}

function applicantFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(f => f.subject === 'applicant' && f.isVisible)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// Officer feedback: the migration file carries the applicant's Occupation and
// Employment status — the two Employment Details fields the legacy register
// actually holds — as optional columns, so they need not be filled in one by
// one from the member page afterwards. Employer name and monthly income are
// not migrated: they are not in the register, and there is nothing to import
// into them. Narrowed by field key the same way guardianFields narrows to
// Member ID; label, choices and order still come from configuration, so the
// Employment status dropdown offers exactly what the capture form's own
// <select> does.
const MIGRATED_EMPLOYMENT_FIELD_KEYS = new Set([
  'occupation',
  'employment_status',
]);

function employmentFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(
      f =>
        f.subject === 'employment' &&
        f.isVisible &&
        MIGRATED_EMPLOYMENT_FIELD_KEYS.has(f.fieldKey)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// The migration file's own guardian column — Guardian Member ID, and
// nothing else. Officer feedback: every other guardian detail (surname,
// name, NIC, mobile) is pulled straight from the guardian's own record on
// import (validateRows, via findGuardian) rather than retyped — a second
// place for the same fact to go stale is not something an Excel column
// should invite. Relationship to the minor has no such source (it is not
// on the guardian's own record) and is left for the member page's edit
// affordance to fill in later. A minor has exactly one guardian, ordinal 1.
function guardianFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(
      f => f.subject === 'guardian' && f.isVisible && f.fieldKey === 'member_id'
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// The Takaful beneficiary a Minor's own row carries — every field it
// configures, always ordinal 1 (a minor has exactly one), unlike guardian:
// there is no existing record to pull a beneficiary's own details from, so
// this is typed in full the same as an applicant field is.
function beneficiaryFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(f => f.subject === 'beneficiary' && f.isVisible)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// Up to two Nominee ordinals — same cap as the sheet offers regardless of
// how high a type's own nomineeCount is configured (S-602's own default is
// one, and a family that wants more than two named at migration time can
// still add them afterwards from the member's own record, the same as any
// other applicant-form field left for later).
const MAX_MIGRATED_NOMINEES = 2;

// Officer feedback: a nominee's Telephone and Email are not carried in the
// legacy register, so they are left off the migration file — every other
// nominee field a type configures still appears. Excluded by field key
// (both are 'phone'/'email' typed, but the field KEY is what a type's own
// configuration is stable on) rather than by data type, so a future
// text-typed contact field is unaffected.
const MIGRATED_NOMINEE_EXCLUDED_FIELD_KEYS = new Set(['telephone', 'email']);

function nomineeFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(
      f =>
        f.subject === 'nominee' &&
        f.isVisible &&
        !MIGRATED_NOMINEE_EXCLUDED_FIELD_KEYS.has(f.fieldKey)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function migratedNomineeOrdinals(type: MembershipType): number {
  return Math.min(type.nomineeCount, MAX_MIGRATED_NOMINEES);
}

// A nominee field's own label is already prefixed with what it is a nominee
// *of* ("Nominee surname", "Successor guardian surname" on Minor) — putting
// "Nominee 1 "/"Nominee 2 " in front of that verbatim would read "Nominee 1
// Nominee surname". Stripping a leading "Nominee " (case-insensitive, only
// where the label actually starts with it) keeps the column header short
// without losing a type-specific label like Minor's "Successor guardian".
function nomineeColumnLabel(field: MembershipTypeField): string {
  const stripped = field.label.replace(/^nominee\s+/i, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function nomineeColumnHeader(
  field: MembershipTypeField,
  ordinal: number,
  mandatory: boolean
): string {
  return (
    `Nominee ${ordinal} ${nomineeColumnLabel(field)}` + (mandatory ? ' *' : '')
  );
}

// Every account type beyond Shares and the MSA (both membership-default,
// and always available to a member without being named here — S-309's own
// pairing) — active, and either open to every membership type or explicitly
// eligible for this one (account_type_membership_type, migration 0040), the
// same rule eligibleMembershipTypesForMigration's own capture-form parity
// follows. Used for a non-member row's own account(s) too: a live
// customer_account application does not gate by membership-type eligibility
// at all (openAccountsForCustomerApplication checks only is_active), but
// since both kinds of row share one sheet here, one column set is simpler
// than two, and every type this ever excludes is one a Corporate applicant
// specifically was never offered either way (S-612).
function additionalAccountTypes(
  type: MembershipType,
  accountTypes: AccountType[]
): AccountType[] {
  return accountTypes.filter(
    a =>
      a.isActive &&
      !a.isMembershipDefault &&
      (a.eligibleMembershipTypeIds.length === 0 ||
        a.eligibleMembershipTypeIds.includes(type.id))
  );
}

function extraNumberColumn(accountType: AccountType): string {
  return `${accountType.name} Number`;
}

function extraBalanceColumn(accountType: AccountType): string {
  return `${accountType.name} Balance`;
}

// The template's first sheet: the colour key and the rules that hold on
// every sheet. Kept short — the column notes carry each column's own rule.
function fillInstructions(sheet: ExcelJS.Worksheet, typeNames: string[]) {
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 90;
  const title = sheet.addRow(['Member migration file']);
  title.font = { bold: true, size: 14 };
  sheet.addRow([]);
  const key: [ColumnKind, string, string][] = [
    ['required', 'Red heading, marked *', 'Required on every row.'],
    [
      'conditional',
      'Amber heading',
      'Required in some cases: the heading’s note says when.',
    ],
    ['optional', 'Grey heading', 'Optional.'],
  ];
  sheet.addRow(['Column headings']).font = { bold: true };
  for (const [kind, label, meaning] of key) {
    const row = sheet.addRow([label, meaning]);
    row.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: FILLS[kind] },
    };
  }
  sheet.addRow([]);
  sheet.addRow(['Rules']).font = { bold: true };
  const rules = [
    `One row per person, on the sheet of their membership type: ${typeNames.join(', ')}.`,
    'A member has an AB Number, with Shares Balance and MSA Deposit Balance (0 if none).',
    'A non-member has no AB Number: fill Legacy Member Code and at least one account number with its balance.',
    'Hover over a heading to read its note.',
    'Dates as YYYY-MM-DD. Amounts as plain numbers, e.g. 1500.50.',
    'NIC, mobile, legacy code and account numbers belong to one person only, in this file and on file. A minor may share their guardian’s mobile.',
    'A minor’s guardian must be a member already, or be on the Individual sheet of the same file.',
    'Keep the sheet names and column headings as they are. A sheet or column the template does not have is refused.',
    'Uploading the same Legacy Member Code again updates that person instead of adding them twice.',
  ];
  rules.forEach((rule, index) => {
    const row = sheet.addRow([`${index + 1}.`, rule]);
    row.getCell(2).alignment = { wrapText: true };
  });
}

// One sheet per eligible membership type, its columns exactly the fields
// that type's own capture form asks for — read live, the same as the
// capture form itself, so a field an administrator adds or relabels
// appears here without a code change.
export async function buildImportTemplate(): Promise<Buffer> {
  const [types, accountTypes] = await Promise.all([
    eligibleMembershipTypesForMigration(),
    listAccountTypes(),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Al Barakah MCSL';
  workbook.created = new Date();

  const instructions = workbook.addWorksheet(INSTRUCTIONS_SHEET);

  for (const type of types) {
    const fields = applicantFields(type);
    const employment = employmentFields(type);
    const guardian = guardianFields(type);
    const beneficiary = beneficiaryFields(type);
    const nominees = nomineeFields(type);
    const nomineeOrdinals = migratedNomineeOrdinals(type);
    const extras = additionalAccountTypes(type, accountTypes);
    const sheet = workbook.addWorksheet(type.name.slice(0, 31));

    // Employment Details sit right after the applicant's own fields — the
    // same grouping the member page gives them — and before Nominee.
    const columns: TemplateColumn[] = [
      {
        header: LEGACY_CODE_COLUMN,
        kind: 'conditional',
        note:
          'Required for a non-member (AB Number left blank). ' +
          'Each code once only.',
        text: true,
      },
      {
        header: AB_NUMBER_COLUMN,
        kind: 'conditional',
        note:
          'A member: AB followed by digits, e.g. AB2001. Leave blank for a ' +
          'non-member, who then needs an account number and balance below.',
        text: true,
      },
      { header: JOINED_COLUMN, kind: 'optional', note: DATE_NOTE },
      ...fields.map(f => fieldColumn(f, f.label, f.isMandatory)),
      ...employment.map(f => fieldColumn(f, f.label, f.isMandatory)),
      ...guardian.map(f => ({
        ...fieldColumn(f, f.label, f.isMandatory),
        note:
          "The guardian's AB Number: a member already, or one on the " +
          'Individual sheet of this file.',
        text: true,
      })),
      ...beneficiary.map(f => fieldColumn(f, f.label, f.isMandatory)),
    ];
    for (let ordinal = 1; ordinal <= nomineeOrdinals; ordinal++) {
      for (const field of nominees) {
        // S-602, relaxed on officer feedback: only the first nominee is
        // ever mandatory (problemsBlockingSubmission's own exemption) — a
        // second is there for a family that wants to name one, never
        // demanded.
        const mandatory = ordinal === 1 && field.isMandatory;
        columns.push({
          ...fieldColumn(field, '', false),
          header: nomineeColumnHeader(field, ordinal, mandatory),
          kind: mandatory ? 'required' : 'optional',
        });
      }
    }
    for (const header of [SHARES_BALANCE_COLUMN, MSA_BALANCE_COLUMN]) {
      columns.push({
        header,
        kind: 'conditional',
        note:
          'Required when AB Number is filled; 0 if there is no balance. ' +
          AMOUNT_NOTE,
      });
    }
    for (const extra of extras) {
      const pair =
        `Fill ${extraNumberColumn(extra)} and ${extraBalanceColumn(extra)} ` +
        'together, or leave both blank.';
      columns.push(
        {
          header: extraNumberColumn(extra),
          kind: 'conditional',
          note: `${pair} Each account number once only.`,
          text: true,
        },
        {
          header: extraBalanceColumn(extra),
          kind: 'conditional',
          note: `${pair} ${AMOUNT_NOTE}`,
        }
      );
    }

    sheet.addRow(columns.map(c => c.header));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    columns.forEach((column, index) => {
      const cell = sheet.getCell(1, index + 1);
      cell.font = { bold: true };
      cell.alignment = { wrapText: true, vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: FILLS[column.kind] },
      };
      if (column.note) cell.note = column.note;
      const sheetColumn = sheet.getColumn(index + 1);
      sheetColumn.width = 24;
      if (column.text) sheetColumn.numFmt = '@';
      const field = column.field;
      if (field && field.dataType === 'choice' && field.choices.length > 0) {
        // A choice field gets a dropdown restricted to its configured
        // choices, so a typo cannot even be typed in — the same guarantee
        // the capture form's own <select> already gives.
        for (let row = 2; row <= 500; row++) {
          sheet.getCell(row, index + 1).dataValidation = {
            type: 'list',
            allowBlank: column.kind !== 'required',
            formulae: [`"${field.choices.join(',')}"`],
          };
        }
      }
    });
    sheet.getRow(1).height = 32;
  }

  fillInstructions(
    instructions,
    types.map(t => t.name)
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface ParsedRow {
  sheet: string;
  rowNumber: number;
  legacyCode: string;
  abNumber: string;
  joinedAt: string;
  values: Record<string, string>;
  // The applicant's own Employment Details — Occupation and Employment
  // status only (see employmentFields). Empty object when the type
  // configures neither, and every entry optional. Written to its own
  // 'employment' application_party, the same row the member page's own
  // Employment Details section reads and edits.
  employment: Record<string, string>;
  // Empty object when this type configures no guardian subject (every type
  // but Minor). Always ordinal 1 — a minor has exactly one guardian. Only
  // ever carries 'member_id' — see guardianFields' own comment.
  guardian: Record<string, string>;
  // Same shape as guardian, for the Takaful beneficiary — empty when this
  // type configures no beneficiary subject.
  beneficiary: Record<string, string>;
  // One entry per Nominee ordinal this type's sheet offered (0, 1 or 2 —
  // migratedNomineeOrdinals), in order. Not sparse: ordinal 2 is present
  // (possibly all-blank) whenever the type configures 2+ nominees, matching
  // the always-both-rows-written behaviour importMembers gives it.
  nominees: Record<string, string>[];
  sharesBalance: string;
  msaBalance: string;
  // Both keyed by account_type.id — an entry only where that column was
  // typed into. Kept separate (not paired up) until validateRows, whose job
  // it is to say what an unpaired one means.
  accountNumbers: Record<string, string>;
  accountBalances: Record<string, string>;
}

// Strip the template's own " *" mandatory marker back off a header before
// matching it to a field's label — the template is round-tripped, not
// retyped, so this only ever needs to undo what buildImportTemplate wrote.
function stripMandatoryMarker(header: string): string {
  return header.replace(/\s*\*\s*$/, '').trim();
}

// Day 0 of Excel's date numbering (1899-12-30, which absorbs Excel's own
// 1900 leap-year slip), in milliseconds.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function sheetHasData(sheet: ExcelJS.Worksheet): boolean {
  let found = false;
  sheet.eachRow((row, rowNumber) => {
    if (found || rowNumber === 1) return;
    row.eachCell(cell => {
      if (String(cell.value ?? '').trim() !== '') found = true;
    });
  });
  return found;
}

export async function parseImportFile(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs bundles its own @types/node, whose Buffer generic instantiation
    // does not structurally match this project's — an assertion, not an
    // actual type difference.
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new MigrationError(
      'That file is not an Excel workbook (.xlsx). Fill in the template and upload it as it is saved.'
    );
  }

  const [types, accountTypes] = await Promise.all([
    eligibleMembershipTypesForMigration(),
    listAccountTypes(),
  ]);
  // Matched ignoring case and surrounding spaces (officer QA: a tab retyped
  // as "individual" used to drop its whole sheet without a word). A sheet
  // that matches no type is refused if anything is typed in it, rather
  // than silently skipped; the template's own Instructions sheet and an
  // empty sheet are passed over.
  const sheetKey = (name: string) => name.trim().toLowerCase();
  const byName = new Map(types.map(t => [sheetKey(t.name), t]));
  const problems: string[] = [];

  const rows: ParsedRow[] = [];
  for (const sheet of workbook.worksheets) {
    const type = byName.get(sheetKey(sheet.name));
    if (!type) {
      if (
        sheetKey(sheet.name) !== sheetKey(INSTRUCTIONS_SHEET) &&
        sheetHasData(sheet)
      ) {
        problems.push(
          `Sheet "${sheet.name}" is not one of the template's sheets (` +
            `${types.map(t => t.name).join(', ')}). Move its rows to the ` +
            'right sheet, or delete it.'
        );
      }
      continue;
    }
    const fields = applicantFields(type);
    const byLabel = new Map(
      fields.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
    );
    const employment = employmentFields(type);
    const employmentByLabel = new Map(
      employment.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
    );
    const guardian = guardianFields(type);
    const guardianByLabel = new Map(
      guardian.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
    );
    const beneficiary = beneficiaryFields(type);
    const beneficiaryByLabel = new Map(
      beneficiary.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
    );
    const nominees = nomineeFields(type);
    const nomineeOrdinals = migratedNomineeOrdinals(type);
    const nomineeByHeader = new Map<
      string,
      { ordinal: number; fieldKey: string }
    >();
    for (let ordinal = 1; ordinal <= nomineeOrdinals; ordinal++) {
      for (const field of nominees) {
        nomineeByHeader.set(nomineeColumnHeader(field, ordinal, false), {
          ordinal,
          fieldKey: field.fieldKey,
        });
      }
    }
    const extras = additionalAccountTypes(type, accountTypes);
    const extraNumberByLabel = new Map(
      extras.map(t => [extraNumberColumn(t), t.id])
    );
    const extraBalanceByLabel = new Map(
      extras.map(t => [extraBalanceColumn(t), t.id])
    );

    const headerRow = sheet.getRow(1);
    const columnFieldKeys = new Map<number, string>();
    const employmentColumns = new Map<number, string>();
    const guardianColumns = new Map<number, string>();
    const beneficiaryColumns = new Map<number, string>();
    const nomineeColumns = new Map<
      number,
      { ordinal: number; fieldKey: string }
    >();
    const extraNumberColumns = new Map<number, string>();
    const extraBalanceColumns = new Map<number, string>();
    const unknownColumns = new Map<number, string>();
    let legacyCodeColumn: number | null = null;
    let abNumberColumn: number | null = null;
    let joinedColumn: number | null = null;
    let sharesBalanceColumn: number | null = null;
    let msaBalanceColumn: number | null = null;
    headerRow.eachCell((cell, colNumber) => {
      const header = String(cell.value ?? '').trim();
      const bareHeader = stripMandatoryMarker(header);
      if (bareHeader === LEGACY_CODE_COLUMN) {
        legacyCodeColumn = colNumber;
      } else if (header === AB_NUMBER_COLUMN) {
        abNumberColumn = colNumber;
      } else if (header === JOINED_COLUMN) {
        joinedColumn = colNumber;
      } else if (bareHeader === SHARES_BALANCE_COLUMN) {
        sharesBalanceColumn = colNumber;
      } else if (bareHeader === MSA_BALANCE_COLUMN) {
        msaBalanceColumn = colNumber;
      } else if (extraNumberByLabel.has(header)) {
        extraNumberColumns.set(colNumber, extraNumberByLabel.get(header)!);
      } else if (extraBalanceByLabel.has(header)) {
        extraBalanceColumns.set(colNumber, extraBalanceByLabel.get(header)!);
      } else if (employmentByLabel.has(bareHeader)) {
        employmentColumns.set(colNumber, employmentByLabel.get(bareHeader)!);
      } else if (guardianByLabel.has(bareHeader)) {
        guardianColumns.set(colNumber, guardianByLabel.get(bareHeader)!);
      } else if (beneficiaryByLabel.has(bareHeader)) {
        beneficiaryColumns.set(colNumber, beneficiaryByLabel.get(bareHeader)!);
      } else if (nomineeByHeader.has(bareHeader)) {
        nomineeColumns.set(colNumber, nomineeByHeader.get(bareHeader)!);
      } else {
        const fieldKey = byLabel.get(bareHeader);
        if (fieldKey) columnFieldKeys.set(colNumber, fieldKey);
        else if (header !== '') unknownColumns.set(colNumber, header);
      }
    });
    // A column the template does not have is refused when anything is typed
    // under it: what is in it would otherwise be lost without a word
    // (officer QA). An empty one — a spacer, a note to self — is ignored.
    for (const [colNumber, header] of unknownColumns) {
      let used = false;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1 || used) return;
        const value = row.getCell(colNumber).value;
        if (value !== null && value !== undefined && String(value).trim())
          used = true;
      });
      if (used) {
        problems.push(
          `Sheet "${sheet.name}": column "${header}" is not in the template. ` +
            "Use the template's own column headings, or delete the column."
        );
      }
    }

    const dateColumns = new Set<number>(
      [
        joinedColumn,
        ...[...columnFieldKeys]
          .filter(
            ([, key]) =>
              fields.find(f => f.fieldKey === key)?.dataType === 'date'
          )
          .map(([column]) => column),
      ].filter((c): c is number => c !== null)
    );

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cellText = (colNumber: number | null) => {
        if (colNumber === null) return '';
        const value = row.getCell(colNumber).value;
        if (value === null || value === undefined) return '';
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        // A date column holding a bare number is an Excel date that lost
        // its date formatting (36688 is 15 June 2000): read it as that day.
        if (
          typeof value === 'number' &&
          dateColumns.has(colNumber) &&
          Number.isInteger(value) &&
          value > 0 &&
          value < 2_958_466
        ) {
          return new Date(EXCEL_EPOCH + value * 86_400_000)
            .toISOString()
            .slice(0, 10);
        }
        return objectCellText(value);
      };

      const legacyCode = cellText(legacyCodeColumn);
      const abNumber = cellText(abNumberColumn);
      const values: Record<string, string> = {};
      for (const [colNumber, fieldKey] of columnFieldKeys) {
        values[fieldKey] = cellText(colNumber);
      }
      const employmentValues: Record<string, string> = {};
      for (const [colNumber, fieldKey] of employmentColumns) {
        employmentValues[fieldKey] = cellText(colNumber);
      }
      const guardianValues: Record<string, string> = {};
      for (const [colNumber, fieldKey] of guardianColumns) {
        guardianValues[fieldKey] = cellText(colNumber);
      }
      const beneficiaryValues: Record<string, string> = {};
      for (const [colNumber, fieldKey] of beneficiaryColumns) {
        beneficiaryValues[fieldKey] = cellText(colNumber);
      }
      const nomineeValues: Record<string, string>[] = Array.from(
        { length: nomineeOrdinals },
        () => ({})
      );
      for (const [colNumber, { ordinal, fieldKey }] of nomineeColumns) {
        nomineeValues[ordinal - 1][fieldKey] = cellText(colNumber);
      }
      const accountNumbers: Record<string, string> = {};
      for (const [colNumber, accountTypeId] of extraNumberColumns) {
        const text = cellText(colNumber);
        if (text !== '') accountNumbers[accountTypeId] = text;
      }
      const accountBalances: Record<string, string> = {};
      for (const [colNumber, accountTypeId] of extraBalanceColumns) {
        const text = cellText(colNumber);
        if (text !== '') accountBalances[accountTypeId] = text;
      }
      const sharesBalance = cellText(sharesBalanceColumn);
      const msaBalance = cellText(msaBalanceColumn);

      // A blank row (nothing typed anywhere) is not a record to reject —
      // it is the unused rest of the template, left as it was downloaded.
      const hasContent =
        legacyCode !== '' ||
        abNumber !== '' ||
        Object.values(values).some(v => v !== '') ||
        Object.values(employmentValues).some(v => v !== '') ||
        Object.values(guardianValues).some(v => v !== '') ||
        Object.values(beneficiaryValues).some(v => v !== '') ||
        nomineeValues.some(n => Object.values(n).some(v => v !== '')) ||
        sharesBalance !== '' ||
        msaBalance !== '' ||
        Object.values(accountNumbers).some(v => v !== '') ||
        Object.values(accountBalances).some(v => v !== '');
      if (!hasContent) return;

      rows.push({
        sheet: type.name,
        rowNumber,
        legacyCode,
        abNumber,
        joinedAt: cellText(joinedColumn),
        values,
        employment: employmentValues,
        guardian: guardianValues,
        beneficiary: beneficiaryValues,
        nominees: nomineeValues,
        sharesBalance,
        msaBalance,
        accountNumbers,
        accountBalances,
      });
    });
  }

  if (problems.length > 0) throw new MigrationError(problems.join(' '));
  return rows;
}

export interface RowError {
  sheet: string;
  rowNumber: number;
  legacyCode: string;
  message: string;
}

export interface ValidatedAccountEntry {
  accountTypeId: string;
  accountTypeCode: string;
  accountTypeName: string;
  accountDefaultStatus: string;
  accountNo: string;
  amount: string;
}

export interface ValidatedRow extends Omit<
  ParsedRow,
  'joinedAt' | 'accountNumbers' | 'accountBalances'
> {
  membershipTypeId: string;
  joinedAt: Date | null;
  // A row naming an AB Number is a member (Shares and the MSA, always
  // paired, S-309); one naming none, only an account of its own, is a
  // non-member (customer) — S-614's own distinction, decided here once so
  // nothing downstream has to re-derive it.
  kind: 'member' | 'customer';
  // Already resolved to exactly the new accounts to open — one already on
  // file with a matching number is left out (nothing to do), one already on
  // file with a different number is an error before this row ever reaches
  // here (see validateRows).
  accountEntries: ValidatedAccountEntry[];
  // Set when this row's Legacy Member Code matches a member or customer
  // already on file from an earlier import — importMembers updates that
  // record instead of creating a second one. Always the same kind as `kind`
  // above; validateRows refuses a row that would change which kind a
  // legacy code names.
  existingId: string | null;
  existingApplicationId: string | null;
}

interface ExistingRecord {
  kind: 'member' | 'customer';
  id: string;
  applicationId: string | null;
  // AB number for a member, null for a customer — a customer has none of
  // its own to compare an AB Number against.
  memberNo: string | null;
  // account_type.id -> the account_no already on file for that type, so a
  // re-import naming one already held can be told apart from one naming a
  // genuinely new account.
  accountNos: Map<string, string>;
}

const THOUSANDS_GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

// What a cell that is not a plain value says: a formula's result (a
// Guardian Member ID looked up with VLOOKUP), text with mixed formatting, a
// hyperlink. Officer QA: each of these was read as "[object Object]".
function objectCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value).trim();
  if ('richText' in value) {
    return value.richText
      .map(part => part.text)
      .join('')
      .trim();
  }
  if ('result' in value) {
    const result = value.result;
    if (result === null || result === undefined) return '';
    if (typeof result === 'object' && !(result instanceof Date)) return '';
    return objectCellText(result);
  }
  if ('text' in value) {
    return String((value as { text: unknown }).text ?? '').trim();
  }
  if ('error' in value) return '';
  return '';
}

function mobileMatchKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return toInternational(trimmed).toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

// A date in a migration file: YYYY-MM-DD (what an Excel date cell is read
// as, too), a real calendar day, not before 1900 and not in the future.
// Officer QA: "15/06/2000" and a bare Excel day number like 36688 were
// either refused unhelpfully or read as the year 36688.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseMigrationDate(
  raw: string,
  label: string,
  problems: string[]
): Date | null {
  const match = ISO_DATE.exec(raw.trim());
  const date = match
    ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
    : null;
  if (
    !match ||
    !date ||
    date.getUTCFullYear() !== +match[1] ||
    date.getUTCMonth() !== +match[2] - 1 ||
    date.getUTCDate() !== +match[3]
  ) {
    problems.push(`${label} "${raw}" is not a date; use YYYY-MM-DD.`);
    return null;
  }
  if (date.getUTCFullYear() < 1900 || date.getTime() > Date.now()) {
    problems.push(`${label} ${raw.trim()} is not a possible date.`);
    return null;
  }
  return date;
}

function parseAmount(raw: string, label: string, problems: string[]): string {
  if (raw.trim() === '') return '';
  try {
    // "1,500.00" as a spreadsheet shows it: the commas are only grouping.
    const bare = THOUSANDS_GROUPED.test(raw.trim())
      ? raw.trim().replace(/,/g, '')
      : raw;
    const cents = toCents(bare);
    if (cents < 0) {
      problems.push(`${label} cannot be negative.`);
      return '';
    }
    return fromCents(cents);
  } catch (error) {
    problems.push(
      error instanceof MoneyError
        ? `${label}: ${error.message}`
        : `${label} is not an amount.`
    );
    return '';
  }
}

/**
 * Format and mandatory-field checks, member/non-member classification
 * (S-614), and legacy_code / AB Number / account-number / NIC / mobile
 * uniqueness both against what is already on file and against the rest of
 * this same batch — so two rows claiming the same old code, AB Number,
 * account number, NIC or mobile are caught before either is written, not
 * after one of them already is. NIC and mobile are checked only where a
 * type's own applicant fields configure them (Corporate has no 'nic'); a
 * row updating its own existing record is never flagged against itself.
 *
 * A legacy code already on file is not itself an error: importMembers
 * updates that record instead, provided the row agrees with what is on
 * file — the same kind (member or customer), the same AB Number if it is a
 * member, and the same number for any account type it already holds.
 *
 * A Minor's guardian is resolved against who is already on file the same
 * way problemsBlockingSubmission's own S-604 relaxation does; Nominee 1
 * and Nominee 2 (never mandatory past the first) are format-checked and
 * normalised the same as any applicant field.
 */
export async function validateRows(
  rows: ParsedRow[]
): Promise<{ valid: ValidatedRow[]; errors: RowError[] }> {
  const [types, accountTypes] = await Promise.all([
    eligibleMembershipTypesForMigration(),
    listAccountTypes(),
  ]);
  const byName = new Map(types.map(t => [t.name, t]));

  const errors: RowError[] = [];
  const valid: ValidatedRow[] = [];

  const [
    existingMembers,
    existingCustomers,
    memberAccounts,
    customerAccounts,
    allAccountNos,
    memberApplicantValues,
    customerApplicantValues,
  ] = await Promise.all([
    query<{
      id: string;
      member_no: string;
      application_id: string | null;
      legacy_code: string;
    }>(`select id, member_no, application_id, legacy_code
          from member where legacy_code is not null`),
    query<{
      id: string;
      application_id: string | null;
      legacy_code: string;
    }>(`select id, application_id, legacy_code
          from customer where legacy_code is not null`),
    query<{
      legacy_code: string;
      account_type_id: string;
      account_no: string | null;
    }>(
      `select m.legacy_code, a.account_type_id, a.account_no
         from account a join member m on m.id = a.member_id
        where m.legacy_code is not null`
    ),
    query<{
      legacy_code: string;
      account_type_id: string;
      account_no: string | null;
    }>(
      `select c.legacy_code, a.account_type_id, a.account_no
         from account a join customer c on c.id = a.customer_id
        where c.legacy_code is not null`
    ),
    // Item 6, officer feedback: an account number is unique to a
    // member/non-member system-wide, not only among already-migrated
    // records — unlike memberAccounts/customerAccounts above (which exist
    // to compare a re-import against that same legacy record's own
    // numbers), this is every account_no on file at all, migrated or not.
    query<{ account_no: string | null }>(
      `select account_no from account where account_no is not null`
    ),
    // Item 6: NIC and mobile are unique to a member/non-member, checked
    // against everyone already on file — migrated or approved the ordinary
    // way, this import does not distinguish. A minor's mobile is left out:
    // it is usually their guardian's.
    query<{ id: string; nic: string | null; mobile: string | null }>(
      `select m.id, p.values->>'nic' as nic,
              case when g.id is null then p.values->>'mobile' end as mobile
         from member m
         join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
         left join application_party g
           on g.application_id = m.application_id
          and g.subject = 'guardian' and g.ordinal = 1`
    ),
    query<{ id: string; nic: string | null; mobile: string | null }>(
      `select c.id, p.values->>'nic' as nic,
              case when g.id is null then p.values->>'mobile' end as mobile
         from customer c
         join application_party p
           on p.application_id = c.application_id
          and p.subject = 'applicant' and p.ordinal = 1
         left join application_party g
           on g.application_id = c.application_id
          and g.subject = 'guardian' and g.ordinal = 1`
    ),
  ]);

  const existingByLegacyCode = new Map<string, ExistingRecord>();
  for (const r of existingMembers.rows) {
    existingByLegacyCode.set(r.legacy_code.toLowerCase(), {
      kind: 'member',
      id: r.id,
      applicationId: r.application_id,
      memberNo: r.member_no,
      accountNos: new Map(),
    });
  }
  for (const r of existingCustomers.rows) {
    // A legacy code should never name both a member and a customer — an
    // inconsistency from outside this import, not one to silently pick a
    // side on. Member wins the map slot; the row-level checks below still
    // catch the customer row on its own terms via existingCustomers not
    // being consulted a second time.
    if (!existingByLegacyCode.has(r.legacy_code.toLowerCase())) {
      existingByLegacyCode.set(r.legacy_code.toLowerCase(), {
        kind: 'customer',
        id: r.id,
        applicationId: r.application_id,
        memberNo: null,
        accountNos: new Map(),
      });
    }
  }
  for (const r of [...memberAccounts.rows, ...customerAccounts.rows]) {
    if (!r.account_no) continue;
    const existing = existingByLegacyCode.get(r.legacy_code.toLowerCase());
    existing?.accountNos.set(r.account_type_id, r.account_no);
  }

  const memberNosTaken = new Set(
    existingMembers.rows.map(r => r.member_no.toUpperCase())
  );
  const accountNosTaken = new Set(
    allAccountNos.rows
      .map(r => r.account_no)
      .filter((no): no is string => !!no)
      .map(no => no.toLowerCase())
  );

  // Item 6: keyed by owner (kind + id) so a row updating its own existing
  // record is never flagged as colliding with itself — only a NIC or mobile
  // already on file for someone else is a problem.
  const nicOwner = new Map<
    string,
    { kind: 'member' | 'customer'; id: string }
  >();
  const mobileOwner = new Map<
    string,
    { kind: 'member' | 'customer'; id: string }
  >();
  for (const r of memberApplicantValues.rows) {
    if (r.nic)
      nicOwner.set(r.nic.trim().toLowerCase(), { kind: 'member', id: r.id });
    if (r.mobile) {
      mobileOwner.set(r.mobile.trim().toLowerCase(), {
        kind: 'member',
        id: r.id,
      });
    }
  }
  for (const r of customerApplicantValues.rows) {
    if (r.nic) {
      nicOwner.set(r.nic.trim().toLowerCase(), { kind: 'customer', id: r.id });
    }
    if (r.mobile) {
      mobileOwner.set(r.mobile.trim().toLowerCase(), {
        kind: 'customer',
        id: r.id,
      });
    }
  }

  // Legacy Member Code is optional for a member row — an AB Number is
  // already its own unambiguous, system-recognised reference (it becomes
  // application.reference the same way an ordinary approval's own member_no
  // does), so a member whose legacy code and AB number were always the same
  // in the register needs typing only once. Falls back to the AB Number
  // itself when left blank; never falls back to anything for a non-member
  // row, which has no AB Number to borrow one from. Computed once, up
  // front, so both the occurrence maps below and the main loop use the same
  // effective value.
  function effectiveLegacyCode(row: ParsedRow, abGiven: boolean): string {
    if (row.legacyCode !== '') return row.legacyCode;
    return abGiven ? row.abNumber.trim().toUpperCase() : '';
  }

  // Counted up front so every row sharing a duplicated value is flagged —
  // not just the second one, which would leave the administrator unable to
  // tell which of the two rows on screen is the "original" without
  // cross-referencing the sheet themselves.
  const legacyOccurrences = new Map<string, number>();
  const abOccurrences = new Map<string, number>();
  const accountNoOccurrences = new Map<string, number>();
  const nicOccurrences = new Map<string, number>();
  const mobileOccurrences = new Map<string, number>();
  const needsGuardian = (row: ParsedRow) => {
    const type = byName.get(row.sheet);
    return type ? guardianFields(type).length > 0 : false;
  };
  for (const row of rows) {
    const abGiven = row.abNumber.trim() !== '';
    const legacyCode = effectiveLegacyCode(row, abGiven);
    if (legacyCode !== '') {
      const key = legacyCode.toLowerCase();
      legacyOccurrences.set(key, (legacyOccurrences.get(key) ?? 0) + 1);
    }
    if (abGiven) {
      const key = row.abNumber.trim().toUpperCase();
      abOccurrences.set(key, (abOccurrences.get(key) ?? 0) + 1);
    }
    for (const raw of Object.values(row.accountNumbers)) {
      const key = raw.trim().toLowerCase();
      if (key === '') continue;
      accountNoOccurrences.set(key, (accountNoOccurrences.get(key) ?? 0) + 1);
    }
    // Item 6: same rest-of-batch check as legacy code/AB Number/account
    // number above, on whichever of the applicant fields this type actually
    // configures 'nic' and 'mobile' for (Corporate has no 'nic' field).
    const nicKey = (row.values.nic ?? '').trim().toLowerCase();
    if (nicKey !== '') {
      nicOccurrences.set(nicKey, (nicOccurrences.get(nicKey) ?? 0) + 1);
    }
    // Keyed on the number as it will be stored (+230…), the same form the
    // row-level check below looks it up by: "57001234" and "+230 5700 1234"
    // are the same mobile.
    // A minor's own mobile is usually their guardian's (officer direction),
    // so a minor is not counted here: checked against their guardian below.
    const mobileKey = needsGuardian(row)
      ? ''
      : mobileMatchKey(row.values.mobile ?? '');
    if (mobileKey !== '') {
      mobileOccurrences.set(
        mobileKey,
        (mobileOccurrences.get(mobileKey) ?? 0) + 1
      );
    }
  }

  // Rows that need no guardian first, then those that do, so a minor can
  // name a guardian from the same upload — and the rows come back in that
  // order, which is the order they are imported in.
  const ordered = [
    ...rows.filter(r => !needsGuardian(r)),
    ...rows.filter(r => needsGuardian(r)),
  ];
  // Member rows of this upload that validated, by AB Number: guardians a
  // minor further down may name.
  const membersInUpload = new Map<string, Record<string, string>>();
  // Member rows of this upload that did not validate, by AB Number.
  const membersWithProblems = new Set<string>();

  for (const row of ordered) {
    const problems: string[] = [];
    const type = byName.get(row.sheet);
    if (!type) {
      problems.push(`"${row.sheet}" is not a membership type open for import.`);
      errors.push({ ...row, message: problems.join(' ') });
      continue;
    }

    const abGiven = row.abNumber.trim() !== '';
    const legacyCode = effectiveLegacyCode(row, abGiven);

    if (legacyCode === '') {
      // Only reachable when !abGiven — a member row always has one, taken
      // from the AB Number when the column itself was left blank.
      problems.push(
        `${LEGACY_CODE_COLUMN} is required for a non-member row (there is ` +
          'no AB Number to identify them by instead).'
      );
    } else if ((legacyOccurrences.get(legacyCode.toLowerCase()) ?? 0) > 1) {
      problems.push(
        `${LEGACY_CODE_COLUMN} "${legacyCode}" appears more than once in ` +
          'this sheet.'
      );
    }

    let existing: ExistingRecord | null = null;
    if (legacyCode !== '') {
      existing = existingByLegacyCode.get(legacyCode.toLowerCase()) ?? null;
      if (existing && existing.applicationId === null) {
        problems.push(
          `${LEGACY_CODE_COLUMN} "${legacyCode}" is on file but has no ` +
            'application to update. Ask an administrator to look into it.'
        );
        existing = null;
      }
    }

    let abNumber = '';
    if (abGiven) {
      if (!AB_NUMBER_FORMAT.test(row.abNumber.trim())) {
        problems.push(
          `${AB_NUMBER_COLUMN} "${row.abNumber}" must look like AB2001.`
        );
      } else {
        abNumber = row.abNumber.trim().toUpperCase();
        if ((abOccurrences.get(abNumber) ?? 0) > 1) {
          problems.push(
            `${AB_NUMBER_COLUMN} "${row.abNumber}" appears more than once ` +
              'in this sheet.'
          );
        } else if (existing?.kind === 'customer') {
          problems.push(
            `${LEGACY_CODE_COLUMN} "${legacyCode}" is on file as a ` +
              'non-member. This import cannot turn one into a member; ' +
              'approve a membership application for them instead.'
          );
        } else if (existing?.kind === 'member') {
          if (abNumber !== existing.memberNo!.toUpperCase()) {
            problems.push(
              `${AB_NUMBER_COLUMN} "${row.abNumber}" does not match ` +
                `${existing.memberNo}, which "${legacyCode}" is already ` +
                'on file as. Fix the AB Number, or correct the legacy code ' +
                'if this is a different member.'
            );
          }
        } else if (memberNosTaken.has(abNumber)) {
          problems.push(
            `${AB_NUMBER_COLUMN} "${row.abNumber}" is already on file for a ` +
              'different member.'
          );
        }
      }
    } else if (existing?.kind === 'member') {
      problems.push(
        `${LEGACY_CODE_COLUMN} "${legacyCode}" is on file as a member ` +
          `(${existing.memberNo}). Provide the same AB Number to update ` +
          'them, or a different legacy code for a new non-member record.'
      );
    }

    let joinedAt: Date | null = null;
    if (row.joinedAt !== '') {
      joinedAt = parseMigrationDate(row.joinedAt, 'Joined Date', problems);
    }

    const fields = applicantFields(type);
    const { values, errors: formatErrors } = normalise(row.values, fields);
    for (const error of formatErrors) problems.push(error.label);
    // A date field (Date of birth) is taken as typed by normalise — the
    // capture form's own date picker cannot produce a bad one; a sheet can.
    for (const field of fields) {
      if (field.dataType !== 'date') continue;
      const raw = (row.values[field.fieldKey] ?? '').trim();
      if (raw !== '') parseMigrationDate(raw, field.label, problems);
    }
    for (const field of fields) {
      if (!field.isMandatory) continue;
      if ((values[field.fieldKey] ?? '').trim() === '') {
        problems.push(`${field.label} is required.`);
      }
    }

    // Item 6, officer feedback: NIC and mobile are unique to a
    // member/non-member — checked only on whichever of those two fields
    // this type's own applicant fields actually configure (Corporate has
    // no 'nic'), against the rest of this batch and against everyone
    // already on file. A row updating its own existing record is never
    // flagged against itself.
    const nic = (values.nic ?? '').trim();
    if (nic !== '') {
      const key = nic.toLowerCase();
      const owner = nicOwner.get(key);
      const isSelf =
        !!existing &&
        !!owner &&
        owner.kind === existing.kind &&
        owner.id === existing.id;
      if (owner && !isSelf) {
        problems.push(
          `NIC "${nic}" is already on file for a different member/non-member.`
        );
      } else if ((nicOccurrences.get(key) ?? 0) > 1) {
        problems.push(`NIC "${nic}" appears more than once in this sheet.`);
      }
    }
    // Employment Details (Occupation, Employment status) — the applicant's
    // own, every entry optional, so nothing is ever required and the only
    // check is the format one normalise does: Employment status must be one
    // of its configured choices, the same as the capture form's <select>.
    // A no-op for a type that configures none (Corporate, Minor).
    const employmentTypeFields = employmentFields(type);
    const { values: employmentValues, errors: employmentFormatErrors } =
      normalise(row.employment, employmentTypeFields);
    for (const error of employmentFormatErrors) problems.push(error.label);

    // Guardian (Minor only — every other type configures no 'guardian'
    // subject, so this is a no-op for them). Officer feedback: the sheet
    // asks only for the Guardian Member ID — surname, name, NIC and mobile
    // are pulled straight from the guardian's own record once it resolves
    // (the same S-604 resolution problemsBlockingSubmission itself uses),
    // never retyped. Relationship to the minor has no such source and is
    // left blank, for the member page's own edit affordance to fill in
    // later (it is not on the guardian's own record to pull from).
    const guardianField = guardianFields(type)[0];
    let guardianValues: Record<string, string> = {};
    if (guardianField) {
      const guardianMemberNo = (
        row.guardian[guardianField.fieldKey] ?? ''
      ).trim();
      if (guardianMemberNo === '') {
        problems.push(`${guardianField.label} is required.`);
      } else {
        const found = await findGuardian(guardianMemberNo, '');
        const inUpload = membersInUpload.get(guardianMemberNo.toUpperCase());
        if (!found && inUpload) {
          guardianValues = {
            [guardianField.fieldKey]: guardianMemberNo.toUpperCase(),
            surname: inUpload.surname ?? '',
            name: inUpload.name ?? '',
            nic: inUpload.nic ?? '',
            mobile: inUpload.mobile ?? '',
          };
        } else if (
          !found &&
          membersWithProblems.has(guardianMemberNo.toUpperCase())
        ) {
          problems.push(
            `The guardian ${guardianMemberNo.toUpperCase()} has problems on ` +
              'their own row of this file. Fix that row first.'
          );
        } else if (!found) {
          problems.push(
            `${guardianField.label} "${guardianMemberNo}" does not match ` +
              'any member on file or on the Individual sheet of this file.'
          );
        } else if (found.isMember && found.status !== 'active') {
          problems.push(
            `The guardian (${found.memberNo}) is not an active member.`
          );
        } else {
          guardianValues = {
            [guardianField.fieldKey]: found.memberNo,
            surname: found.applicantValues.surname ?? '',
            name: found.applicantValues.name ?? '',
            nic: found.applicantValues.nic ?? '',
            mobile: found.applicantValues.mobile ?? '',
          };
        }
      }
    }

    // A minor may share their guardian's mobile (officer direction) — and
    // so may brothers and sisters under the same guardian. Any other number
    // must not be an adult's, on file or in this sheet.
    const mobile = (values.mobile ?? '').trim();
    const guardianMobile = mobileMatchKey(guardianValues.mobile ?? '');
    const sharesGuardianMobile =
      !!guardianField &&
      guardianMobile !== '' &&
      mobileMatchKey(mobile) === guardianMobile;
    if (mobile !== '' && !sharesGuardianMobile) {
      const key = mobile.toLowerCase();
      const owner = mobileOwner.get(key);
      const isSelf =
        !!existing &&
        !!owner &&
        owner.kind === existing.kind &&
        owner.id === existing.id;
      if (owner && !isSelf) {
        problems.push(
          `Mobile "${row.values.mobile}" is already on file for a different ` +
            'member/non-member.'
        );
      } else if (
        (mobileOccurrences.get(mobileMatchKey(mobile)) ?? 0) >
        (guardianField ? 0 : 1)
      ) {
        problems.push(
          `Mobile "${row.values.mobile}" appears more than once in this sheet.`
        );
      }
    }

    // Takaful beneficiary (Minor only). Its own person, not on file
    // anywhere else — typed in full, the same as an applicant field, and
    // always mandatory where configured (no ordinal exemption; a minor has
    // exactly one).
    const beneficiaryTypeFields = beneficiaryFields(type);
    let beneficiaryValues: Record<string, string> = {};
    if (beneficiaryTypeFields.length > 0) {
      const { values: normalisedBeneficiary, errors: beneficiaryFormatErrors } =
        normalise(row.beneficiary, beneficiaryTypeFields);
      beneficiaryValues = normalisedBeneficiary;
      for (const error of beneficiaryFormatErrors) problems.push(error.label);
      for (const field of beneficiaryTypeFields) {
        if (!field.isMandatory) continue;
        if ((beneficiaryValues[field.fieldKey] ?? '').trim() === '') {
          problems.push(`${field.label} is required.`);
        }
      }
    }

    // Nominees — up to Nominee 1 (mandatory where the type's own nominee
    // fields are — member and non-member alike, officer feedback) and
    // Nominee 2 (never mandatory, S-602 relaxed the same way
    // problemsBlockingSubmission's own capture-form check already is).
    const nomineeTypeFields = nomineeFields(type);
    const nomineeOrdinalCount = migratedNomineeOrdinals(type);
    const nominees: Record<string, string>[] = [];
    if (nomineeOrdinalCount > 0) {
      for (let ordinal = 1; ordinal <= nomineeOrdinalCount; ordinal++) {
        const raw = row.nominees[ordinal - 1] ?? {};
        const { values: normalisedNominee, errors: nomineeFormatErrors } =
          normalise(raw, nomineeTypeFields);
        for (const error of nomineeFormatErrors) problems.push(error.label);
        if (ordinal === 1) {
          for (const field of nomineeTypeFields) {
            if (!field.isMandatory) continue;
            if ((normalisedNominee[field.fieldKey] ?? '').trim() === '') {
              problems.push(`${field.label} is required.`);
            }
          }
        }
        nominees.push(normalisedNominee);
      }
    }

    const sharesBalance = parseAmount(
      row.sharesBalance,
      'Shares Balance',
      problems
    );
    const msaBalance = parseAmount(
      row.msaBalance,
      'MSA Deposit Balance',
      problems
    );
    // Officer direction: a member's two balances are part of what the old
    // register says about them, so a row naming an AB Number states both —
    // 0 where there is nothing — rather than leaving either to be guessed.
    if (abGiven) {
      if (row.sharesBalance.trim() === '') {
        problems.push(
          'Shares Balance is required with an AB Number (0 if none).'
        );
      }
      if (row.msaBalance.trim() === '') {
        problems.push(
          'MSA Deposit Balance is required with an AB Number (0 if none).'
        );
      }
    }
    if (!abGiven && (sharesBalance !== '' || msaBalance !== '')) {
      problems.push(
        'Shares Balance and MSA Deposit Balance need an AB Number — only ' +
          'a member holds Shares or an MSA.'
      );
    }

    const accountEntries: ValidatedAccountEntry[] = [];
    let anyAccountGiven = false;
    for (const extraType of additionalAccountTypes(type, accountTypes)) {
      const rawNumber = (row.accountNumbers[extraType.id] ?? '').trim();
      const rawBalance = (row.accountBalances[extraType.id] ?? '').trim();
      if (rawNumber === '' && rawBalance === '') continue;
      anyAccountGiven = true;

      if (rawNumber === '') {
        problems.push(
          `${extraType.name} Number is required to record a ` +
            `${extraType.name} Balance.`
        );
        continue;
      }
      if (rawBalance === '') {
        problems.push(
          `${extraType.name} Balance is required for the ${extraType.name} ` +
            `account ${rawNumber}.`
        );
        continue;
      }

      const amount = parseAmount(
        rawBalance,
        `${extraType.name} Balance`,
        problems
      );
      if (amount === '') continue; // parseAmount already recorded why.

      const onFile = existing?.accountNos.get(extraType.id);
      if (onFile !== undefined) {
        if (onFile.toLowerCase() !== rawNumber.toLowerCase()) {
          problems.push(
            `${extraType.name} Number "${rawNumber}" does not match ${onFile}, ` +
              `which "${legacyCode}" already holds. Fix the number, or ` +
              'this may be a different account than the one on file.'
          );
        }
        // Matches what is on file — nothing new to write, the same reason
        // an already-held Shares/MSA balance is never re-recorded either.
        continue;
      }

      const key = rawNumber.toLowerCase();
      if ((accountNoOccurrences.get(key) ?? 0) > 1) {
        problems.push(
          `${extraType.name} Number "${rawNumber}" appears more than once ` +
            'in this sheet.'
        );
      } else if (accountNosTaken.has(key)) {
        problems.push(
          `${extraType.name} Number "${rawNumber}" is already on file for ` +
            'a different account.'
        );
      } else {
        accountEntries.push({
          accountTypeId: extraType.id,
          accountTypeCode: extraType.code,
          accountTypeName: extraType.name,
          accountDefaultStatus: extraType.defaultStatus,
          accountNo: rawNumber,
          amount,
        });
      }
    }

    if (!abGiven && !anyAccountGiven) {
      // A non-member Minor with a resolved guardian doesn't need an account —
      // they are identified by their guardian, not a member number or account.
      const hasGuardian = guardianField !== undefined;
      if (!hasGuardian) {
        problems.push(
          `Provide an ${AB_NUMBER_COLUMN}, or at least one account number, to ` +
            'import this row.'
        );
      }
    }

    if (problems.length > 0) {
      errors.push({ ...row, message: problems.join(' ') });
      if (abGiven) membersWithProblems.add(row.abNumber.trim().toUpperCase());
      continue;
    }

    if (abGiven) membersInUpload.set(abNumber.toUpperCase(), values);
    valid.push({
      ...row,
      // The effective code — the AB Number, when the column itself was
      // left blank on a member row — not necessarily what was typed.
      legacyCode,
      values,
      employment: employmentValues,
      guardian: guardianValues,
      beneficiary: beneficiaryValues,
      nominees,
      abNumber,
      sharesBalance,
      msaBalance,
      accountEntries,
      membershipTypeId: type.id,
      joinedAt,
      kind: abGiven ? 'member' : 'customer',
      existingId: existing?.id ?? null,
      existingApplicationId: existing?.applicationId ?? null,
    });
  }

  // Problems read in the order of the file, whatever order they were
  // checked in.
  const position = new Map(
    rows.map((r, i) => [`${r.sheet}#${r.rowNumber}`, i])
  );
  errors.sort(
    (a, b) =>
      (position.get(`${a.sheet}#${a.rowNumber}`) ?? 0) -
      (position.get(`${b.sheet}#${b.rowNumber}`) ?? 0)
  );
  return { valid, errors };
}

// The member number sequence must be advanced past anything the register
// already contains (S-705), so an ordinary approval issued the moment after
// this import never collides with a number the register already used —
// greatest() against the sequence's own current value rather than a plain
// setval, so importing an older, lower AB number never moves it backward.
async function advanceMemberNumberSeq(
  client: PoolClient,
  memberNo: string
): Promise<void> {
  const digits = Number(memberNo.replace(/^AB/i, ''));
  if (!Number.isFinite(digits) || digits <= 0) return;
  await client.query(
    `select setval('member_number_seq',
              greatest($1::bigint, (select last_value from member_number_seq)))`,
    [digits]
  );
}

export interface ImportOutcome {
  // Unique identifier for this import batch, recorded on the audit trail.
  batchId: string;
  // SHA-256 hex digest of the uploaded file.
  checksum: string;
  // Sum of every balance written in this batch, in cents. Used for S-710
  // reconciliation against a control total the operator supplies separately.
  totalBalance: number;
  imported: {
    legacyCode: string;
    memberNo: string;
    kind: 'member' | 'customer';
    // The member or customer the row wrote to, and whether this row created
    // it or only added to one already on file — what cancelling a batch
    // (summary.ts's neighbour, batches.ts) removes.
    holderId: string;
    created: boolean;
  }[];
  // applicationId: an application this row inserted before it failed, so
  // cancelling the batch can remove it too.
  failed: {
    legacyCode: string;
    message: string;
    applicationId: string | null;
  }[];
}

function toBalanceLines(
  entries: ValidatedAccountEntry[]
): MigrationBalanceLine[] {
  return entries.map(e => ({
    accountTypeId: e.accountTypeId,
    accountTypeCode: e.accountTypeCode,
    accountTypeName: e.accountTypeName,
    amount: e.amount,
  }));
}

// Guardian and Takaful beneficiary (Minor only, always fully required when
// configured — see validateRows), member and non-member Minor alike.
// Nominee 1/2 (whatever this type's own nomineeCount offers, capped at the
// sheet's own 2) is written for a member and non-member row alike (officer
// feedback) — this function is called from both, and simply writes nothing
// for the guardian/beneficiary objects any other row leaves empty.
//
// On a fresh import (skipBlankOrdinals: false) every ordinal the type
// configures is written even blank, matching the pre-created-empty-row
// shape the live capture form itself gives each one, so a member's record
// looks no different whichever route created it. On a re-import
// (skipBlankOrdinals: true) a NOMINEE ordinal left blank in the sheet is
// left alone instead — nominees are optional past the first, so a
// re-import that only means to correct a phone number must not wipe out a
// Nominee 2 that a previous run or the member's own record already
// carries. Guardian and beneficiary are never blank on a valid row (both
// fully mandatory whenever configured, the same as an applicant field), so
// skipBlankOrdinals does not apply to them. Full replace (excluded.values,
// not merged) for whichever party IS written, the same as the applicant
// party's own update — what this row says now is authoritative, not a
// patch on top of what a previous run wrote.
async function writeGuardianAndNomineeParties(
  client: PoolClient,
  applicationId: string,
  row: ValidatedRow,
  { skipBlankOrdinals }: { skipBlankOrdinals: boolean }
): Promise<void> {
  // Employment Details (Occupation, Employment status) — the applicant's
  // own, on the 'employment' party the member page reads. Written only when
  // the sheet actually carries some, so a re-import that leaves the columns
  // blank never wipes out what a previous run (or the member page) set —
  // the same guard guardian and beneficiary use just below. Member and
  // non-member alike, unlike those two.
  if (Object.keys(row.employment).length > 0) {
    await client.query(
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'employment', 1, $2::jsonb)
       on conflict (application_id, subject, ordinal)
       do update set values = application_party.values || excluded.values`,
      [applicationId, JSON.stringify(row.employment)]
    );
  }
  if (Object.keys(row.guardian).length > 0) {
    await client.query(
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'guardian', 1, $2::jsonb)
       on conflict (application_id, subject, ordinal)
       do update set values = excluded.values`,
      [applicationId, JSON.stringify(row.guardian)]
    );
  }
  if (Object.keys(row.beneficiary).length > 0) {
    await client.query(
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'beneficiary', 1, $2::jsonb)
       on conflict (application_id, subject, ordinal)
       do update set values = excluded.values`,
      [applicationId, JSON.stringify(row.beneficiary)]
    );
  }
  for (let ordinal = 1; ordinal <= row.nominees.length; ordinal++) {
    const values = row.nominees[ordinal - 1];
    if (skipBlankOrdinals && Object.keys(values).length === 0) continue;
    await client.query(
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'nominee', $2, $3::jsonb)
       on conflict (application_id, subject, ordinal)
       do update set values = excluded.values`,
      [applicationId, ordinal, JSON.stringify(values)]
    );
  }
}

/**
 * Write the batch. Row by row, each its own success or failure — one bad
 * row (a legacy code, AB Number or account number that raced in between
 * validating and importing) does not undo the rows already written, and the
 * report says exactly which ones need a re-run.
 *
 * A row whose legacy code is already on file updates that record: the
 * applicant field values and joined date are replaced with what this row
 * says, and any account it names that the record does not already hold is
 * opened. Shares, the MSA deposit and any account already held are never
 * touched a second time — validateRows has already left those out of
 * accountEntries, the same reason a payment is never edited, only added to.
 */
export function checksumBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function rowBalance(row: ValidatedRow): number {
  let cents = 0;
  if (row.sharesBalance.trim() !== '') cents += toCents(row.sharesBalance);
  if (row.msaBalance.trim() !== '') cents += toCents(row.msaBalance);
  for (const entry of row.accountEntries) {
    if (entry.amount.trim() !== '') cents += toCents(entry.amount);
  }
  return cents;
}

/**
 * The balance a file carries, in cents: every Shares, MSA and account
 * balance on every row, whether or not the record is already on file. The
 * control total the operator types comes from the old register, which knows
 * nothing about what an earlier run already imported — so this, not what a
 * run ends up writing, is what it is compared with (QA-22).
 */
export function fileBalanceCents(rows: ParsedRow[]): number {
  let cents = 0;
  for (const row of rows) {
    for (const amount of [
      row.sharesBalance,
      row.msaBalance,
      ...Object.values(row.accountBalances),
    ]) {
      if (amount.trim() === '') continue;
      try {
        cents += toCents(amount);
      } catch {
        // Not an amount: validateRows names the row and the column, and
        // nothing is imported while it does.
      }
    }
  }
  return cents;
}

export async function importMembers(
  rows: ValidatedRow[],
  actor: Actor,
  permissions: ReadonlySet<string>,
  checksum: string,
  // A batch run a chunk at a time (batches.ts) names itself and records its
  // own completion; a one-shot call is its own batch.
  options: { batchId?: string } = {}
): Promise<ImportOutcome> {
  assertMayMigrate(permissions);

  const batchId = options.batchId ?? randomUUID();
  const imported: ImportOutcome['imported'] = [];
  const failed: ImportOutcome['failed'] = [];
  let totalBalance = 0;

  for (const row of rows) {
    let allocation: ReceiptAllocation | null = null;
    // Set by the branches that insert an application of their own.
    let newApplicationId: string | null = null;
    try {
      // A guardian from the same upload is imported first; if their own
      // row failed, the minor cannot name them.
      const guardianNo = row.guardian.member_id ?? '';
      if (guardianNo && !(await findGuardian(guardianNo, ''))) {
        throw new MigrationError(
          `The guardian ${guardianNo} is not on file. Import the guardian first.`
        );
      }
      const isUpdate =
        row.existingId !== null && row.existingApplicationId !== null;

      if (row.kind === 'member') {
        if (isUpdate) {
          const memberId = row.existingId!;
          const applicationId = row.existingApplicationId!;

          let feeVersionId: string | null = null;
          if (row.accountEntries.length > 0) {
            // Both read fresh before the transaction opens — a pool-level
            // query() from inside it would ask the pool for a second
            // connection while the first is still checked out (the same
            // reason recordPayment reads its own amountDueForApplication
            // before opening its transaction).
            [allocation, feeVersionId] = await Promise.all([
              allocateReceiptNumber(actor.userId),
              migrationFeeVersionId(row.membershipTypeId),
            ]);
          }

          const memberNo = await withTransaction(async client => {
            await client.query(
              `update application_party set values = $2::jsonb
                 where application_id = $1
                   and subject = 'applicant' and ordinal = 1`,
              [applicationId, JSON.stringify(row.values)]
            );
            await writeGuardianAndNomineeParties(client, applicationId, row, {
              skipBlankOrdinals: true,
            });
            const updated = await client.query<{ member_no: string }>(
              `update member
                  set joined_at = coalesce($2::timestamptz, joined_at)
                where id = $1
              returning member_no`,
              [memberId, row.joinedAt]
            );

            for (const entry of row.accountEntries) {
              await openMigrationAccount(
                client,
                { memberId },
                applicationId,
                entry.accountNo,
                {
                  id: entry.accountTypeId,
                  code: entry.accountTypeCode,
                  name: entry.accountTypeName,
                  defaultStatus: entry.accountDefaultStatus,
                },
                actor
              );
            }

            if (allocation) {
              await recordMigrationOpeningBalances(
                {
                  applicationId,
                  feeVersionId,
                  shares: null,
                  msaDeposit: null,
                  accountLines: toBalanceLines(row.accountEntries),
                  allocation,
                  actorUserId: actor.userId,
                  actorEmail: actor.email,
                },
                client
              );
            }

            await recordAudit(
              {
                actorUserId: actor.userId,
                actorDescription: actor.email,
                action: ACTION_UPDATED,
                entityType: 'member',
                entityId: memberId,
                newValue: {
                  memberNo: updated.rows[0].member_no,
                  legacyCode: row.legacyCode,
                  membershipType: row.sheet,
                },
              },
              client
            );

            return updated.rows[0].member_no;
          });

          totalBalance += rowBalance(row);
          imported.push({
            legacyCode: row.legacyCode,
            memberNo,
            kind: 'member',
            holderId: memberId,
            created: false,
          });
        } else {
          const application = await query<{ id: string }>(
            `insert into membership_application
               (membership_type_id, status, captured_by, application_kind)
             values ($1, 'approved', $2, 'membership')
             returning id`,
            [row.membershipTypeId, actor.userId]
          );
          const applicationId = application.rows[0].id;
          newApplicationId = applicationId;

          await query(
            `insert into application_party (application_id, subject, ordinal, values)
             values ($1, 'applicant', 1, $2::jsonb)`,
            [applicationId, JSON.stringify(row.values)]
          );
          if (Object.keys(row.employment).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'employment', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.employment)]
            );
          }
          if (Object.keys(row.guardian).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'guardian', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.guardian)]
            );
          }
          if (Object.keys(row.beneficiary).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'beneficiary', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.beneficiary)]
            );
          }
          for (let ordinal = 1; ordinal <= row.nominees.length; ordinal++) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'nominee', $2, $3::jsonb)`,
              [
                applicationId,
                ordinal,
                JSON.stringify(row.nominees[ordinal - 1]),
              ]
            );
          }

          const loaded = await loadApplication(applicationId);
          if (!loaded) {
            throw new MigrationError(
              'The application just written was not found.'
            );
          }

          // A stated 0 is "nothing held": no line, and no receipt used up
          // on a zero payment.
          const shares =
            row.sharesBalance && toCents(row.sharesBalance) > 0
              ? row.sharesBalance
              : null;
          const msaDeposit =
            row.msaBalance && toCents(row.msaBalance) > 0
              ? row.msaBalance
              : null;
          const accountLines = toBalanceLines(row.accountEntries);
          let feeVersionId: string | null = null;
          if (hasMigrationBalance({ shares, msaDeposit, accountLines })) {
            [allocation, feeVersionId] = await Promise.all([
              allocateReceiptNumber(actor.userId),
              migrationFeeVersionId(row.membershipTypeId),
            ]);
          }

          const createdMember = await withTransaction(async client => {
            const created = await createMemberFromApplication(
              client,
              loaded,
              actor,
              { memberNo: row.abNumber, viaMigration: true }
            );
            await client.query(
              `update member set legacy_code = $2,
                      joined_at = coalesce($3::timestamptz, joined_at)
                where id = $1`,
              [created.id, row.legacyCode, row.joinedAt]
            );
            await advanceMemberNumberSeq(client, row.abNumber);

            for (const entry of row.accountEntries) {
              await openMigrationAccount(
                client,
                { memberId: created.id },
                applicationId,
                entry.accountNo,
                {
                  id: entry.accountTypeId,
                  code: entry.accountTypeCode,
                  name: entry.accountTypeName,
                  defaultStatus: entry.accountDefaultStatus,
                },
                actor
              );
            }

            if (allocation) {
              await recordMigrationOpeningBalances(
                {
                  applicationId,
                  feeVersionId,
                  shares,
                  msaDeposit,
                  accountLines,
                  allocation,
                  actorUserId: actor.userId,
                  actorEmail: actor.email,
                },
                client
              );
            }

            await recordAudit(
              {
                actorUserId: actor.userId,
                actorDescription: actor.email,
                action: ACTION_IMPORTED,
                entityType: 'member',
                entityId: created.id,
                newValue: {
                  memberNo: created.memberNo,
                  legacyCode: row.legacyCode,
                  membershipType: row.sheet,
                },
              },
              client
            );
            return { memberNo: created.memberNo, memberId: created.id };
          });

          totalBalance += rowBalance(row);
          imported.push({
            legacyCode: row.legacyCode,
            memberNo: createdMember.memberNo,
            kind: 'member',
            holderId: createdMember.memberId,
            created: true,
          });
        }
      } else {
        // ---- Non-member (customer): identified by their account(s) only ----
        if (isUpdate) {
          const customerId = row.existingId!;
          const applicationId = row.existingApplicationId!;

          let feeVersionId: string | null = null;
          if (row.accountEntries.length > 0) {
            [allocation, feeVersionId] = await Promise.all([
              allocateReceiptNumber(actor.userId),
              migrationFeeVersionId(row.membershipTypeId),
            ]);
          }

          await withTransaction(async client => {
            await client.query(
              `update application_party set values = $2::jsonb
                 where application_id = $1
                   and subject = 'applicant' and ordinal = 1`,
              [applicationId, JSON.stringify(row.values)]
            );
            // A non-member Minor row carries a guardian and beneficiary when
            // configured; non-minor, non-member rows do not. Either way,
            // writeGuardianAndNomineeParties writes only the objects that are
            // non-empty, so it is correct for both. Nominee 1/2 same as a
            // member row.
            await writeGuardianAndNomineeParties(client, applicationId, row, {
              skipBlankOrdinals: true,
            });
            await client.query(
              `update customer
                  set joined_at = coalesce($2::timestamptz, joined_at)
                where id = $1`,
              [customerId, row.joinedAt]
            );

            for (const entry of row.accountEntries) {
              await openMigrationAccount(
                client,
                { customerId },
                applicationId,
                entry.accountNo,
                {
                  id: entry.accountTypeId,
                  code: entry.accountTypeCode,
                  name: entry.accountTypeName,
                  defaultStatus: entry.accountDefaultStatus,
                },
                actor
              );
            }

            if (allocation) {
              await recordMigrationOpeningBalances(
                {
                  applicationId,
                  feeVersionId,
                  shares: null,
                  msaDeposit: null,
                  accountLines: toBalanceLines(row.accountEntries),
                  allocation,
                  actorUserId: actor.userId,
                  actorEmail: actor.email,
                },
                client
              );
            }

            await recordAudit(
              {
                actorUserId: actor.userId,
                actorDescription: actor.email,
                action: ACTION_CUSTOMER_UPDATED,
                entityType: 'customer',
                entityId: customerId,
                newValue: {
                  legacyCode: row.legacyCode,
                  membershipType: row.sheet,
                },
              },
              client
            );
          });

          totalBalance += rowBalance(row);
          imported.push({
            legacyCode: row.legacyCode,
            memberNo: '',
            kind: 'customer',
            holderId: customerId,
            created: false,
          });
        } else {
          const application = await query<{ id: string }>(
            `insert into membership_application
               (membership_type_id, status, captured_by, application_kind)
             values ($1, 'approved', $2, 'customer_account')
             returning id`,
            [row.membershipTypeId, actor.userId]
          );
          const applicationId = application.rows[0].id;
          newApplicationId = applicationId;

          await query(
            `insert into application_party (application_id, subject, ordinal, values)
             values ($1, 'applicant', 1, $2::jsonb)`,
            [applicationId, JSON.stringify(row.values)]
          );
          if (Object.keys(row.employment).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'employment', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.employment)]
            );
          }
          // A non-member Minor carries its guardian and Takaful beneficiary
          // the same as a member one (officer QA: a minor saver came in
          // with no guardian); every other non-member row leaves both empty.
          if (Object.keys(row.guardian).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'guardian', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.guardian)]
            );
          }
          if (Object.keys(row.beneficiary).length > 0) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'beneficiary', 1, $2::jsonb)`,
              [applicationId, JSON.stringify(row.beneficiary)]
            );
          }
          // Nominee 1/2 same as a member row (officer feedback).
          for (let ordinal = 1; ordinal <= row.nominees.length; ordinal++) {
            await query(
              `insert into application_party (application_id, subject, ordinal, values)
               values ($1, 'nominee', $2, $3::jsonb)`,
              [
                applicationId,
                ordinal,
                JSON.stringify(row.nominees[ordinal - 1]),
              ]
            );
          }

          const accountLines = toBalanceLines(row.accountEntries);
          let feeVersionId: string | null = null;
          if (row.accountEntries.length > 0) {
            [allocation, feeVersionId] = await Promise.all([
              allocateReceiptNumber(actor.userId),
              migrationFeeVersionId(row.membershipTypeId),
            ]);
          }

          const customerId = await withTransaction(async client => {
            const created = await createMigratedCustomer(client, applicationId);
            await client.query(
              `update customer set legacy_code = $2,
                      joined_at = coalesce($3::timestamptz, joined_at)
                where id = $1`,
              [created.id, row.legacyCode, row.joinedAt]
            );

            for (const entry of row.accountEntries) {
              await openMigrationAccount(
                client,
                { customerId: created.id },
                applicationId,
                entry.accountNo,
                {
                  id: entry.accountTypeId,
                  code: entry.accountTypeCode,
                  name: entry.accountTypeName,
                  defaultStatus: entry.accountDefaultStatus,
                },
                actor
              );
            }

            if (allocation) {
              await recordMigrationOpeningBalances(
                {
                  applicationId,
                  feeVersionId,
                  shares: null,
                  msaDeposit: null,
                  accountLines,
                  allocation,
                  actorUserId: actor.userId,
                  actorEmail: actor.email,
                },
                client
              );
            }

            await recordAudit(
              {
                actorUserId: actor.userId,
                actorDescription: actor.email,
                action: ACTION_CUSTOMER_IMPORTED,
                entityType: 'customer',
                entityId: created.id,
                newValue: {
                  legacyCode: row.legacyCode,
                  membershipType: row.sheet,
                },
              },
              client
            );
            return created.id;
          });

          totalBalance += rowBalance(row);
          imported.push({
            legacyCode: row.legacyCode,
            memberNo: '',
            kind: 'customer',
            holderId: customerId,
            created: true,
          });
        }
      }
    } catch (error) {
      if (allocation) {
        await abandonReceiptNumber(
          allocation.id,
          error instanceof Error
            ? error.message
            : 'The import failed while being recorded.'
        );
      }
      failed.push({
        legacyCode: row.legacyCode,
        message: error instanceof Error ? error.message : 'Unknown error.',
        applicationId: newApplicationId,
      });
    }
  }

  if (options.batchId) {
    return { batchId, checksum, totalBalance, imported, failed };
  }
  await recordAuditQuietly({
    actorUserId: actor.userId,
    actorDescription: actor.email,
    action: 'migration.batch.completed',
    entityType: 'migration',
    entityId: batchId,
    newValue: {
      checksum,
      rows: rows.length,
      imported: imported.length,
      members: imported.filter(r => r.kind === 'member').length,
      customers: imported.filter(r => r.kind === 'customer').length,
      failed: failed.length,
      totalBalance: fromCents(totalBalance),
    },
  });

  return { batchId, checksum, totalBalance, imported, failed };
}
