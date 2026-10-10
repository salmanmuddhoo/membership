// Configuration export and import (src/lib/config/exchange.ts).
//
// Against a real database, since the interesting behaviour lives in the
// round trip through it: what a re-import of an unmodified export reports,
// what a check run leaves untouched, and what the configuration-audit
// trigger records for a change made through a file rather than a screen.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `exchange_test_${Date.now()}`;
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

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return {
    exchange: await import('./exchange'),
    pool: await import('../db/pool'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let userId: string;
const EMAIL = 'admin@albarakah.mu';

const FULL_PERMISSIONS = new Set([
  'config.manage',
  'fee.manage',
  'bank_account.manage',
  'bank_account.view',
  'retention.manage',
  'role.view',
  'role.manage',
  'segregation.view',
  'segregation.manage',
]);

function principal(permissions: ReadonlySet<string>) {
  return { userId, email: EMAIL, permissions };
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('${EMAIL}', 'Administrator') returning id`
  );
  userId = user.rows[0].id;
}, 60_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// ---------------------------------------------------------------------------
// Workbook helpers: everything a test does to a file between export and
// re-import.
// ---------------------------------------------------------------------------
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs bundles its own @types/node, whose Buffer differs from ours.
  await wb.xlsx.load(buffer as never);
  return wb;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function headerIndex(sheet: ExcelJS.Worksheet): string[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cell.value ?? '');
  });
  return headers;
}

// Sets one cell, found by a key column's value, and returns the edited file.
async function editCell(
  buffer: Buffer,
  sheetName: string,
  keyColumn: string,
  keyValue: string,
  column: string,
  newValue: unknown
): Promise<Buffer> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.getWorksheet(sheetName)!;
  const headers = headerIndex(sheet);
  const keyCol = headers.indexOf(keyColumn);
  const targetCol = headers.indexOf(column);
  let found = false;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (String(row.getCell(keyCol).value ?? '') === keyValue) {
      row.getCell(targetCol).value = newValue as ExcelJS.CellValue;
      found = true;
    }
  });
  if (!found) throw new Error(`row not found: ${sheetName} ${keyValue}`);
  return toBuffer(wb);
}

// Appends a new data row, keyed by header name.
async function appendRow(
  buffer: Buffer,
  sheetName: string,
  values: Record<string, unknown>
): Promise<Buffer> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.getWorksheet(sheetName)!;
  const headers = headerIndex(sheet).slice(1);
  sheet.addRow(headers.map(h => (h in values ? values[h] : null)));
  return toBuffer(wb);
}

// Removes a whole data row from the sheet, found by a key column's value.
async function removeRow(
  buffer: Buffer,
  sheetName: string,
  keyColumn: string,
  keyValue: string
): Promise<Buffer> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.getWorksheet(sheetName)!;
  const headers = headerIndex(sheet);
  const keyCol = headers.indexOf(keyColumn);
  let target = -1;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || target !== -1) return;
    if (String(row.getCell(keyCol).value ?? '') === keyValue)
      target = rowNumber;
  });
  if (target === -1) throw new Error(`row not found: ${sheetName} ${keyValue}`);
  sheet.spliceRows(target, 1);
  return toBuffer(wb);
}

function cellText(cell: ExcelJS.CellValue): string {
  return cell === null || cell === undefined ? '' : String(cell);
}

describe('exportConfiguration', () => {
  it('writes every configuration sheet, in order, each with a header row, including a known seeded setting', async () => {
    const { exchange } = await load();
    const buffer = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const wb = await loadWorkbook(buffer);

    expect(wb.worksheets.map(s => s.name)).toEqual(
      exchange.CONFIGURATION_SHEETS
    );

    for (const sheet of wb.worksheets) {
      const header = headerIndex(sheet).filter(Boolean);
      expect(header.length, sheet.name).toBeGreaterThan(0);
    }

    const settings = wb.getWorksheet('Settings')!;
    const rows: string[][] = [];
    settings.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push([1, 2, 3, 4].map(i => cellText(row.getCell(i).value)));
    });
    const dormancy = rows.find(r => r[0] === 'dormancy.months');
    expect(dormancy).toBeDefined();
    expect(dormancy![1]).toBe('12');
    expect(dormancy![2]).toBe('number');
  });
});

describe('importConfiguration: round trip', () => {
  it('reports no additions and no changes when re-importing an unmodified export, with apply:false', async () => {
    const { exchange } = await load();
    const buffer = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: false }
    );

    expect(outcome.applied).toBe(false);
    expect(outcome.sheets.map(s => s.sheet)).toEqual(
      exchange.CONFIGURATION_SHEETS
    );
    for (const sheet of outcome.sheets) {
      expect(sheet.added, sheet.sheet).toBe(0);
      expect(sheet.changed, sheet.sheet).toBe(0);
    }
  });
});

describe('importConfiguration: apply:false checks without changing anything', () => {
  it('reports the change but leaves the database as it was', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await editCell(
      before,
      'Payment methods',
      'Code',
      'cash',
      'Name',
      'Cash (renamed)'
    );

    const outcome = await exchange.importConfiguration(
      edited,
      principal(FULL_PERMISSIONS),
      { apply: false }
    );
    expect(outcome.applied).toBe(false);
    const paymentMethods = outcome.sheets.find(
      s => s.sheet === 'Payment methods'
    )!;
    expect(paymentMethods.changed).toBe(1);

    const row = await run(
      appUrl,
      `select name from payment_method where code = 'cash'`
    );
    expect(row.rows[0].name).toBe('Cash');
  });
});

describe('importConfiguration: apply:true applies and audits the change', () => {
  it('updates the database and records an audit event for the row and one for the import', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await editCell(
      before,
      'Payment methods',
      'Code',
      'cash',
      'Name',
      'Cash (renamed)'
    );

    const outcome = await exchange.importConfiguration(
      edited,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(outcome.applied).toBe(true);
    const paymentMethods = outcome.sheets.find(
      s => s.sheet === 'Payment methods'
    )!;
    expect(paymentMethods.changed).toBe(1);

    const row = await run(
      appUrl,
      `select name from payment_method where code = 'cash'`
    );
    expect(row.rows[0].name).toBe('Cash (renamed)');

    const rowAudit = await run(
      appUrl,
      `select actor_description from audit_event
        where action = 'config.payment_method.update'
        order by occurred_at desc limit 1`
    );
    expect(rowAudit.rowCount).toBe(1);
    expect(rowAudit.rows[0].actor_description).toContain(
      '(configuration import)'
    );

    const importAudit = await run(
      appUrl,
      `select count(*) as n from audit_event where action = 'config.import'`
    );
    expect(Number(importAudit.rows[0].n)).toBe(1);
  });
});

describe('importConfiguration: adding a row', () => {
  it('adds a new document type', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await appendRow(before, 'Document types', {
      Code: 'test_doc',
      Name: 'Test document',
      Description: '',
      'Tracks expiry': false,
      Active: true,
    });

    const outcome = await exchange.importConfiguration(
      edited,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    const documentTypes = outcome.sheets.find(
      s => s.sheet === 'Document types'
    )!;
    expect(documentTypes.added).toBe(1);

    const row = await run(
      appUrl,
      `select name, tracks_expiry, is_active from document_type where code = 'test_doc'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].name).toBe('Test document');
    expect(row.rows[0].tracks_expiry).toBe(false);
    expect(row.rows[0].is_active).toBe(true);
  });
});

