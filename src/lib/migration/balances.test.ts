// Account balances from a migration file, against real migrations (0111):
// a migrated opening balance raised, lowered to nothing and back, a new one
// recorded where there was none, and every refusal — before anything is
// written.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);
const dbName = `migration_balance_test_${Date.now()}`;
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
async function load() {
  await openPool?.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    members: await import('./members'),
    balances: await import('./balances'),
    deposits: await import('../ledger/deposits'),
  };
}

const actor = { userId: '', email: 'admin@albarakah.mu' };
const MIGRATE = new Set(['system.migrate_members']);
let officer: Principal;

const NOMINEE_1 = {
  'Nominee 1 Surname': 'Nominee Surname',
  'Nominee 1 Name': 'Nominee Name',
  'Nominee 1 NIC': 'Nominee NIC',
  'Nominee 1 Address': 'Nominee Address',
};

async function individualSheet(
  template: Buffer,
  rows: Record<string, string>[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as any);
  const sheet = workbook.getWorksheet('Individual')!;
  const columnFor = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, n) => {
    columnFor.set(
      String(cell.value ?? '')
        .trim()
        .replace(/\s*\*\s*$/, ''),
      n
    );
  });
  rows.forEach((data, i) => {
    const row = sheet.getRow(2 + i);
    for (const [header, value] of Object.entries({ ...NOMINEE_1, ...data })) {
      const col = columnFor.get(header);
      if (col) row.getCell(col).value = value;
    }
    row.commit();
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function person(i: number, extra: Record<string, string>) {
  return {
    'Legacy Member Code': `BAL-${i}`,
    Surname: 'Balance',
    Name: `Person ${i}`,
    NIC: `B${String(i).padStart(13, '0')}`,
    Gender: 'Female',
    Address: 'Addr',
    Mobile: `5${7200000 + i}`,
    ...extra,
  };
}

// A balance file as the template has it, filled from row 2 down.
async function balanceFile(
  template: Buffer,
  rows: [string, string, string][]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as any);
  const sheet = workbook.getWorksheet('Balances')!;
  rows.forEach(([account, type, balance], i) => {
    const row = sheet.getRow(2 + i);
    row.getCell(1).value = account;
    row.getCell(2).value = type;
    row.getCell(3).value = balance;
    row.commit();
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function balanceOf(label: string, type?: string): Promise<string> {
  const result = await run(
    appUrl,
    `select coalesce(b.balance, 0)::text as balance
       from account a
       join account_type t on t.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join account_balance b on b.account_id = a.id
      where a.account_no = $1
         or (m.member_no = $1 and t.code = $2)`,
    [label, type ?? '']
  );
  return result.rows[0].balance;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
  actor.userId = (
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('admin@albarakah.mu', 'Administrator') returning id`
    )
  ).rows[0].id;
  const officerId = (
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('officer@albarakah.mu', 'Officer') returning id`
    )
  ).rows[0].id;
  officer = {
    userId: officerId,
    entraSubject: 'sub-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: ['account_officer'],
    roleNames: ['Account Officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.view',
    ]),
  };
  await run(
    appUrl,
    `begin;
     select set_config('albarakah.actor_description', 'test fixture', true);
     insert into account_type
       (code, name, category, minimum_opening_amount, is_membership_default)
     values ('hsa_bal_test', 'Hajj Savings (balance test)', 'savings', 0, false),
            ('inv_bal_test', 'Investment (balance test)', 'savings', 0, false);
     commit;`
  );

  const { members } = await load();
  const upload = await members.validateRows(
    await members.parseImportFile(
      await individualSheet(await members.buildImportTemplate(), [
        person(1, {
          'AB Number': 'AB2101',
          'Shares Balance': '5000',
          'MSA Deposit Balance': '1000',
          'Hajj Savings (balance test) Number': 'HSA-2101',
          'Hajj Savings (balance test) Balance': '400',
        }),
        person(2, {
          'AB Number': 'AB2102',
          'Shares Balance': '5000',
          'MSA Deposit Balance': '0',
        }),
        person(3, {
          'Hajj Savings (balance test) Number': 'HSA-2103',
          'Hajj Savings (balance test) Balance': '900',
        }),
      ])
    )
  );
  expect(upload.errors).toEqual([]);
  const outcome = await members.importMembers(
    upload.valid,
    actor,
    MIGRATE,
    'fixture'
  );
  expect(outcome.failed).toEqual([]);
}, 60_000);

afterAll(async () => {
  await openPool?.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('setting account balances from a file', () => {
  it('reads the template back', async () => {
    const { balances } = await load();
    const rows = await balances.parseBalanceFile(
      await balanceFile(await balances.buildBalanceTemplate(), [
        ['AB2101', 'Shares', '7,000'],
        ['HSA-2101', '', '400'],
      ])
    );
    expect(rows).toEqual([
      {
        rowNumber: 2,
        account: 'AB2101',
        accountType: 'Shares',
        balance: '7,000',
      },
      { rowNumber: 3, account: 'HSA-2101', accountType: '', balance: '400' },
    ]);
  });

  it('replaces migrated opening balances, all in one go', async () => {
    const { balances } = await load();
    const { valid, errors } = await balances.validateBalanceRows([
      {
        rowNumber: 2,
        account: 'AB2101',
        accountType: 'Shares',
        balance: '7000',
      },
      { rowNumber: 3, account: 'ab2101', accountType: 'msa', balance: '0' },
      { rowNumber: 4, account: 'HSA-2101', accountType: '', balance: '400' },
      { rowNumber: 5, account: 'AB2102', accountType: 'MSA', balance: '2500' },
      {
        rowNumber: 6,
        account: 'HSA-2103',
        accountType: 'Hajj Savings (balance test)',
        balance: '150.50',
      },
    ]);
    expect(errors).toEqual([]);
    expect(valid.map(v => v.label)).toEqual([
      'AB2101 Shares',
      'AB2101 Multiplier Savings Account',
      'HSA-2101',
      'AB2102 Multiplier Savings Account',
      'HSA-2103',
    ]);

    const outcome = await balances.applyBalances(
      valid,
      'file-1',
      actor,
      MIGRATE
    );
    expect(outcome).toEqual({ rows: 5, changed: 4, unchanged: 1 });

    expect(await balanceOf('AB2101', 'shares')).toBe('7000.00');
    expect(await balanceOf('AB2101', 'msa')).toBe('0.00');
    expect(await balanceOf('HSA-2101')).toBe('400.00');
    expect(await balanceOf('AB2102', 'msa')).toBe('2500.00');
    expect(await balanceOf('HSA-2103')).toBe('150.50');

    // Receipts, statement and ledger all agree.
    expect((await run(appUrl, `select * from ledger_drift()`)).rows).toEqual(
      []
    );
    const payments = await run(
      appUrl,
      `select p.total_amount::text as total,
              (coalesce((select sum(amount) from payment_line
                          where payment_id = p.id), 0)
               + coalesce((select sum(amount) from payment_account_line
                            where payment_id = p.id), 0))::text as lines,
              (select fe.payload->>'totalAmount' from financial_event fe
                where fe.payment_id = p.id
                  and fe.event_type = 'payment.recorded') as recorded
         from payment p where p.method = 'migration'`
    );
    for (const p of payments.rows) {
      expect(p.total).toBe(p.lines);
      expect(p.recorded).toBe(p.total);
    }
    const shares = await run(
      appUrl,
      `select t.amount::text as amount,
              fe.payload->>'amount' as posted
         from transaction t
         join account a on a.id = t.account_id
         join account_type ty on ty.id = a.account_type_id
         join member m on m.id = a.member_id
         join financial_event fe
           on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
        where m.member_no = 'AB2101' and ty.code = 'shares'`
    );
    expect(shares.rows).toEqual([{ amount: '7000.00', posted: '7000.00' }]);

    const audit = await run(
      appUrl,
      `select previous_value->>'balance' as before,
              new_value->>'balance' as after
         from audit_event where action = 'migration.balance.set'
        order by id`
    );
    expect(audit.rows).toEqual([
      { before: '5000.00', after: '7000.00' },
      { before: '1000.00', after: '0.00' },
      { before: '0.00', after: '2500.00' },
      { before: '900.00', after: '150.50' },
    ]);

    // Back up from nothing: the same receipt, posted again.
    const again = await balances.validateBalanceRows([
      { rowNumber: 2, account: 'AB2101', accountType: 'MSA', balance: '800' },
    ]);
    await balances.applyBalances(again.valid, 'file-2', actor, MIGRATE);
    expect(await balanceOf('AB2101', 'msa')).toBe('800.00');
    expect((await run(appUrl, `select * from ledger_drift()`)).rows).toEqual(
      []
    );
  });

  it('records an opening balance on an account that has none', async () => {
    const { balances } = await load();
    // An account on file with nothing on it at all.
    await run(
      ownerUrl,
      `insert into account
         (customer_id, account_type_id, opened_by_application_id, account_no)
       select c.id, t.id, c.application_id, 'INV-2103'
         from customer c, account_type t
        where c.legacy_code = 'BAL-3' and t.code = 'inv_bal_test'`
    );
    const receiptsBefore = Number(
      (await run(appUrl, `select count(*) as n from receipt_number`)).rows[0].n
    );
    const { valid, errors } = await balances.validateBalanceRows([
      { rowNumber: 2, account: 'INV-2103', accountType: '', balance: '3000' },
    ]);
    expect(errors).toEqual([]);
    expect(
      await balances.applyBalances(valid, 'file-3', actor, MIGRATE)
    ).toEqual({ rows: 1, changed: 1, unchanged: 0 });
    expect(await balanceOf('INV-2103')).toBe('3000.00');
    expect(
      Number(
        (await run(appUrl, `select count(*) as n from receipt_number`)).rows[0]
          .n
      )
    ).toBe(receiptsBefore + 1);
    expect((await run(appUrl, `select * from ledger_drift()`)).rows).toEqual(
      []
    );
  });

  it('refuses the whole file on any problem, and changes nothing', async () => {
    const { balances, deposits } = await load();
    const hsa = (
      await run(appUrl, `select id from account where account_no = 'HSA-2101'`)
    ).rows[0].id;
    await deposits.recordDeposit(
      { accountId: hsa, amount: '100', method: 'cash' },
      officer
    );

    const { valid, errors } = await balances.validateBalanceRows([
      { rowNumber: 2, account: 'AB2101', accountType: '', balance: '1' },
      { rowNumber: 3, account: 'AB2101', accountType: 'HSA', balance: '1' },
      { rowNumber: 4, account: 'NOPE-1', accountType: '', balance: '1' },
      { rowNumber: 5, account: 'HSA-2101', accountType: '', balance: '1' },
      { rowNumber: 6, account: 'AB2102', accountType: 'Shares', balance: '-5' },
      { rowNumber: 7, account: 'AB2102', accountType: 'Shares', balance: '' },
      {
        rowNumber: 8,
        account: 'HSA-2103',
        accountType: 'Shares',
        balance: '1',
      },
      { rowNumber: 9, account: 'AB2102', accountType: 'MSA', balance: '1' },
      { rowNumber: 10, account: 'AB2102', accountType: 'msa', balance: '2' },
    ]);
    expect(valid).toEqual([]);
    expect(errors.map(e => [e.rowNumber, e.message])).toEqual([
      [
        2,
        'Account Type is required for AB2101: Shares or Multiplier Savings Account.',
      ],
      [
        3,
        'AB2101 holds no HSA account. Use Shares or Multiplier Savings Account.',
      ],
      [4, 'NOPE-1 is not on file.'],
      [
        5,
        'HSA-2101 has transactions of its own, so its balance cannot be set here.',
      ],
      [6, 'Balance cannot be negative.'],
      [7, 'Balance is required.'],
      [8, 'HSA-2103 is a Hajj Savings (balance test), not Shares.'],
      [
        9,
        'AB2102 Multiplier Savings Account appears more than once in this file.',
      ],
      [
        10,
        'AB2102 Multiplier Savings Account appears more than once in this file.',
      ],
    ]);
    expect(await balanceOf('AB2102', 'msa')).toBe('2500.00');
  });

  it('refuses without system.migrate_members', async () => {
    const { balances } = await load();
    await expect(
      balances.applyBalances(
        [
          {
            rowNumber: 2,
            accountId: '00000000-0000-0000-0000-000000000000',
            label: 'X',
            previous: '0.00',
            balance: '1.00',
            feeVersionId: null,
          },
        ],
        'x',
        actor,
        new Set()
      )
    ).rejects.toThrowError(/permission/);
  });
});
