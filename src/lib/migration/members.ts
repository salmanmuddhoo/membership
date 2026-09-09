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
import type { PoolClient } from 'pg';
import ExcelJS from 'exceljs';
import { recordAudit } from '../access/audit';
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
// A guardian has to be on file before their minor is imported — a batch
// naming both has to be run once for the guardian, then again for the
// minor; findGuardian only looks at what is already committed, never at
// another row still in the same sheet.
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

function nomineeFields(type: MembershipType): MembershipTypeField[] {
  return type.fields
    .filter(f => f.subject === 'nominee' && f.isVisible)
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

  for (const type of types) {
    const fields = applicantFields(type);
    const guardian = guardianFields(type);
    const beneficiary = beneficiaryFields(type);
    const nominees = nomineeFields(type);
    const nomineeOrdinals = migratedNomineeOrdinals(type);
    const extras = additionalAccountTypes(type, accountTypes);
    const sheet = workbook.addWorksheet(type.name.slice(0, 31));

    const nomineeHeaders: string[] = [];
    for (let ordinal = 1; ordinal <= nomineeOrdinals; ordinal++) {
      for (const field of nominees) {
        // S-602, relaxed on officer feedback: only the first nominee is
        // ever mandatory (problemsBlockingSubmission's own exemption) — a
        // second is there for a family that wants to name one, never
        // demanded.
        nomineeHeaders.push(
          nomineeColumnHeader(
            field,
            ordinal,
            ordinal === 1 && field.isMandatory
          )
        );
      }
    }

    const headers = [
      LEGACY_CODE_COLUMN,
      AB_NUMBER_COLUMN,
      JOINED_COLUMN,
      ...fields.map(f => f.label + (f.isMandatory ? ' *' : '')),
      ...guardian.map(f => f.label + (f.isMandatory ? ' *' : '')),
      ...beneficiary.map(f => f.label + (f.isMandatory ? ' *' : '')),
      ...nomineeHeaders,
      SHARES_BALANCE_COLUMN,
      MSA_BALANCE_COLUMN,
      ...extras.flatMap(t => [extraNumberColumn(t), extraBalanceColumn(t)]),
    ];
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach(col => {
      col.width = 24;
    });

    // A choice field gets a dropdown restricted to its configured choices,
    // so a typo cannot even be typed in — the same guarantee the capture
    // form's own <select> already gives.
    fields.forEach((field, index) => {
      if (field.dataType !== 'choice' || field.choices.length === 0) return;
      const column = index + 4; // 1: legacy code, 2: AB number, 3: joined date
      for (let row = 2; row <= 500; row++) {
        sheet.getCell(row, column).dataValidation = {
          type: 'list',
          allowBlank: !field.isMandatory,
          formulae: [`"${field.choices.join(',')}"`],
        };
      }
    });
  }

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

export async function parseImportFile(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs bundles its own @types/node, whose Buffer generic instantiation
  // does not structurally match this project's — an assertion, not an
  // actual type difference.
  await workbook.xlsx.load(buffer as any);

  const [types, accountTypes] = await Promise.all([
    eligibleMembershipTypesForMigration(),
    listAccountTypes(),
  ]);
  const byName = new Map(types.map(t => [t.name, t]));

  const rows: ParsedRow[] = [];
  for (const sheet of workbook.worksheets) {
    const type = byName.get(sheet.name);
    if (!type) continue; // A sheet this template never produced — ignored.
    const fields = applicantFields(type);
    const byLabel = new Map(
      fields.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
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
    const guardianColumns = new Map<number, string>();
    const beneficiaryColumns = new Map<number, string>();
    const nomineeColumns = new Map<
      number,
      { ordinal: number; fieldKey: string }
    >();
    const extraNumberColumns = new Map<number, string>();
    const extraBalanceColumns = new Map<number, string>();
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
      } else if (header === SHARES_BALANCE_COLUMN) {
        sharesBalanceColumn = colNumber;
      } else if (header === MSA_BALANCE_COLUMN) {
        msaBalanceColumn = colNumber;
      } else if (extraNumberByLabel.has(header)) {
        extraNumberColumns.set(colNumber, extraNumberByLabel.get(header)!);
      } else if (extraBalanceByLabel.has(header)) {
        extraBalanceColumns.set(colNumber, extraBalanceByLabel.get(header)!);
      } else if (guardianByLabel.has(bareHeader)) {
        guardianColumns.set(colNumber, guardianByLabel.get(bareHeader)!);
      } else if (beneficiaryByLabel.has(bareHeader)) {
        beneficiaryColumns.set(colNumber, beneficiaryByLabel.get(bareHeader)!);
      } else if (nomineeByHeader.has(bareHeader)) {
        nomineeColumns.set(colNumber, nomineeByHeader.get(bareHeader)!);
      } else {
        const fieldKey = byLabel.get(bareHeader);
        if (fieldKey) columnFieldKeys.set(colNumber, fieldKey);
      }
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cellText = (colNumber: number | null) => {
        if (colNumber === null) return '';
        const value = row.getCell(colNumber).value;
        if (value === null || value === undefined) return '';
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        if (typeof value === 'object' && 'text' in value) {
          return String((value as { text: unknown }).text ?? '').trim();
        }
        return String(value).trim();
      };

      const legacyCode = cellText(legacyCodeColumn);
      const abNumber = cellText(abNumberColumn);
      const values: Record<string, string> = {};
      for (const [colNumber, fieldKey] of columnFieldKeys) {
        values[fieldKey] = cellText(colNumber);
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
        Object.values(guardianValues).some(v => v !== '') ||
        Object.values(beneficiaryValues).some(v => v !== '') ||
        nomineeValues.some(n => Object.values(n).some(v => v !== '')) ||
        sharesBalance !== '' ||
        msaBalance !== '' ||
        Object.values(accountNumbers).some(v => v !== '') ||
        Object.values(accountBalances).some(v => v !== '');
      if (!hasContent) return;

      rows.push({
        sheet: sheet.name,
        rowNumber,
        legacyCode,
        abNumber,
        joinedAt: cellText(joinedColumn),
        values,
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

function parseAmount(raw: string, label: string, problems: string[]): string {
  if (raw.trim() === '') return '';
  try {
    const cents = toCents(raw);
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
    // way, this import does not distinguish.
    query<{ id: string; nic: string | null; mobile: string | null }>(
      `select m.id, p.values->>'nic' as nic, p.values->>'mobile' as mobile
         from member m
         join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1`
    ),
    query<{ id: string; nic: string | null; mobile: string | null }>(
      `select c.id, p.values->>'nic' as nic, p.values->>'mobile' as mobile
         from customer c
         join application_party p
           on p.application_id = c.application_id
          and p.subject = 'applicant' and p.ordinal = 1`
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
    const mobileKey = (row.values.mobile ?? '').trim().toLowerCase();
    if (mobileKey !== '') {
      mobileOccurrences.set(
        mobileKey,
        (mobileOccurrences.get(mobileKey) ?? 0) + 1
      );
    }
  }

  for (const row of rows) {
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
      const parsed = new Date(row.joinedAt);
      if (Number.isNaN(parsed.getTime())) {
        problems.push(`${JOINED_COLUMN} "${row.joinedAt}" is not a date.`);
      } else {
        joinedAt = parsed;
      }
    }

    const fields = applicantFields(type);
    const { values, errors: formatErrors } = normalise(row.values, fields);
    for (const error of formatErrors) problems.push(error.label);
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
    const mobile = (values.mobile ?? '').trim();
    if (mobile !== '') {
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
      } else if ((mobileOccurrences.get(key) ?? 0) > 1) {
        problems.push(
          `Mobile "${row.values.mobile}" appears more than once in this sheet.`
        );
      }
    }

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
      if (!abGiven) {
        if (guardianMemberNo !== '') {
          problems.push(
            'Guardian details need an AB Number — only a member has a ' +
              'guardian recorded.'
          );
        }
      } else if (guardianMemberNo === '') {
        problems.push(`${guardianField.label} is required.`);
      } else {
        const found = await findGuardian(guardianMemberNo, '');
        if (!found) {
          problems.push(
            `${guardianField.label} "${guardianMemberNo}" does not match ` +
              'any member or in-progress application on file — the ' +
              'guardian must already be on file before their minor can ' +
              'be imported.'
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
      if (!abGiven) {
        if (Object.values(beneficiaryValues).some(v => v !== '')) {
          problems.push(
            'Takaful beneficiary details need an AB Number — only a ' +
              'member has one recorded.'
          );
        }
      } else {
        for (const field of beneficiaryTypeFields) {
          if (!field.isMandatory) continue;
          if ((beneficiaryValues[field.fieldKey] ?? '').trim() === '') {
            problems.push(`${field.label} is required.`);
          }
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
      problems.push(
        `Provide an ${AB_NUMBER_COLUMN}, or at least one account number, to ` +
          'import this row.'
      );
    }

    if (problems.length > 0) {
      errors.push({ ...row, message: problems.join(' ') });
      continue;
    }

    valid.push({
      ...row,
      // The effective code — the AB Number, when the column itself was
      // left blank on a member row — not necessarily what was typed.
      legacyCode,
      values,
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
  imported: {
    legacyCode: string;
    memberNo: string;
    kind: 'member' | 'customer';
  }[];
  failed: { legacyCode: string; message: string }[];
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
// configured — see validateRows) — member rows only, validateRows already
// having refused either on a non-member row. Nominee 1/2 (whatever this
// type's own nomineeCount offers, capped at the sheet's own 2) is written
// for a member and non-member row alike (officer feedback) — this function
// is called from both, and simply writes nothing for the guardian/
// beneficiary objects a non-member row always leaves empty.
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
export async function importMembers(
  rows: ValidatedRow[],
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<ImportOutcome> {
  assertMayMigrate(permissions);

  const imported: ImportOutcome['imported'] = [];
  const failed: ImportOutcome['failed'] = [];

  for (const row of rows) {
    let allocation: ReceiptAllocation | null = null;
    try {
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

          imported.push({
            legacyCode: row.legacyCode,
            memberNo,
            kind: 'member',
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

          await query(
            `insert into application_party (application_id, subject, ordinal, values)
             values ($1, 'applicant', 1, $2::jsonb)`,
            [applicationId, JSON.stringify(row.values)]
          );
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

          const shares = row.sharesBalance || null;
          const msaDeposit = row.msaBalance || null;
          const accountLines = toBalanceLines(row.accountEntries);
          let feeVersionId: string | null = null;
          if (hasMigrationBalance({ shares, msaDeposit, accountLines })) {
            [allocation, feeVersionId] = await Promise.all([
              allocateReceiptNumber(actor.userId),
              migrationFeeVersionId(row.membershipTypeId),
            ]);
          }

          const memberNo = await withTransaction(async client => {
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
            return created.memberNo;
          });

          imported.push({
            legacyCode: row.legacyCode,
            memberNo,
            kind: 'member',
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
            // A non-member row carries no guardian or beneficiary (both stay
            // member-only, validateRows' own !abGiven checks above) but
            // Nominee 1/2 same as a member row — writeGuardianAndNomineeParties
            // is a no-op for the empty guardian/beneficiary objects here.
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

          imported.push({
            legacyCode: row.legacyCode,
            memberNo: '',
            kind: 'customer',
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

          await query(
            `insert into application_party (application_id, subject, ordinal, values)
             values ($1, 'applicant', 1, $2::jsonb)`,
            [applicationId, JSON.stringify(row.values)]
          );
          // Nominee 1/2 same as a member row (officer feedback) — no
          // guardian or beneficiary to write here, both stay member-only.
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

          await withTransaction(async client => {
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
          });

          imported.push({
            legacyCode: row.legacyCode,
            memberNo: '',
            kind: 'customer',
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
      });
    }
  }

  return { imported, failed };
}