describe('importConfiguration: references by code', () => {
  it('adds a checklist item referencing an existing checklist and the new document type, and refuses one referencing an unknown checklist while applying nothing else from the file', async () => {
    const { exchange } = await load();
    let buffer = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    buffer = await appendRow(buffer, 'Checklist items', {
      Checklist: 'individual_kyc',
      'Document type': 'test_doc',
      Subject: 'applicant',
      Requirement: 'optional',
      'Sort order': 99,
    });
    buffer = await appendRow(buffer, 'Checklist items', {
      Checklist: 'no_such_checklist',
      'Document type': 'test_doc',
      Subject: 'applicant',
      Requirement: 'optional',
      'Sort order': 100,
    });
    // A change elsewhere in the same file, which the failed import must not
    // apply either.
    buffer = await editCell(
      buffer,
      'Payment methods',
      'Code',
      'cheque',
      'Name',
      'Cheque (should not apply)'
    );

    let thrown: unknown;
    try {
      await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
        apply: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
    const problems = (thrown as InstanceType<typeof exchange.ConfigImportError>)
      .problems;
    expect(
      problems.some(
        p =>
          p.sheet === 'Checklist items' && /no_such_checklist/.test(p.message)
      )
    ).toBe(true);

    // Nothing from the file was applied: not the valid checklist item...
    const item = await run(
      appUrl,
      `select 1 from document_checklist_item i
         join document_checklist c on c.id = i.checklist_id
         join document_type d on d.id = i.document_type_id
        where c.code = 'individual_kyc' and d.code = 'test_doc'`
    );
    expect(item.rowCount).toBe(0);

    // ...nor the unrelated Name change.
    const cheque = await run(
      appUrl,
      `select name from payment_method where code = 'cheque'`
    );
    expect(cheque.rows[0].name).toBe('Cheque');
  });
});

describe('importConfiguration: fees publish a new version', () => {
  it('publishes a new fee_schedule_version when an amount changes, superseding the old one', async () => {
    const { exchange } = await load();
    const before = await run(
      appUrl,
      `select v.id, v.version_no
         from fee_schedule s
         join fee_schedule_version v
           on v.schedule_id = s.id and v.superseded_at is null
        where s.code = 'individual_membership'`
    );
    const previousVersionId = before.rows[0].id;
    const previousVersionNo = Number(before.rows[0].version_no);

    const buffer = await editCell(
      await exchange.exportConfiguration(principal(FULL_PERMISSIONS)),
      'Fees',
      'Component',
      'entrance',
      'Amount',
      1600
    );

    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    const fees = outcome.sheets.find(s => s.sheet === 'Fees')!;
    expect(fees.changed).toBeGreaterThanOrEqual(1);

    const superseded = await run(
      appUrl,
      `select superseded_at from fee_schedule_version where id = $1`,
      [previousVersionId]
    );
    expect(superseded.rows[0].superseded_at).not.toBeNull();

    const current = await run(
      appUrl,
      `select v.version_no, c.code, c.amount::text as amount, c.requirement
         from fee_schedule s
         join fee_schedule_version v
           on v.schedule_id = s.id and v.superseded_at is null
         join fee_component c on c.version_id = v.id
        where s.code = 'individual_membership'
        order by c.sort_order`
    );
    expect(Number(current.rows[0].version_no)).toBe(previousVersionNo + 1);
    const entrance = current.rows.find(
      (r: { code: string }) => r.code === 'entrance'
    );
    expect(entrance.amount).toBe('1600.00');
  });
});

describe('importConfiguration: permissions', () => {
  it('refuses a fee change from a principal without fee.manage, naming the Fees sheet', async () => {
    const { exchange } = await load();
    const buffer = await editCell(
      await exchange.exportConfiguration(principal(FULL_PERMISSIONS)),
      'Fees',
      'Component',
      'entrance',
      'Amount',
      1700
    );
    const restricted = principal(new Set(['config.manage']));

    let thrown: unknown;
    try {
      await exchange.importConfiguration(buffer, restricted, { apply: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
    const problems = (thrown as InstanceType<typeof exchange.ConfigImportError>)
      .problems;
    expect(problems.some(p => p.sheet === 'Fees')).toBe(true);
  });

  it('refuses any import from a principal without config.manage', async () => {
    const { exchange } = await load();
    const buffer = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const noAccess = principal(new Set());

    await expect(
      exchange.importConfiguration(buffer, noAccess, { apply: false })
    ).rejects.toBeInstanceOf(exchange.ConfigImportError);
  });
});

describe('importConfiguration: retention bounds', () => {
  it('refuses a period below the allowed minimum, naming the range', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const wb = await loadWorkbook(before);
    const sheet = wb.getWorksheet('Retention')!;
    const headers = headerIndex(sheet);
    const codeCol = headers.indexOf('Code');
    const monthsCol = headers.indexOf('Months');
    let code = '';
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || code) return;
      code = String(row.getCell(codeCol).value ?? '');
      row.getCell(monthsCol).value = 1;
    });
    const buffer = await toBuffer(wb);
    expect(code).not.toBe('');

    let thrown: unknown;
    try {
      await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
        apply: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
    const problems = (thrown as InstanceType<typeof exchange.ConfigImportError>)
      .problems;
    expect(
      problems.some(
        p =>
          p.sheet === 'Retention' &&
          /6 and 600|between 6 and 600/.test(p.message)
      )
    ).toBe(true);
  });
});

describe('importConfiguration: an unknown sheet name', () => {
  it('refuses a workbook carrying a sheet that is not a configuration sheet', async () => {
    const { exchange } = await load();
    const buffer = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const wb = await loadWorkbook(buffer);
    const extra = wb.addWorksheet('Not A Real Sheet');
    extra.addRow(['Anything']);
    const edited = await toBuffer(wb);

    let thrown: unknown;
    try {
      await exchange.importConfiguration(edited, principal(FULL_PERMISSIONS), {
        apply: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
    const problems = (thrown as InstanceType<typeof exchange.ConfigImportError>)
      .problems;
    expect(
      problems.some(p => /Not a configuration sheet/.test(p.message))
    ).toBe(true);
  });
});

describe('importConfiguration: nothing is ever deleted', () => {
  it('leaves a payment method in the database when its row is removed from the file', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await removeRow(before, 'Payment methods', 'Code', 'other');

    const outcome = await exchange.importConfiguration(
      edited,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(outcome.applied).toBe(true);

    const row = await run(
      appUrl,
      `select 1 from payment_method where code = 'other'`
    );
    expect(row.rowCount).toBe(1);
  });
});

describe('importConfiguration: settings', () => {
  it('updates the value of a numeric setting', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await editCell(
      before,
      'Settings',
      'Key',
      'dormancy.months',
      'Value',
      18
    );

    const outcome = await exchange.importConfiguration(
      edited,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    const settings = outcome.sheets.find(s => s.sheet === 'Settings')!;
    expect(settings.changed).toBe(1);

    const row = await run(
      appUrl,
      `select value from config_entry where key = 'dormancy.months'`
    );
    expect(row.rows[0].value).toBe(18);
  });

  it('refuses an unknown key', async () => {
    const { exchange } = await load();
    const before = await exchange.exportConfiguration(
      principal(FULL_PERMISSIONS)
    );
    const edited = await appendRow(before, 'Settings', {
      Key: 'not.a.real.setting',
      Value: 1,
      Type: 'number',
      Description: 'x',
    });

    let thrown: unknown;
    try {
      await exchange.importConfiguration(edited, principal(FULL_PERMISSIONS), {
        apply: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
    const problems = (thrown as InstanceType<typeof exchange.ConfigImportError>)
      .problems;
    expect(
      problems.some(
        p => p.sheet === 'Settings' && /not.a.real.setting/.test(p.message)
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The member app, roles and segregation sheets
// ---------------------------------------------------------------------------
type Exchange = Awaited<ReturnType<typeof load>>['exchange'];

// The problems a refused import reports; fails if it was not refused.
async function refusal(
  exchange: Exchange,
  buffer: Buffer,
  who: ReturnType<typeof principal> = principal(FULL_PERMISSIONS)
) {
  let thrown: unknown;
  try {
    await exchange.importConfiguration(buffer, who, { apply: true });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(exchange.ConfigImportError);
  return (thrown as InstanceType<typeof exchange.ConfigImportError>).problems;
}

async function exported(exchange: Exchange, who = FULL_PERMISSIONS) {
  return exchange.exportConfiguration(principal(who));
}

function sheetOutcome(
  outcome: Awaited<ReturnType<Exchange['importConfiguration']>>,
  name: string
) {
  return outcome.sheets.find(s => s.sheet === name)!;
}

function bankRow(code: string, extra: Record<string, unknown> = {}) {
  return {
    Code: code,
    Name: `Account ${code}`,
    Bank: 'Test bank',
    'Account number': `00-${code}`,
    Currency: 'MUR',
    'Opening balance': 0,
    'Opening date': '2026-01-01',
    Active: true,
    'Member app deposits': false,
    'Sort order': 0,
    ...extra,
  };
}

async function memberAppAccounts() {
  const rows = await run(
    appUrl,
    `select code from bank_account where is_member_app_default order by code`
  );
  return rows.rows.map((r: { code: string }) => r.code);
}

describe('importConfiguration: bank accounts and member app deposits', () => {
  it('adds an account holding member app deposits, and a second one takes the mark from it', async () => {
    const { exchange } = await load();
    let buffer = await exported(exchange);
    buffer = await appendRow(
      buffer,
      'Bank accounts',
      bankRow('app_a', { 'Member app deposits': true })
    );
    buffer = await appendRow(buffer, 'Bank accounts', bankRow('app_b'));
    await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
      apply: true,
    });
    expect(await memberAppAccounts()).toEqual(['app_a']);

    // The file names only the new holder; the old one is not in it.
    let next = await exported(exchange);
    next = await editCell(
      next,
      'Bank accounts',
      'Code',
      'app_b',
      'Member app deposits',
      true
    );
    next = await removeRow(next, 'Bank accounts', 'Code', 'app_a');
    const outcome = await exchange.importConfiguration(
      next,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Bank accounts').changed).toBe(1);
    expect(await memberAppAccounts()).toEqual(['app_b']);
  });

  it('moves the mark when the file also unmarks the old holder', async () => {
    const { exchange } = await load();
    let buffer = await exported(exchange);
    buffer = await editCell(
      buffer,
      'Bank accounts',
      'Code',
      'app_b',
      'Member app deposits',
      false
    );
    buffer = await editCell(
      buffer,
      'Bank accounts',
      'Code',
      'app_a',
      'Member app deposits',
      true
    );
    await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
      apply: true,
    });
    expect(await memberAppAccounts()).toEqual(['app_a']);
  });

  it('refuses two rows set to take member app deposits, and applies nothing', async () => {
    const { exchange } = await load();
    let buffer = await exported(exchange);
    buffer = await editCell(
      buffer,
      'Bank accounts',
      'Code',
      'app_a',
      'Member app deposits',
      true
    );
    buffer = await editCell(
      buffer,
      'Bank accounts',
      'Code',
      'app_b',
      'Member app deposits',
      true
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Bank accounts' &&
          p.message === 'Only one row may have Member app deposits set.'
      )
    ).toBe(true);
    expect(await memberAppAccounts()).toEqual(['app_a']);
  });

  it('refuses member app deposits on an inactive account', async () => {
    const { exchange } = await load();
    let buffer = await exported(exchange);
    buffer = await appendRow(
      buffer,
      'Bank accounts',
      bankRow('app_idle', { Active: false, 'Member app deposits': true })
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Bank accounts' &&
          p.message === 'Only an active account can take member app deposits.'
      )
    ).toBe(true);
    expect(await memberAppAccounts()).toEqual(['app_a']);
  });
});

describe('importConfiguration: partner outlets', () => {
  const outlet = (extra: Record<string, unknown> = {}) => ({
    Name: 'Test Bakery',
    Logo: 'https://example.com/bakery.png',
    Category: 'Food',
    'Discount %': 10,
    Description: 'Fresh bread',
    Address: null,
    Link: null,
    Partner: true,
    Active: true,
    'Sort order': 1,
    ...extra,
  });

  it('adds an outlet, storing the category lower-cased', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(
      await exported(exchange),
      'Partner outlets',
      outlet()
    );
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Partner outlets').added).toBe(1);

    const row = await run(
      appUrl,
      `select category, logo_url, discount_percent::text as discount, is_partner
         from card_outlet where name = 'Test Bakery'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].category).toBe('food');
    expect(row.rows[0].logo_url).toBe('https://example.com/bakery.png');
    expect(row.rows[0].discount).toBe('10.00');
    expect(row.rows[0].is_partner).toBe(true);
  });

  it('refuses a logo that is not an https address', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(
      await exported(exchange),
      'Partner outlets',
      outlet({ Name: 'Insecure Shop', Logo: 'http://example.com/logo.png' })
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Partner outlets' &&
          p.message === 'The logo must be an https:// address.'
      )
    ).toBe(true);
    const row = await run(
      appUrl,
      `select 1 from card_outlet where name = 'Insecure Shop'`
    );
    expect(row.rowCount).toBe(0);
  });
});

describe('importConfiguration: promotions', () => {
  const promotion = (extra: Record<string, unknown> = {}) => ({
    Title: 'Eid offer',
    Text: 'Save on your card',
    Picture: 'https://example.com/eid.png',
    Link: null,
    'Link text': null,
    Colour: null,
    Starts: null,
    Ends: null,
    Active: true,
    'Sort order': 1,
    ...extra,
  });

  it('adds a promotion', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(
      await exported(exchange),
      'Promotions',
      promotion()
    );
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Promotions').added).toBe(1);

    const row = await run(
      appUrl,
      `select body, image_url, is_active from app_promotion where title = 'Eid offer'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].body).toBe('Save on your card');
    expect(row.rows[0].image_url).toBe('https://example.com/eid.png');
    expect(row.rows[0].is_active).toBe(true);
  });

  it('refuses a promotion without a picture', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(
      await exported(exchange),
      'Promotions',
      promotion({ Title: 'No picture', Picture: null })
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Promotions' &&
          p.message ===
            'A picture is required: the app shows the picture alone.'
      )
    ).toBe(true);
    const row = await run(
      appUrl,
      `select 1 from app_promotion where title = 'No picture'`
    );
    expect(row.rowCount).toBe(0);
  });
});

describe('importConfiguration: two rows in the database share a key', () => {
  it('refuses to import a name that more than one outlet already has', async () => {
    const { exchange, pool } = await load();
    await pool.withConfigurationActor(
      { userId, description: 'test setup' },
      async client => {
        for (const n of [1, 2]) {
          await client.query(
            `insert into card_outlet (name, logo_url, category, discount_percent)
             values ('Twin Cafe', $1, 'food', 5)`,
            [`https://example.com/twin${n}.png`]
          );
        }
      }
    );

    const buffer = await appendRow(
      await exported(exchange),
      'Partner outlets',
      {
        Name: 'Twin Cafe',
        Logo: 'https://example.com/twin.png',
        Category: 'food',
        'Discount %': 5,
        Description: '',
        Partner: false,
        Active: true,
        'Sort order': 0,
      }
    );
    try {
      const problems = await refusal(exchange, buffer);
      expect(
        problems.some(
          p =>
            p.sheet === 'Partner outlets' &&
            p.message.startsWith('More than one already has this name.')
        )
      ).toBe(true);
    } finally {
      // Later tests export the whole configuration, which the twins would
      // make unimportable.
      await pool.withConfigurationActor(
        { userId, description: 'test cleanup' },
        client =>
          client.query(`delete from card_outlet where name = 'Twin Cafe'`)
      );
    }
  });
});

describe('importConfiguration: roles', () => {
  it('reports no change on Roles or Segregation rules when re-importing an unmodified export', async () => {
    const { exchange } = await load();
    const outcome = await exchange.importConfiguration(
      await exported(exchange),
      principal(FULL_PERMISSIONS),
      { apply: false }
    );
    for (const name of ['Roles', 'Segregation rules']) {
      const sheet = sheetOutcome(outcome, name);
      expect(sheet.added, name).toBe(0);
      expect(sheet.changed, name).toBe(0);
    }
  });

  const rolePermissions = async (code: string) =>
    (
      await run(
        appUrl,
        `select p.code from role r
           join role_permission rp on rp.role_id = r.id
           join permission p on p.id = rp.permission_id
          where r.code = $1 order by p.code collate "C"`,
        [code]
      )
    ).rows.map((r: { code: string }) => r.code);

  const auditCount = async (action: string) =>
    Number(
      (
        await run(
          appUrl,
          `select count(*) as n from audit_event where action = $1`,
          [action]
        )
      ).rows[0].n
    );

  it('lists a seeded role with its permissions, one per line and sorted', async () => {
    const { exchange } = await load();
    const wb = await loadWorkbook(await exported(exchange));
    const sheet = wb.getWorksheet('Roles')!;
    expect(headerIndex(sheet).slice(1)).toEqual([
      'Code',
      'Name',
      'Description',
      'System',
      'Permissions',
    ]);
    let cell = '';
    sheet.eachRow((row, rowNumber) => {
      if (
        rowNumber > 1 &&
        cellText(row.getCell(1).value) === 'system_administrator'
      )
        cell = cellText(row.getCell(5).value);
    });
    const lines = cell.split('\n');
    expect(lines).toEqual([...lines].sort());
    expect(lines).toEqual(
      expect.arrayContaining(['role.manage', 'role.view', 'segregation.manage'])
    );
    expect(lines).toEqual(await rolePermissions('system_administrator'));
  });

  it('leaves the Roles and Segregation sheets out for a principal who can see neither', async () => {
    const { exchange } = await load();
    const wb = await loadWorkbook(
      await exported(exchange, new Set(['config.manage']))
    );
    expect(wb.getWorksheet('Roles')).toBeUndefined();
    expect(wb.getWorksheet('Segregation rules')).toBeUndefined();
  });

  it('adds a new role with permissions, and audits it', async () => {
    const { exchange } = await load();
    const before = await auditCount('role.created');
    const buffer = await appendRow(await exported(exchange), 'Roles', {
      Code: 'test_clerk',
      Name: 'Test clerk',
      Description: 'For tests',
      Permissions: 'role.view\nbank_account.view',
    });
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Roles').added).toBe(1);
    expect(await rolePermissions('test_clerk')).toEqual([
      'bank_account.view',
      'role.view',
    ]);
    expect(await auditCount('role.created')).toBe(before + 1);
  });

  it('revokes a permission left out of the cell, and audits the change', async () => {
    const { exchange } = await load();
    const before = await auditCount('role.permissions_changed');
    const buffer = await editCell(
      await exported(exchange),
      'Roles',
      'Code',
      'test_clerk',
      'Permissions',
      'role.view'
    );
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Roles').changed).toBe(1);
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);
    expect(await auditCount('role.permissions_changed')).toBe(before + 1);
  });

  it('records a name change as role.updated', async () => {
    const { exchange } = await load();
    const before = await auditCount('role.updated');
    const buffer = await editCell(
      await exported(exchange),
      'Roles',
      'Code',
      'test_clerk',
      'Name',
      'Test clerk (renamed)'
    );
    await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
      apply: true,
    });
    const row = await run(
      appUrl,
      `select name from role where code = 'test_clerk'`
    );
    expect(row.rows[0].name).toBe('Test clerk (renamed)');
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);
    expect(await auditCount('role.updated')).toBe(before + 1);
  });

  it('leaves a role untouched when it is absent from the sheet', async () => {
    const { exchange } = await load();
    const buffer = await removeRow(
      await exported(exchange),
      'Roles',
      'Code',
      'test_clerk'
    );
    await exchange.importConfiguration(buffer, principal(FULL_PERMISSIONS), {
      apply: true,
    });
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);
  });

  it('keeps a role permissions when the sheet has no Permissions column', async () => {
    const { exchange } = await load();
    const wb = await loadWorkbook(await exported(exchange));
    const sheet = wb.getWorksheet('Roles')!;
    sheet.spliceColumns(5, 1);
    const buffer = await toBuffer(wb);
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Roles').changed).toBe(0);
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);
    expect(await rolePermissions('system_administrator')).toEqual(
      expect.arrayContaining(['role.manage'])
    );
  });

  it('refuses an unknown permission code and applies nothing from the file', async () => {
    const { exchange } = await load();
    let buffer = await editCell(
      await exported(exchange),
      'Roles',
      'Code',
      'test_clerk',
      'Permissions',
      'role.view\nnot.a.permission'
    );
    buffer = await editCell(
      buffer,
      'Payment methods',
      'Code',
      'cheque',
      'Name',
      'Cheque (should not apply)'
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Roles' &&
          p.message === 'No such permission: not.a.permission.'
      )
    ).toBe(true);
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);
    const cheque = await run(
      appUrl,
      `select name from payment_method where code = 'cheque'`
    );
    expect(cheque.rows[0].name).toBe('Cheque');
  });

  it('refuses a new role whose code is not valid', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(await exported(exchange), 'Roles', {
      Code: 'Bad Code',
      Name: 'Bad',
      Permissions: 'role.view',
    });
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Roles' &&
          p.message ===
            'A role code must be lower-case letters, digits and underscores.'
      )
    ).toBe(true);
  });

  it('refuses a change, and an addition, without role.manage', async () => {
    const { exchange } = await load();
    const viewer = principal(
      new Set(['config.manage', 'role.view', 'bank_account.view'])
    );
    const changed = await editCell(
      await exchange.exportConfiguration(viewer),
      'Roles',
      'Code',
      'test_clerk',
      'Permissions',
      'role.view\nrole.manage'
    );
    const changeProblems = await refusal(exchange, changed, viewer);
    expect(
      changeProblems.some(
        p => p.sheet === 'Roles' && p.message === 'You may not change this.'
      )
    ).toBe(true);
    expect(await rolePermissions('test_clerk')).toEqual(['role.view']);

    const added = await appendRow(
      await exchange.exportConfiguration(viewer),
      'Roles',
      { Code: 'sneaky_role', Name: 'Sneaky', Permissions: 'role.view' }
    );
    const addProblems = await refusal(exchange, added, viewer);
    expect(
      addProblems.some(
        p => p.sheet === 'Roles' && p.message === 'You may not add this.'
      )
    ).toBe(true);
    const row = await run(
      appUrl,
      `select 1 from role where code = 'sneaky_role'`
    );
    expect(row.rowCount).toBe(0);
  });
});

