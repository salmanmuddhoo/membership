// M7 · Legacy migration (docs/backlog.md): a System Administrator imports
// members straight from the legacy register, from an Excel sheet, with no
// capture, no review, no approval — the whole batch lands as status
// 'approved' in one step.
//
// A migrated member is created exactly the way an ordinary approval creates
// one: membership_application (status 'approved') + application_party +
// member + accounts, via createMemberFromApplication (members/create.ts),
// reused as-is. Every existing page that reads a member already knows how
// to show one — legacy_code (migration 0047) is the only new thing a
// migrated record carries, kept as a searchable cross-reference (S-705).
//
// Second increment (migration 0048): the member's own AB Number, carried
// unchanged from the legacy register rather than reassigned from the
// sequence (S-705's own acceptance criterion — "found by what the Society
// has always called them"); importing the same legacy code a second time
// updates the member on file instead of being refused, so a detail typo'd
// the first time can be corrected; and S-709's opening balances — Shares,
// the MSA deposit, and any other account type (HSA, Investment, …) a row
// names one for.
//
// Deliberately narrower than the full M7 spec still:
//   - Applicant fields only. Nominee, guardian and employment are left for
//     the member's own record to fill in later — nothing here requires
//     them, the same as a member page already tolerates an empty Nominee
//     section.
//   - A membership type that configures a `guardian` subject (currently
//     only 'minor') is excluded from the template and the import: a
//     guardian has to already be a member, found by search — not something
//     an Excel row can express safely. Individual and Corporate (and any
//     future type shaped like them) work today; a minor's own migration
//     path is its own increment.
//   - Synchronous, not the queued job S-703 describes: an Excel sheet of
//     members is small enough (hundreds of rows, not millions) that a
//     request/response round trip is the simpler, sufficient tool. Re-runs
//     are how "at different stages" works — upload another sheet later for
//     more members, or the same one again to correct a detail or add a
//     balance that was not yet known.
import type { PoolClient } from 'pg';
import ExcelJS from 'exceljs';
import { recordAudit } from '../access/audit';
import type { Actor } from '../applications/capture';
import { loadApplication, normalise } from '../applications/capture';
import {
  createMemberFromApplication,
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

const LEGACY_CODE_COLUMN = 'Legacy Member Code';
const AB_NUMBER_COLUMN = 'AB Number';
const JOINED_COLUMN = 'Joined Date (optional)';
const SHARES_BALANCE_COLUMN = 'Shares Balance (optional)';
const MSA_BALANCE_COLUMN = 'MSA Deposit Balance (optional)';

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

// A type with a `guardian` subject needs a person who already exists,
// findable by search (CaptureFields.astro's isGuardianSearch) — not
// something an Excel row can express. Every other type is applicant fields
// only, which an Excel row can.
function eligible(type: MembershipType): boolean {
  return type.isActive && !type.fields.some(f => f.subject === 'guardian');
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

// Every account type a membership approval could ever open beyond Shares
// and the MSA (both membership-default, and always available — S-709's own
// balance columns for those two are unconditional below) — active, and
// either open to every membership type or explicitly eligible for this one
// (account_type_membership_type, migration 0040), the same rule
// eligibleMembershipTypesForMigration's own capture-form parity follows.
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

function balanceColumnFor(accountType: AccountType): string {
  return `${accountType.name} Balance (optional)`;
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
    const extras = additionalAccountTypes(type, accountTypes);
    const sheet = workbook.addWorksheet(type.name.slice(0, 31));

    const headers = [
      LEGACY_CODE_COLUMN,
      `${AB_NUMBER_COLUMN} *`,
      JOINED_COLUMN,
      ...fields.map(f => f.label + (f.isMandatory ? ' *' : '')),
      SHARES_BALANCE_COLUMN,
      MSA_BALANCE_COLUMN,
      ...extras.map(balanceColumnFor),
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
  sharesBalance: string;
  msaBalance: string;
  // Keyed by account_type.id — one entry per additional account type this
  // row named a balance for.
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
    const extras = additionalAccountTypes(type, accountTypes);
    const extraColumnByLabel = new Map(
      extras.map(t => [balanceColumnFor(t), t.id])
    );

    const headerRow = sheet.getRow(1);
    const columnFieldKeys = new Map<number, string>();
    const extraColumns = new Map<number, string>();
    let legacyCodeColumn: number | null = null;
    let abNumberColumn: number | null = null;
    let joinedColumn: number | null = null;
    let sharesBalanceColumn: number | null = null;
    let msaBalanceColumn: number | null = null;
    headerRow.eachCell((cell, colNumber) => {
      const header = String(cell.value ?? '').trim();
      if (header === LEGACY_CODE_COLUMN) {
        legacyCodeColumn = colNumber;
      } else if (stripMandatoryMarker(header) === AB_NUMBER_COLUMN) {
        abNumberColumn = colNumber;
      } else if (header === JOINED_COLUMN) {
        joinedColumn = colNumber;
      } else if (header === SHARES_BALANCE_COLUMN) {
        sharesBalanceColumn = colNumber;
      } else if (header === MSA_BALANCE_COLUMN) {
        msaBalanceColumn = colNumber;
      } else if (extraColumnByLabel.has(header)) {
        extraColumns.set(colNumber, extraColumnByLabel.get(header)!);
      } else {
        const fieldKey = byLabel.get(stripMandatoryMarker(header));
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
      const accountBalances: Record<string, string> = {};
      for (const [colNumber, accountTypeId] of extraColumns) {
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
        sharesBalance !== '' ||
        msaBalance !== '' ||
        Object.values(accountBalances).some(v => v !== '');
      if (!hasContent) return;

      rows.push({
        sheet: sheet.name,
        rowNumber,
        legacyCode,
        abNumber,
        joinedAt: cellText(joinedColumn),
        values,
        sharesBalance,
        msaBalance,
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

export interface ValidatedRow extends Omit<ParsedRow, 'joinedAt'> {
  membershipTypeId: string;
  joinedAt: Date | null;
  // Set when this row's Legacy Member Code matches a member already on file
  // from an earlier import — importMembers updates that member instead of
  // creating a second one.
  existingMemberId: string | null;
  existingApplicationId: string | null;
}

interface ExistingMigratedMember {
  id: string;
  memberNo: string;
  applicationId: string | null;
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
 * Format and mandatory-field checks — legacy_code uniqueness against what
 * is already on file, and against the rest of this same batch, so two rows
 * claiming the same old code are caught before either is written, not
 * after one of them already is. A legacy code already on file is not
 * itself an error: importMembers updates that member instead, provided the
 * row's AB Number agrees with the one on record.
 */
export async function validateRows(
  rows: ParsedRow[]
): Promise<{ valid: ValidatedRow[]; errors: RowError[] }> {
  const [types, accountTypes] = await Promise.all([
    eligibleMembershipTypesForMigration(),
    listAccountTypes(),
  ]);
  const byName = new Map(types.map(t => [t.name, t]));
  const accountTypesById = new Map(accountTypes.map(t => [t.id, t]));

  const errors: RowError[] = [];
  const valid: ValidatedRow[] = [];

  const existingMembers = await query<{
    id: string;
    member_no: string;
    application_id: string | null;
    legacy_code: string;
  }>(`select id, member_no, application_id, legacy_code from member`);
  const existingByLegacyCode = new Map<string, ExistingMigratedMember>(
    existingMembers.rows
      .filter(r => r.legacy_code)
      .map(r => [
        r.legacy_code.toLowerCase(),
        {
          id: r.id,
          memberNo: r.member_no,
          applicationId: r.application_id,
        },
      ])
  );
  const memberNosTaken = new Set(
    existingMembers.rows.map(r => r.member_no.toUpperCase())
  );

  // Counted up front so every row sharing a duplicated code — or a
  // duplicated AB Number — is flagged, not just the second one, which would
  // leave the administrator unable to tell which of the two rows on screen
  // is the "original" without cross-referencing the sheet themselves.
  const legacyOccurrences = new Map<string, number>();
  const abOccurrences = new Map<string, number>();
  for (const row of rows) {
    if (row.legacyCode !== '') {
      const key = row.legacyCode.toLowerCase();
      legacyOccurrences.set(key, (legacyOccurrences.get(key) ?? 0) + 1);
    }
    if (row.abNumber !== '') {
      const key = row.abNumber.toUpperCase();
      abOccurrences.set(key, (abOccurrences.get(key) ?? 0) + 1);
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

    if (row.legacyCode === '') {
      problems.push(`${LEGACY_CODE_COLUMN} is required.`);
    } else if ((legacyOccurrences.get(row.legacyCode.toLowerCase()) ?? 0) > 1) {
      problems.push(
        `${LEGACY_CODE_COLUMN} "${row.legacyCode}" appears more than once ` +
          'in this sheet.'
      );
    }

    let existing: ExistingMigratedMember | null = null;
    if (row.legacyCode !== '') {
      existing = existingByLegacyCode.get(row.legacyCode.toLowerCase()) ?? null;
      if (existing && existing.applicationId === null) {
        problems.push(
          `${LEGACY_CODE_COLUMN} "${row.legacyCode}" is on file but has no ` +
            'application to update. Ask an administrator to look into it.'
        );
        existing = null;
      }
    }

    let abNumber = '';
    if (row.abNumber === '') {
      problems.push(`${AB_NUMBER_COLUMN} is required.`);
    } else if (!AB_NUMBER_FORMAT.test(row.abNumber.trim())) {
      problems.push(
        `${AB_NUMBER_COLUMN} "${row.abNumber}" must look like AB2001.`
      );
    } else {
      abNumber = row.abNumber.trim().toUpperCase();
      if ((abOccurrences.get(abNumber) ?? 0) > 1) {
        problems.push(
          `${AB_NUMBER_COLUMN} "${row.abNumber}" appears more than once in ` +
            'this sheet.'
        );
      } else if (existing) {
        if (abNumber !== existing.memberNo.toUpperCase()) {
          problems.push(
            `${AB_NUMBER_COLUMN} "${row.abNumber}" does not match ` +
              `${existing.memberNo}, which "${row.legacyCode}" is already on ` +
              'file as. Fix the AB Number, or correct the legacy code if this ' +
              'is a different member.'
          );
        }
      } else if (memberNosTaken.has(abNumber)) {
        problems.push(
          `${AB_NUMBER_COLUMN} "${row.abNumber}" is already on file for a ` +
            'different member.'
        );
      }
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
    const accountBalances: Record<string, string> = {};
    for (const [accountTypeId, raw] of Object.entries(row.accountBalances)) {
      const accountType = accountTypesById.get(accountTypeId);
      const label = `${accountType?.name ?? 'Account'} Balance`;
      const amount = parseAmount(raw, label, problems);
      if (amount !== '') accountBalances[accountTypeId] = amount;
    }

    if (problems.length > 0) {
      errors.push({ ...row, message: problems.join(' ') });
      continue;
    }

    valid.push({
      ...row,
      values,
      abNumber,
      sharesBalance,
      msaBalance,
      accountBalances,
      membershipTypeId: type.id,
      joinedAt,
      existingMemberId: existing?.id ?? null,
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
  imported: { legacyCode: string; memberNo: string }[];
  failed: { legacyCode: string; message: string }[];
}

/**
 * Write the batch. Row by row, each its own success or failure — one bad
 * row (a legacy code or AB Number that raced in between validating and
 * importing) does not undo the rows already written, and the report says
 * exactly which ones need a re-run.
 *
 * A row whose legacy code is already on file updates that member: the
 * applicant field values and joined date are replaced with what this row
 * says, and any additional account type it names a balance for — one the
 * member does not already hold — is opened. Shares, the MSA deposit and any
 * account type already held are never touched a second time: a payment is
 * append-only, so editing a balance already on file is not something a
 * re-import can do.
 */
export async function importMembers(
  rows: ValidatedRow[],
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<ImportOutcome> {
  assertMayMigrate(permissions);

  const accountTypes = await listAccountTypes();
  const accountTypesById = new Map(accountTypes.map(t => [t.id, t]));

  const imported: ImportOutcome['imported'] = [];
  const failed: ImportOutcome['failed'] = [];

  const balanceLine = (accountTypeId: string, amount: string) => {
    const type = accountTypesById.get(accountTypeId)!;
    return {
      accountTypeId: type.id,
      accountTypeCode: type.code,
      accountTypeName: type.name,
    };
  };

  for (const row of rows) {
    let allocation: ReceiptAllocation | null = null;
    try {
      if (row.existingMemberId && row.existingApplicationId) {
        // ---- Update a member already on file from an earlier import ----
        const memberId = row.existingMemberId;
        const applicationId = row.existingApplicationId;

        const held = await query<{ account_type_id: string }>(
          `select account_type_id from account where member_id = $1`,
          [memberId]
        );
        const heldTypeIds = new Set(held.rows.map(r => r.account_type_id));
        const accountLines: MigrationBalanceLine[] = Object.entries(
          row.accountBalances
        )
          .filter(([accountTypeId]) => !heldTypeIds.has(accountTypeId))
          .map(([accountTypeId, amount]) => ({
            ...balanceLine(accountTypeId, amount),
            amount,
          }));

        let feeVersionId: string | null = null;
        if (accountLines.length > 0) {
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
          const updated = await client.query<{ member_no: string }>(
            `update member
                set joined_at = coalesce($2::timestamptz, joined_at)
              where id = $1
            returning member_no`,
            [memberId, row.joinedAt]
          );

          for (const line of accountLines) {
            const type = accountTypesById.get(line.accountTypeId)!;
            await openMigrationAccount(
              client,
              memberId,
              applicationId,
              {
                id: type.id,
                code: type.code,
                name: type.name,
                defaultStatus: type.defaultStatus,
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

        imported.push({ legacyCode: row.legacyCode, memberNo });
      } else {
        // ---- A legacy code not yet on file: create the member ----
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

        const loaded = await loadApplication(applicationId);
        if (!loaded) {
          throw new MigrationError(
            'The application just written was not found.'
          );
        }

        const accountLines: MigrationBalanceLine[] = Object.entries(
          row.accountBalances
        ).map(([accountTypeId, amount]) => ({
          ...balanceLine(accountTypeId, amount),
          amount,
        }));
        const shares = row.sharesBalance || null;
        const msaDeposit = row.msaBalance || null;
        let feeVersionId: string | null = null;
        if (hasMigrationBalance({ shares, msaDeposit, accountLines })) {
          // Both read fresh before the transaction opens — see
          // migrationFeeVersionId's own comment.
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
            { memberNo: row.abNumber }
          );
          await client.query(
            `update member set legacy_code = $2,
                    joined_at = coalesce($3::timestamptz, joined_at)
              where id = $1`,
            [created.id, row.legacyCode, row.joinedAt]
          );
          await advanceMemberNumberSeq(client, row.abNumber);

          for (const line of accountLines) {
            const type = accountTypesById.get(line.accountTypeId)!;
            await openMigrationAccount(
              client,
              created.id,
              applicationId,
              {
                id: type.id,
                code: type.code,
                name: type.name,
                defaultStatus: type.defaultStatus,
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

        imported.push({ legacyCode: row.legacyCode, memberNo });
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
