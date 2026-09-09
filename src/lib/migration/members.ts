// M7 · Legacy migration, first increment (docs/backlog.md): a System
// Administrator imports members straight from the legacy register, from an
// Excel sheet, with no capture, no review, no approval — the whole batch
// lands as status 'approved' in one step.
//
// A migrated member is created exactly the way an ordinary approval creates
// one: membership_application (status 'approved') + application_party +
// member + accounts, via createMemberFromApplication (members/create.ts),
// reused as-is. Every existing page that reads a member already knows how
// to show one — legacy_code (migration 0047) is the only new thing a
// migrated record carries, kept as a searchable cross-reference (S-705).
//
// Deliberately narrower than the full M7 spec for this first increment:
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
//   - Balances — shares, savings, Haj, loans (S-709) — are a later pass,
//     per the milestone's own goal: "members first, finance later". A
//     migrated member gets the same Shares/MSA accounts an approval always
//     opens, at zero, same as this system has no other way to open one.
//   - Synchronous, not the queued job S-703 describes: an Excel sheet of
//     members is small enough (hundreds of rows, not millions) that a
//     request/response round trip is the simpler, sufficient tool. Re-runs
//     are how "at different stages" works — upload another sheet later for
//     more members, or the same one again for rows that still say pending.
import ExcelJS from 'exceljs';
import { recordAudit } from '../access/audit';
import type { Actor } from '../applications/capture';
import { loadApplication, normalise } from '../applications/capture';
import { createMemberFromApplication } from '../members/create';
import {
  listMembershipTypes,
  type MembershipType,
  type MembershipTypeField,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_MIGRATE = 'system.migrate_members';
const ACTION_IMPORTED = 'member.migration.imported';

const LEGACY_CODE_COLUMN = 'Legacy Member Code';
const JOINED_COLUMN = 'Joined Date (optional)';

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

// One sheet per eligible membership type, its columns exactly the fields
// that type's own capture form asks for — read live, the same as the
// capture form itself, so a field an administrator adds or relabels
// appears here without a code change.
export async function buildImportTemplate(): Promise<Buffer> {
  const types = await eligibleMembershipTypesForMigration();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Al Barakah MCSL';
  workbook.created = new Date();

  for (const type of types) {
    const fields = applicantFields(type);
    const sheet = workbook.addWorksheet(type.name.slice(0, 31));

    const headers = [
      LEGACY_CODE_COLUMN,
      JOINED_COLUMN,
      ...fields.map(f => f.label + (f.isMandatory ? ' *' : '')),
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
      const column = index + 3; // 1: legacy code, 2: joined date
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
  joinedAt: string;
  values: Record<string, string>;
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

  const types = await eligibleMembershipTypesForMigration();
  const byName = new Map(types.map(t => [t.name, t]));

  const rows: ParsedRow[] = [];
  for (const sheet of workbook.worksheets) {
    const type = byName.get(sheet.name);
    if (!type) continue; // A sheet this template never produced — ignored.
    const fields = applicantFields(type);
    const byLabel = new Map(
      fields.map(f => [stripMandatoryMarker(f.label), f.fieldKey])
    );

    const headerRow = sheet.getRow(1);
    const columnFieldKeys = new Map<number, string>();
    let legacyCodeColumn: number | null = null;
    let joinedColumn: number | null = null;
    headerRow.eachCell((cell, colNumber) => {
      const header = String(cell.value ?? '').trim();
      if (header === LEGACY_CODE_COLUMN) {
        legacyCodeColumn = colNumber;
      } else if (header === JOINED_COLUMN) {
        joinedColumn = colNumber;
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
      const values: Record<string, string> = {};
      for (const [colNumber, fieldKey] of columnFieldKeys) {
        values[fieldKey] = cellText(colNumber);
      }
      // A blank row (nothing typed anywhere) is not a record to reject —
      // it is the unused rest of the template, left as it was downloaded.
      const hasContent =
        legacyCode !== '' || Object.values(values).some(v => v !== '');
      if (!hasContent) return;

      rows.push({
        sheet: sheet.name,
        rowNumber,
        legacyCode,
        joinedAt: cellText(joinedColumn),
        values,
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
}

/**
 * Format and mandatory-field checks — legacy_code uniqueness against what
 * is already on file, and against the rest of this same batch, so two rows
 * claiming the same old code are caught before either is written, not
 * after one of them already is.
 */
export async function validateRows(
  rows: ParsedRow[]
): Promise<{ valid: ValidatedRow[]; errors: RowError[] }> {
  const types = await eligibleMembershipTypesForMigration();
  const byName = new Map(types.map(t => [t.name, t]));

  const errors: RowError[] = [];
  const valid: ValidatedRow[] = [];

  const existing = await query<{ legacy_code: string }>(
    `select legacy_code from member where legacy_code is not null`
  );
  const taken = new Set(existing.rows.map(r => r.legacy_code.toLowerCase()));

  // Counted up front so every row sharing a duplicated code is flagged —
  // not just the second one, which would leave the admin unable to tell
  // which of the two rows on screen is the "original" without cross-
  // referencing the sheet themselves.
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    if (row.legacyCode === '') continue;
    const key = row.legacyCode.toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
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
    } else {
      const key = row.legacyCode.toLowerCase();
      if (taken.has(key)) {
        problems.push(
          `${LEGACY_CODE_COLUMN} "${row.legacyCode}" is already on file.`
        );
      } else if ((occurrences.get(key) ?? 0) > 1) {
        problems.push(
          `${LEGACY_CODE_COLUMN} "${row.legacyCode}" appears more than once ` +
            'in this sheet.'
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

    if (problems.length > 0) {
      errors.push({ ...row, message: problems.join(' ') });
      continue;
    }

    valid.push({ ...row, values, membershipTypeId: type.id, joinedAt });
  }

  return { valid, errors };
}

export interface ImportOutcome {
  imported: { legacyCode: string; memberNo: string }[];
  failed: { legacyCode: string; message: string }[];
}

/**
 * Write the batch. Row by row, each its own success or failure — one bad
 * row (a legacy code that raced in between validating and importing) does
 * not undo the rows already written, and the report says exactly which
 * ones need a re-run.
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
    try {
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
        throw new MigrationError('The application just written was not found.');
      }

      const memberNo = await withTransaction(async client => {
        const created = await createMemberFromApplication(
          client,
          loaded,
          actor
        );
        await client.query(
          `update member set legacy_code = $2,
                  joined_at = coalesce($3::timestamptz, joined_at)
            where id = $1`,
          [created.id, row.legacyCode, row.joinedAt]
        );
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
    } catch (error) {
      failed.push({
        legacyCode: row.legacyCode,
        message: error instanceof Error ? error.message : 'Unknown error.',
      });
    }
  }

  return { imported, failed };
}