describe('importConfiguration: segregation rules', () => {
  const RULE = {
    Record: 'membership_application',
    'Earlier action': 'membership.application.captured',
    'Later action': 'membership.application.reviewed',
  };

  async function editRule(buffer: Buffer, value: unknown): Promise<Buffer> {
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet('Segregation rules')!;
    const headers = headerIndex(sheet);
    let found = false;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const same = Object.entries(RULE).every(
        ([header, expected]) =>
          cellText(row.getCell(headers.indexOf(header)).value) === expected
      );
      if (same) {
        row.getCell(headers.indexOf('On')).value = value as ExcelJS.CellValue;
        found = true;
      }
    });
    if (!found) throw new Error('seeded rule not found');
    return toBuffer(wb);
  }

  const isEnabled = async () =>
    (
      await run(
        appUrl,
        `select is_enabled from segregation_rule
          where entity_type = $1 and earlier_action = $2 and later_action = $3`,
        [RULE.Record, RULE['Earlier action'], RULE['Later action']]
      )
    ).rows[0].is_enabled;

  const auditCount = async (action: string) =>
    Number(
      (
        await run(
          appUrl,
          `select count(*) as n from audit_event where action = $1`,
          [action]
        )
      ).rows[0].n
    );

  it('switches an existing rule off, and back on, with an audit event each time', async () => {
    const { exchange } = await load();
    expect(await isEnabled()).toBe(true);

    const off = await exchange.importConfiguration(
      await editRule(await exported(exchange), false),
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(off, 'Segregation rules').changed).toBe(1);
    expect(await isEnabled()).toBe(false);
    expect(await auditCount('segregation.rule.disabled')).toBe(1);

    const on = await exchange.importConfiguration(
      await editRule(await exported(exchange), true),
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(on, 'Segregation rules').changed).toBe(1);
    expect(await isEnabled()).toBe(true);
    expect(await auditCount('segregation.rule.enabled')).toBe(1);
  });

  it('refuses a switch without segregation.manage', async () => {
    const { exchange } = await load();
    const viewer = principal(new Set(['config.manage', 'segregation.view']));
    const buffer = await editRule(
      await exchange.exportConfiguration(viewer),
      false
    );
    const problems = await refusal(exchange, buffer, viewer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Segregation rules' &&
          p.message === 'You may not change this.'
      )
    ).toBe(true);
    expect(await isEnabled()).toBe(true);
  });

  it('refuses a new pair the Segregation page does not offer', async () => {
    const { exchange } = await load();
    const buffer = await appendRow(
      await exported(exchange),
      'Segregation rules',
      {
        Record: 'document',
        'Earlier action': 'document.verified',
        'Later action': 'document.filed',
        On: true,
      }
    );
    const problems = await refusal(exchange, buffer);
    expect(
      problems.some(
        p =>
          p.sheet === 'Segregation rules' &&
          p.message === 'Not a rule the Segregation page offers.'
      )
    ).toBe(true);
  });

  it('adds a pair the page offers, with the page description, and audits it', async () => {
    const { exchange, pool } = await load();
    const PAIR = `entity_type = 'transaction'
              and earlier_action = 'transaction.captured'
              and later_action = 'transaction.voided'`;
    // Whether the pair was seeded is not what is under test.
    await pool.withConfigurationActor(
      { userId, description: 'test setup' },
      client => client.query(`delete from segregation_rule where ${PAIR}`)
    );
    const buffer = await appendRow(
      await exported(exchange),
      'Segregation rules',
      {
        Record: 'transaction',
        'Earlier action': 'transaction.captured',
        'Later action': 'transaction.voided',
        On: true,
      }
    );
    const before = await auditCount('segregation.rule.added');
    const outcome = await exchange.importConfiguration(
      buffer,
      principal(FULL_PERMISSIONS),
      { apply: true }
    );
    expect(sheetOutcome(outcome, 'Segregation rules').added).toBe(1);
    const rows = (
      await run(
        appUrl,
        `select description, is_enabled from segregation_rule where ${PAIR}`
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_enabled).toBe(true);
    expect(rows[0].description).toMatch(
      /^Whoever captured a transaction may not /
    );
    expect(await auditCount('segregation.rule.added')).toBe(before + 1);
  });
});
