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

// account_type is a configuration table (CLAUDE.md) — its own history
// trigger needs albarakah.actor_description set, the same as the
// application does through withConfigurationActor. A fixture that inserts
// one has to say who it is too.
async function runAsConfigurator(
  url: string,
  sql: string,
  params: unknown[] = []
) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
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

// Individual's own Nominee 1 fields (surname, name, NIC, address) are all
// mandatory (migration 0010) — every member-row fixture below that expects
// to validate cleanly has to supply them, the same as it already supplies
// the applicant's own mandatory fields.
const NOMINEE_1 = {
  'Nominee 1 Surname': 'Nominee Surname',
  'Nominee 1 Name': 'Nominee Name',
  'Nominee 1 NIC': 'Nominee NIC',
  'Nominee 1 Address': 'Nominee Address',
};

describe('eligibleMembershipTypesForMigration', () => {
  it('includes Individual, Corporate and Minor', async () => {
    const { eligibleMembershipTypesForMigration } = await load();
    const types = await eligibleMembershipTypesForMigration();
    const codes = types.map(t => t.code);
    expect(codes).toContain('individual');
    expect(codes).toContain('corporate');
    expect(codes).toContain('minor');
  });
});

describe('buildImportTemplate + parseImportFile: the round trip', () => {
  it('produces a sheet per eligible type, read back with the row typed into it', async () => {
    const { buildImportTemplate, parseImportFile } = await load();
    const template = await buildImportTemplate();

    const filled = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-001',
      'AB Number': 'AB1001',
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
    expect(rows[0].abNumber).toBe('AB1001');
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
      'AB Number': 'AB1100',
      Surname: 'Ramtoola',
      Name: 'Zahra',
      NIC: 'B9999999999999',
      Gender: 'Female',
      Address: '1 Church Street',
      Mobile: '57891234',
      ...NOMINEE_1,
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
      'AB Number': 'AB1101',
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
      'AB Number': 'AB1102',
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
      'AB Number': 'AB1201',
      Surname: 'A',
      Name: 'One',
      NIC: 'B1',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891234',
    });
    putRow({
      'Legacy Member Code': 'LEG-DUP',
      'AB Number': 'AB1202',
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
      'AB Number': 'AB1200',
      'Joined Date (optional)': '2019-03-15',
      Surname: 'Joomun',
      Name: 'Ismail',
      NIC: 'B8888888888888',
      Gender: 'Male',
      Address: '5 Sir William Newton Street',
      Mobile: '57891236',
      ...NOMINEE_1,
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
    expect(member.rows[0].member_no).toBe('AB1200');
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

  it('falls back to the AB Number as the legacy code when Legacy Member Code is left blank', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      // No Legacy Member Code — the AB Number already is the system's own
      // unambiguous reference for a member.
      'AB Number': 'AB1250',
      Surname: 'Sooben',
      Name: 'Farah',
      NIC: 'B7777777777779',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891249',
      ...NOMINEE_1,
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);
    expect(valid[0].legacyCode).toBe('AB1250');

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);

    const member = await run(
      appUrl,
      `select member_no, legacy_code from member where member_no = 'AB1250'`
    );
    expect(member.rows).toHaveLength(1);
    expect(member.rows[0].legacy_code).toBe('AB1250');
  });

  it('re-importing an already-migrated legacy code updates the member instead of duplicating it', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-300',
      'AB Number': 'AB1300',
      Surname: 'Auladin',
      Name: 'Rashid',
      NIC: 'B7777777777771',
      Gender: 'Male',
      Address: 'Old Address',
      Mobile: '57891240',
      ...NOMINEE_1,
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    const firstOutcome = await importMembers(
      firstValid,
      actor,
      MIGRATE_PERMISSIONS
    );
    expect(firstOutcome.failed).toEqual([]);

    // Re-run with the same legacy code and AB Number, a corrected address.
    const second = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-300',
      'AB Number': 'AB1300',
      Surname: 'Auladin',
      Name: 'Rashid',
      NIC: 'B7777777777771',
      Gender: 'Male',
      Address: 'Corrected Address',
      Mobile: '57891240',
      ...NOMINEE_1,
    });
    const secondParsed = await validateRows(await parseImportFile(second));
    expect(secondParsed.errors).toEqual([]);
    const secondOutcome = await importMembers(
      secondParsed.valid,
      actor,
      MIGRATE_PERMISSIONS
    );
    expect(secondOutcome.failed).toEqual([]);
    expect(secondOutcome.imported[0].memberNo).toBe('AB1300');

    const members = await run(
      appUrl,
      `select member_no from member where legacy_code = 'LEG-300'`
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].member_no).toBe('AB1300');

    const party = await run(
      appUrl,
      `select p.values ->> 'address' as address
         from application_party p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-300'
          and p.subject = 'applicant' and p.ordinal = 1`
    );
    expect(party.rows[0].address).toBe('Corrected Address');

    const updated = await run(
      appUrl,
      `select 1 from audit_event
        where action = 'member.migration.updated'
          and new_value->>'legacyCode' = 'LEG-300'`
    );
    expect(updated.rows).toHaveLength(1);
  });

  it('rejects a re-import whose AB Number disagrees with the one on file', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-301',
      'AB Number': 'AB1301',
      Surname: 'Bhurtun',
      Name: 'Aslam',
      NIC: 'B7777777777772',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891241',
      ...NOMINEE_1,
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    await importMembers(firstValid, actor, MIGRATE_PERMISSIONS);

    const second = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-301',
      'AB Number': 'AB9999',
      Surname: 'Bhurtun',
      Name: 'Aslam',
      NIC: 'B7777777777772',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891241',
    });
    const { errors } = await validateRows(await parseImportFile(second));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/does not match AB1301/);
  });

  it("records Shares, MSA and an additional account type's opening balance as one migration payment", async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_migration_test', 'Hajj Savings (test)', 'savings', 0, false)`
    );

    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();
    const filled = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-400',
      'AB Number': 'AB1400',
      Surname: 'Callychurn',
      Name: 'Yasmin',
      NIC: 'B7777777777773',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891242',
      'Shares Balance': '6000',
      'MSA Deposit Balance': '2500',
      'Hajj Savings (test) Number': 'HSA-1400',
      'Hajj Savings (test) Balance': '1200',
      ...NOMINEE_1,
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);

    const payment = await run(
      appUrl,
      `select p.id, p.method, p.total_amount
         from payment p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-400'`
    );
    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0].method).toBe('migration');
    expect(payment.rows[0].total_amount).toBe('9700.00');

    const lines = await run(
      appUrl,
      `select component_code, amount from payment_line
        where payment_id = $1 order by component_code`,
      [payment.rows[0].id]
    );
    expect(lines.rows).toEqual([
      { component_code: 'msa_deposit', amount: '2500.00' },
      { component_code: 'shares', amount: '6000.00' },
    ]);

    const accountLines = await run(
      appUrl,
      `select account_type_code, amount from payment_account_line
        where payment_id = $1`,
      [payment.rows[0].id]
    );
    expect(accountLines.rows).toEqual([
      { account_type_code: 'hsa_migration_test', amount: '1200.00' },
    ]);

    const hsaAccount = await run(
      appUrl,
      `select a.account_no from account a
         join account_type t on t.id = a.account_type_id
         join member m on m.id = a.member_id
        where m.legacy_code = 'LEG-400' and t.code = 'hsa_migration_test'`
    );
    expect(hsaAccount.rows).toHaveLength(1);
    // Its own legacy number, not the member's AB Number — officer
    // feedback: the legacy register numbered these independently.
    expect(hsaAccount.rows[0].account_no).toBe('HSA-1400');
  });

  it('requires a balance wherever an account number is given, and vice versa', async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('inv_pairing_test', 'Investment (pairing test)', 'savings', 0, false)
       on conflict (code) do nothing`
    );
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const template = await buildImportTemplate();

    const numberOnly = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-410',
      'AB Number': 'AB1410',
      Surname: 'Gopaul',
      Name: 'Devi',
      NIC: 'B7777777777774',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891243',
      'Investment (pairing test) Number': 'INV-1410',
    });
    const { errors: numberOnlyErrors } = await validateRows(
      await parseImportFile(numberOnly)
    );
    expect(numberOnlyErrors).toHaveLength(1);
    expect(numberOnlyErrors[0].message).toMatch(
      /Investment \(pairing test\) Balance is required/
    );

    const balanceOnly = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-411',
      'AB Number': 'AB1411',
      Surname: 'Gopaul',
      Name: 'Ravi',
      NIC: 'B7777777777775',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891244',
      'Investment (pairing test) Balance': '500',
    });
    const { errors: balanceOnlyErrors } = await validateRows(
      await parseImportFile(balanceOnly)
    );
    expect(balanceOnlyErrors).toHaveLength(1);
    expect(balanceOnlyErrors[0].message).toMatch(
      /Investment \(pairing test\) Number is required/
    );
  });

  it('creates a non-member (customer) from a row with no AB Number, its account carrying its own number', async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_customer_test', 'Hajj Savings (customer test)', 'savings', 0, false)
       on conflict (code) do nothing`
    );
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-500',
      // No AB Number — a customer, not a member.
      Surname: 'Peerthum',
      Name: 'Nazir',
      NIC: 'B6666666666671',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891250',
      'Hajj Savings (customer test) Number': 'HSA-500',
      'Hajj Savings (customer test) Balance': '3000',
      // Officer feedback: Nominee 1 is mandatory for a non-member row the
      // same as a member row.
      ...NOMINEE_1,
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);
    expect(valid[0].kind).toBe('customer');

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);

    const asMember = await run(
      appUrl,
      `select 1 from member where legacy_code = 'LEG-500'`
    );
    expect(asMember.rows).toHaveLength(0);

    const customer = await run(
      appUrl,
      `select c.id, c.status,
              (select status from membership_application
                where id = c.application_id) as application_status
         from customer c where legacy_code = 'LEG-500'`
    );
    expect(customer.rows).toHaveLength(1);
    expect(customer.rows[0].status).toBe('active');
    expect(customer.rows[0].application_status).toBe('approved');

    const account = await run(
      appUrl,
      `select a.account_no from account a
         join account_type t on t.id = a.account_type_id
        where a.customer_id = $1 and t.code = 'hsa_customer_test'`,
      [customer.rows[0].id]
    );
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0].account_no).toBe('HSA-500');

    const audited = await run(
      appUrl,
      `select 1 from audit_event
        where action = 'customer.migration.imported'
          and new_value->>'legacyCode' = 'LEG-500'`
    );
    expect(audited.rows).toHaveLength(1);

    // Officer feedback: Nominee 1 is written for a non-member the same as
    // a member.
    const nominee = await run(
      appUrl,
      `select p.values ->> 'surname' as surname
         from application_party p
         join customer c on c.application_id = p.application_id
        where c.legacy_code = 'LEG-500'
          and p.subject = 'nominee' and p.ordinal = 1`
    );
    expect(nominee.rows).toHaveLength(1);
    expect(nominee.rows[0].surname).toBe(NOMINEE_1['Nominee 1 Surname']);
  });

  it('re-importing a non-member adds a new account without touching one already held', async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('inv_customer_test', 'Investment (customer test)', 'savings', 0, false)
       on conflict (code) do nothing`
    );
    let { buildImportTemplate, parseImportFile, validateRows, importMembers } =
      await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-501',
      Surname: 'Ah-Kong',
      Name: 'Li',
      NIC: 'B6666666666672',
      Gender: 'Male',
      Address: 'Old Address',
      Mobile: '57891251',
      'Investment (customer test) Number': 'INV-501',
      'Investment (customer test) Balance': '1000',
      ...NOMINEE_1,
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    const firstOutcome = await importMembers(
      firstValid,
      actor,
      MIGRATE_PERMISSIONS
    );
    expect(firstOutcome.failed).toEqual([]);

    // Re-run: a corrected address, the same Investment account (no-op for
    // it), and a newly-known Hajj Savings account added. A fresh load()
    // (like an officer's next request would get) so the newly-configured
    // account type is not hidden behind the reference cache's own few
    // seconds (config/cache.ts) — runAsConfigurator writes directly, not
    // through withConfigurationActor, so nothing in-process clears it.
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_added_later_test', 'Hajj Savings (added later)', 'savings', 0, false)
       on conflict (code) do nothing`
    );
    ({ buildImportTemplate, parseImportFile, validateRows, importMembers } =
      await load());
    const secondTemplate = await buildImportTemplate();
    const second = await fillSheet(secondTemplate, 'Individual', {
      'Legacy Member Code': 'LEG-501',
      Surname: 'Ah-Kong',
      Name: 'Li',
      NIC: 'B6666666666672',
      Gender: 'Male',
      Address: 'Corrected Address',
      Mobile: '57891251',
      'Investment (customer test) Number': 'INV-501',
      'Investment (customer test) Balance': '1000',
      'Hajj Savings (added later) Number': 'HSA-501',
      'Hajj Savings (added later) Balance': '750',
      ...NOMINEE_1,
    });
    const secondParsed = await validateRows(await parseImportFile(second));
    expect(secondParsed.errors).toEqual([]);
    const secondOutcome = await importMembers(
      secondParsed.valid,
      actor,
      MIGRATE_PERMISSIONS
    );
    expect(secondOutcome.failed).toEqual([]);

    const customer = await run(
      appUrl,
      `select id from customer where legacy_code = 'LEG-501'`
    );
    expect(customer.rows).toHaveLength(1);

    const accounts = await run(
      appUrl,
      `select t.code, a.account_no from account a
         join account_type t on t.id = a.account_type_id
        where a.customer_id = $1
        order by t.code`,
      [customer.rows[0].id]
    );
    expect(accounts.rows).toEqual([
      { code: 'hsa_added_later_test', account_no: 'HSA-501' },
      { code: 'inv_customer_test', account_no: 'INV-501' },
    ]);

    const party = await run(
      appUrl,
      `select p.values ->> 'address' as address
         from application_party p
         join customer c on c.application_id = p.application_id
        where c.legacy_code = 'LEG-501'
          and p.subject = 'applicant'`
    );
    expect(party.rows[0].address).toBe('Corrected Address');
  });

  it('rejects a row with neither an AB Number nor any account number', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-502',
      Surname: 'Ramsamy',
      Name: 'Kevin',
      NIC: 'B6666666666673',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891252',
    });
    const { errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(
      /Provide an AB Number, or at least one account number/
    );
  });

  it('rejects an AB Number on a legacy code already on file as a non-member', async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_kind_conflict_test', 'Hajj Savings (kind conflict test)',
               'savings', 0, false)
       on conflict (code) do nothing`
    );
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-503',
      Surname: 'Bundhoo',
      Name: 'Priya',
      NIC: 'B6666666666674',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891253',
      'Hajj Savings (kind conflict test) Number': 'HSA-503',
      'Hajj Savings (kind conflict test) Balance': '400',
      ...NOMINEE_1,
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    await importMembers(firstValid, actor, MIGRATE_PERMISSIONS);

    const second = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-503',
      'AB Number': 'AB1503',
      Surname: 'Bundhoo',
      Name: 'Priya',
      NIC: 'B6666666666674',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891253',
    });
    const { errors } = await validateRows(await parseImportFile(second));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/is on file as a non-member/);
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
    const rowFor = (legacyCode: string, nic: string, abNumber: string) => ({
      sheet: 'Individual',
      rowNumber: 2,
      legacyCode,
      abNumber,
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
      guardian: {},
      beneficiary: {},
      nominees: [],
      sharesBalance: '',
      msaBalance: '',
      accountEntries: [],
      kind: 'member' as const,
      existingId: null,
      existingApplicationId: null,
    });

    const outcome = await importMembers(
      [
        rowFor('LEG-DUP-DB', 'B6666666666661', 'AB6666661'),
        rowFor('LEG-DUP-DB', 'B6666666666662', 'AB6666662'),
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

describe('fourth increment: Nominee, Minor, and NIC/mobile uniqueness', () => {
  it('captures Nominee 1 (mandatory) and Nominee 2 (optional), each its own application_party row', async () => {
    await runAsConfigurator(
      appUrl,
      `update membership_type set nominee_count = 2 where code = 'individual'`
    );
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();

    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-600',
      'AB Number': 'AB1600',
      Surname: 'Peerbux',
      Name: 'Sameera',
      NIC: 'B6000000000001',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891260',
      ...NOMINEE_1,
      'Nominee 2 Surname': 'Second',
      'Nominee 2 Name': 'Nominee',
    });
    const { valid, errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toEqual([]);

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);

    const nominees = await run(
      appUrl,
      `select p.ordinal, p.values ->> 'surname' as surname
         from application_party p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-600' and p.subject = 'nominee'
        order by p.ordinal`
    );
    expect(nominees.rows).toEqual([
      { ordinal: 1, surname: 'Nominee Surname' },
      { ordinal: 2, surname: 'Second' },
    ]);
  });

  it('rejects a member row missing Nominee 1, but never demands Nominee 2', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-601',
      'AB Number': 'AB1601',
      Surname: 'Rajah',
      Name: 'Kevin',
      NIC: 'B6000000000002',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891261',
      // No Nominee 1 fields at all.
    });
    const { errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Nominee surname is required/);
  });

  it('rejects a non-member row missing Nominee 1 too — officer feedback: mandatory for both', async () => {
    await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_nominee_required_test', 'Hajj Savings (nominee required test)',
               'savings', 0, false)
       on conflict (code) do nothing`
    );
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const filled = await fillSheet(await buildImportTemplate(), 'Individual', {
      'Legacy Member Code': 'LEG-601B',
      // No AB Number — a non-member row.
      Surname: 'Bhurtun',
      Name: 'Marie',
      NIC: 'B6000000000009',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891269',
      'Hajj Savings (nominee required test) Number': 'HSA-601B',
      'Hajj Savings (nominee required test) Balance': '200',
      // No Nominee 1 fields at all.
    });
    const { errors } = await validateRows(await parseImportFile(filled));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Nominee surname is required/);
  });

  it('leaves an existing Nominee 2 untouched on a re-import that leaves it blank', async () => {
    await runAsConfigurator(
      appUrl,
      `update membership_type set nominee_count = 2 where code = 'individual'`
    );
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-602',
      'AB Number': 'AB1602',
      Surname: 'Beeharry',
      Name: 'Nadia',
      NIC: 'B6000000000003',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891262',
      ...NOMINEE_1,
      'Nominee 2 Surname': 'Original',
      'Nominee 2 Name': 'Second',
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    await importMembers(firstValid, actor, MIGRATE_PERMISSIONS);

    // Re-import to correct the address only — Nominee 2 columns left blank,
    // same as an officer who has no reason to retype them this time.
    const second = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-602',
      'AB Number': 'AB1602',
      Surname: 'Beeharry',
      Name: 'Nadia',
      NIC: 'B6000000000003',
      Gender: 'Female',
      Address: 'Corrected Addr',
      Mobile: '57891262',
      ...NOMINEE_1,
    });
    const secondParsed = await validateRows(await parseImportFile(second));
    expect(secondParsed.errors).toEqual([]);
    await importMembers(secondParsed.valid, actor, MIGRATE_PERMISSIONS);

    const nominee2 = await run(
      appUrl,
      `select p.values ->> 'surname' as surname
         from application_party p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-602' and p.subject = 'nominee' and p.ordinal = 2`
    );
    expect(nominee2.rows[0].surname).toBe('Original');
  });

  it('migrates a Minor once their guardian is already on file, resolved by Member ID', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    // The guardian has to already be a member — imported first, same as a
    // legacy register would have to be worked in that order.
    const guardianRow = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-610-G',
      'AB Number': 'AB1610',
      Surname: 'Fakim',
      Name: 'Rehana',
      NIC: 'B6100000000001',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891270',
      ...NOMINEE_1,
    });
    const guardianValid = (
      await validateRows(await parseImportFile(guardianRow))
    ).valid;
    const guardianOutcome = await importMembers(
      guardianValid,
      actor,
      MIGRATE_PERMISSIONS
    );
    expect(guardianOutcome.failed).toEqual([]);

    const minorRow = await fillSheet(template, 'Minor', {
      'Legacy Member Code': 'LEG-611-M',
      'AB Number': 'AB1611',
      Surname: 'Fakim',
      Name: 'Ayaan',
      'Date of birth': '2015-06-01',
      Gender: 'Male',
      Address: 'Addr',
      // Only the Member ID — surname, name, NIC and mobile are pulled from
      // the guardian's own record, not retyped.
      'Guardian Member ID': 'AB1610',
      'Beneficiary surname': 'Fakim',
      'Beneficiary name': 'Zahra',
      'Beneficiary NIC': 'B6100000000003',
      'Nominee 1 Successor guardian surname': 'Fakim',
      'Nominee 1 Successor guardian name': 'Imran',
      'Nominee 1 Successor guardian NIC': 'B6100000000002',
    });
    const { valid, errors } = await validateRows(
      await parseImportFile(minorRow)
    );
    expect(errors).toEqual([]);

    const outcome = await importMembers(valid, actor, MIGRATE_PERMISSIONS);
    expect(outcome.failed).toEqual([]);

    const guardianParty = await run(
      appUrl,
      `select p.values as values
         from application_party p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-611-M' and p.subject = 'guardian'`
    );
    expect(guardianParty.rows[0].values).toEqual({
      member_id: 'AB1610',
      surname: 'Fakim',
      name: 'Rehana',
      nic: 'B6100000000001',
      mobile: '+23057891270',
    });

    const beneficiaryParty = await run(
      appUrl,
      `select p.values ->> 'surname' as surname
         from application_party p
         join member m on m.application_id = p.application_id
        where m.legacy_code = 'LEG-611-M' and p.subject = 'beneficiary'`
    );
    expect(beneficiaryParty.rows[0].surname).toBe('Fakim');
  });

  it('rejects a Minor missing the Takaful beneficiary', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const guardianRow = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-613-G',
      'AB Number': 'AB1613',
      Surname: 'Peerbhoy',
      Name: 'Karim',
      NIC: 'B6100000000004',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891272',
      ...NOMINEE_1,
    });
    const guardianValid = (
      await validateRows(await parseImportFile(guardianRow))
    ).valid;
    await importMembers(guardianValid, actor, MIGRATE_PERMISSIONS);

    const minorRow = await fillSheet(template, 'Minor', {
      'Legacy Member Code': 'LEG-614-M',
      'AB Number': 'AB1614',
      Surname: 'Peerbhoy',
      Name: 'Yasmin',
      'Date of birth': '2017-01-01',
      Gender: 'Female',
      Address: 'Addr',
      'Guardian Member ID': 'AB1613',
      'Nominee 1 Successor guardian surname': 'Peerbhoy',
      'Nominee 1 Successor guardian name': 'Imran',
      'Nominee 1 Successor guardian NIC': 'B6100000000005',
      // No beneficiary columns at all.
    });
    const { errors } = await validateRows(await parseImportFile(minorRow));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Beneficiary surname is required/);
  });

  it('rejects a Minor whose guardian cannot be found on file', async () => {
    const { buildImportTemplate, parseImportFile, validateRows } = await load();
    const minorRow = await fillSheet(await buildImportTemplate(), 'Minor', {
      'Legacy Member Code': 'LEG-612-M',
      'AB Number': 'AB1612',
      Surname: 'Unknown',
      Name: 'Guardianless',
      'Date of birth': '2016-01-01',
      Gender: 'Male',
      Address: 'Addr',
      'Guardian surname': 'Nobody',
      'Guardian name': 'Nowhere',
      'Guardian NIC': 'B9999999999900',
      'Guardian Member ID': 'AB9999999',
      'Relationship to minor': 'Father',
      'Guardian mobile': '57891271',
      'Nominee 1 Successor guardian surname': 'X',
      'Nominee 1 Successor guardian name': 'Y',
      'Nominee 1 Successor guardian NIC': 'B0',
    });
    const { errors } = await validateRows(await parseImportFile(minorRow));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/must already be on file/);
  });

  it('rejects two rows in the same batch sharing a NIC', async () => {
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
      const row = sheet.getRow(nextRow++);
      for (const [header, value] of Object.entries(data)) {
        const col = columnFor.get(header);
        if (col) row.getCell(col).value = value;
      }
      row.commit();
    };
    putRow({
      'Legacy Member Code': 'LEG-620',
      'AB Number': 'AB1620',
      Surname: 'One',
      Name: 'First',
      NIC: 'B6200000000000',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891280',
      ...NOMINEE_1,
    });
    putRow({
      'Legacy Member Code': 'LEG-621',
      'AB Number': 'AB1621',
      Surname: 'Two',
      Name: 'Second',
      NIC: 'B6200000000000',
      Gender: 'Female',
      Address: 'Addr',
      Mobile: '57891281',
      ...NOMINEE_1,
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const { errors } = await validateRows(await parseImportFile(buffer));
    expect(errors).toHaveLength(2);
    expect(
      errors.every(e =>
        /NIC "B6200000000000" appears more than once/.test(e.message)
      )
    ).toBe(true);
  });

  it('rejects a NIC already on file for a different member, but not a re-import of the same one', async () => {
    const {
      buildImportTemplate,
      parseImportFile,
      validateRows,
      importMembers,
    } = await load();
    const template = await buildImportTemplate();

    const first = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-630',
      'AB Number': 'AB1630',
      Surname: 'Nazeer',
      Name: 'Farhan',
      NIC: 'B6300000000000',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891290',
      ...NOMINEE_1,
    });
    const firstValid = (await validateRows(await parseImportFile(first))).valid;
    await importMembers(firstValid, actor, MIGRATE_PERMISSIONS);

    // A different legacy code claiming the same NIC — refused.
    const clash = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-631',
      'AB Number': 'AB1631',
      Surname: 'Nazeer',
      Name: 'Impersonator',
      NIC: 'B6300000000000',
      Gender: 'Male',
      Address: 'Addr',
      Mobile: '57891291',
      ...NOMINEE_1,
    });
    const { errors: clashErrors } = await validateRows(
      await parseImportFile(clash)
    );
    expect(clashErrors).toHaveLength(1);
    expect(clashErrors[0].message).toMatch(
      /NIC "B6300000000000" is already on file for a different/
    );

    // Re-importing LEG-630 itself with the same NIC is not a clash.
    const resubmit = await fillSheet(template, 'Individual', {
      'Legacy Member Code': 'LEG-630',
      'AB Number': 'AB1630',
      Surname: 'Nazeer',
      Name: 'Farhan',
      NIC: 'B6300000000000',
      Gender: 'Male',
      Address: 'Updated Addr',
      Mobile: '57891290',
      ...NOMINEE_1,
    });
    const { errors: resubmitErrors } = await validateRows(
      await parseImportFile(resubmit)
    );
    expect(resubmitErrors).toEqual([]);
  });
});
