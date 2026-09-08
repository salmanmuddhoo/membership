// M7 · Legacy migration, first increment — against a real database, since
// what is under test is the template's own field configuration, the Excel
// round trip, and createMemberFromApplication actually being invoked (an
// imported member gets the same Shares/MSA accounts an approval always
// opens).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `migration_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let openPool: { closePool: () => Promise<void> } | undefined;
async function closeOpenPool() {
  const previous = openPool;
  openPool = undefined;
  await previous?.closePool();
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return import('./members');
}

let adminUserId: string;
const actor = { userId: '', email: 'admin@albarakah.mu' };
const MIGRATE_PERMISSIONS = new Set(['system.migrate_members']);

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator')
     returning id`
  );
  adminUserId = user.rows[0].id;
  actor.userId = adminUserId;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// Fills a workbook's named sheet the way a real spreadsheet application
// would: by column header, so a template regenerated in a different field
// order still round-trips correctly.
async function fillSheet(
  buffer: Buffer,
  sheetName: string,
  data: Record<string, string>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.getWorksheet(sheetName)!;
  const headerRow = sheet.getRow(1);
  const columnFor = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    // Mandatory columns carry buildImportTemplate's own " *" marker — the
    // caller's data is keyed by the plain label, same as a person reading
    // the sheet would type under either.
    columnFor.set(
      String(cell.value ?? '')
        .trim()
        .replace(/\s*\*\s*$/, ''),
      colNumber
    );
  });
  // Row 2, not sheet.addRow: the template pre-applies data validation down
  // to row 500 for choice fields (buildImportTemplate), which addRow would
  // treat as already-occupied and append after — exactly what a person
  // typing into the downloaded template never does.
  const row = sheet.getRow(2);
  for (const [header, value] of Object.entries(data)) {
    const col = columnFor.get(header);
    if (col) row.getCell(col).value = value;
  }
  row.commit();
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

describe('eligibleMembershipTypesForMigration', () => {
  it('includes Individual and Corporate, excludes Minor (needs a guardian)', async () => {
    const { eligibleMembershipTypesForMigration } = await load();
    const types = await eligibleMembershipTypesForMigration();
    const codes = types.map(t => t.code);
    expect(codes).toContain('individual');
    expect(codes).toContain('corporate');
    expect(codes).not.toContain('minor');
  });
});

describe('buildImportTemplate + parseImportFile: the round trip', () => {
  it('produces a sheet per eligible type, read back with the row typed into it', async () => {
    const { buildImportTemplate, parseImportFile } = await load();
    const template = await buildImportTemplate();

    const filled = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-001',
      Surname: 'Peerally',
      Name: 'Fatimah',
      NIC: 'B1234567890123',
      Gender: 'Female',
      Address: '12 Royal Road, Rose Hill',
      Mobile: '57891234',
    });

    const rows = await parseImportFile(filled);
    expect(rows).toHaveLength(1);
    expect(rows[0].sheet).toBe('Individual');
    expect(rows[0].legacyCode).toBe('LEG-001');
    expect(rows[0].values.surname).toBe('Peerally');
    expect(rows[0].values.name).toBe('Fatimah');
    expect(rows[0].values.mobile).toBe('57891234'); // normalised at validate, not parse
  });

  it('ignores an untouched row left over from the template', async () => {
    const { buildImportTemplate, parseImportFile } = await load();
    const template = await buildImportTemplate();
    const rows = await parseImportFile(template);
    expect(rows).toEqual([]);
  });
});

describe('validateRows', () => {
  it('accepts a complete row and normalises the mobile number', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-100',
      Surname: 'Ramtoola',
      Name: 'Zahra',
      NIC: 'B9999999999999',
      Gender: 'Female',
      Address: '1 Church Street',
      Mobile: '57891234',
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].values.mobile).toBe('+23057891234');
  });

  it('rejects a row missing a mandatory field', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-101',
      Surname: 'Ramtoola',
      // Name left out — mandatory.
      NIC: 'B9999999999998',
      Gender: 'Female',
      Address: '1 Church Street',
      Mobile: '57891234',
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(valid).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Name is required/);
  });

  it('rejects a telephone number that cannot be placed', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-102',
      Surname: 'Ramtoola',
      Name: 'Yusuf',
      NIC: 'B9999999999997',
      Gender: 'Male',
      Address: '1 Church Street',
      Mobile: 'not a number',
    });
    const { errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Mobile/);
  });

  it('rejects two rows in the same batch claiming the same legacy code', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const template = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as any);
    const sheet = workbook.getWorksheet('Individual')!;
    const columnFor = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, col) =>
      columnFor.set(
        String(cell.value ?? '')
          .trim()
          .replace(/\s*\*\s*$/, ''),
        col
      )
    );
    let nextRow = 2;
    const putRow = (data: Record<string, string>) => {
      // Explicit row numbers, not addRow — see fillSheet's own comment: the
      // template's data validation reaches row 500, which addRow treats as
      // already occupied.
      const row = sheet.getRow(nextRow++);
      for (const [header, value] of Object.entries(data)) {
        const col = columnFor.get(header);
        if (col) row.getCell(col).value = value;
      }
      row.commit();
    };
    putRow({
      'Legacy Member Code': 'LEG-DUP',
      Surname: 'A',
      Name: 'One',
      NIC: 'B1',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891234',
    });
    putRow({
      'Legacy Member Code': 'LEG-DUP',
      Surname: 'B',
      Name: 'Two',
      NIC: 'B2',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891235',
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const { errors } = await validateRows(await parseImportFile(buffer));
    expect(errors).toHaveLength(2);
    expect(errors.every(e => /appears more than once/.test(e.message))).toBe(
      true
    );
  });
});

describe('importMembers', () => {
  it('refuses without system.migrate_members', async () => {
    const { importMembers } = await load();
    await expect(importMembers([], actor, new Set())).rejects.toThrowError(
      /permission/i
    );
  });

  it('creates an approved member with accounts, legacy code and an audit entry', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-200',
      'Joined Date (optional)': '2019-03-15',
      Surname: 'Joomun',
      Name: 'Ismail',
      NIC: 'B8888888888888',
      Gender: 'Male',
      Address: '5 Sir William Newton Street',
      Mobile: '57891236',
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.imported[0].legacyCode).toBe('LEG-200');

    const member = await run(
      appUrl,
      `select member_no, legacy_code, status, joined_at,
              (select status from membership_application
                where id = m.application_id) as application_status
         from member m where legacy_code = 'LEG-200'`
    );
    expect(member.rows).toHaveLength(1);
    expect(member.rows[0].status).toBe('active');
    expect(member.rows[0].application_status).toBe('approved');
    expect(member.rows[0].member_no).toBe(outcome.imported[0].memberNo);
    expect(new Date(member.rows[0].joined_at).toISOString().slice(0, 10)).toBe(
      '2019-03-15'
    );

    const accounts = await run(
      appUrl,
      `select t.code from account a
         join account_type t on t.id = a.account_type_id
         join member m on m.id = a.member_id
        where m.legacy_code = 'LEG-200'`
    );
    expect(accounts.rows.length).toBeGreaterThan(0);

    const audited = await run(
      appUrl,
      `select action, new_value from audit_event
        where action = 'member.migration.imported'
          and new_value->>'legacyCode' = 'LEG-200'`
    );
    expect(audited.rows).toHaveLength(1);
  });

  it('reports a duplicate legacy code as failed, without losing the rest of the batch', async () => {
    const { eligibleMembershipTypesForMigration, importMembers } = await load();
    const individual = (await eligibleMembershipTypesForMigration()).find(
      t => t.code === 'individual'
    )!;

    // validateRows already refuses this before anything is written (proven
    // above) — this is the database's own unique constraint as the
    // backstop, for two rows racing past that check in the same batch.
    // Both rows are otherwise valid; only the second collides.
    const rowFor = (legacyCode: string, nic: string) => ({
      sheet: 'Individual',
      rowNumber: 2,
      legacyCode,
      joinedAt: null,
      membershipTypeId: individual.id,
      values: {
        surname: 'Test',
        name: 'Duplicate',
        nic,
        gender: 'Male',
        address: 'Addr',
        mobile: '+23057891238',
      },
    });

    const outcome = await importMembers(
      [
        rowFor('LEG-DUP-DB', 'B6666666666661'),
        rowFor('LEG-DUP-DB', 'B6666666666662'),
      ],
      actor,
      MIGRATE_PERMISSIONS
    );

    expect(outcome.imported).toHaveLength(1);
    expect(outcome.imported[0].legacyCode).toBe('LEG-DUP-DB');
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].legacyCode).toBe('LEG-DUP-DB');
  });
});
