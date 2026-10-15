// Restoring transaction history (migration 0130, history.ts) — the whole
// round trip against a real database: members imported, money moved, both
// backup files taken, everything reset, the members file imported again,
// and the transactions file restored over it. What is asserted is that the
// ledger reads as it did: the same TX, TR and RCT numbers on the same
// dates, the same balances, the approvals, the reversal and the void.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';
import { openEveryDrawer } from '../cash/drawers.testing';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `history_test_${Date.now()}`;
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
    history: await import('./history'),
    backup: await import('./transactions-backup'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
    transfers: await import('../ledger/transfers'),
    reversals: await import('../ledger/reversals'),
    receipts: await import('../ledger/receipts'),
  };
}

const MIGRATE = new Set(['system.migrate_members']);
const actor = { userId: '', email: 'admin@albarakah.mu' };
let officer: Principal;
let treasurer: Principal;

function principalFor(
  userId: string,
  email: string,
  displayName: string,
  permissions: string[]
): Principal {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName,
    roles: [],
    roleNames: [],
    permissions: new Set(permissions),
  };
}

// Two members on the Individual sheet, as an officer would fill it.
async function membersFile(
  buildImportTemplate: () => Promise<Buffer>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildImportTemplate()) as any);
  const sheet = workbook.getWorksheet('Individual')!;
  const column = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, n) => {
    column.set(
      String(cell.value ?? '')
        .trim()
        .replace(/\s*\*\s*$/, ''),
      n
    );
  });
  const people = [
    {
      'AB Number': 'AB0001',
      Surname: 'Joomun',
      Name: 'Ismail',
      NIC: 'J0101010101010',
      Mobile: '57890001',
      'Shares Balance': '5000',
      'MSA Deposit Balance': '2000',
    },
    {
      'AB Number': 'AB0002',
      Surname: 'Sooben',
      Name: 'Farah',
      NIC: 'S0202020202020',
      Mobile: '57890002',
      'Shares Balance': '3000',
      'MSA Deposit Balance': '0',
    },
    {
      'AB Number': 'AB0003',
      Surname: 'Ramjaun',
      Name: 'Bilal',
      NIC: 'R0303030303030',
      Mobile: '57890003',
      'Shares Balance': '0',
      'MSA Deposit Balance': '1000',
    },
  ];
  people.forEach((person, i) => {
    const row = sheet.getRow(2 + i);
    const values: Record<string, string> = {
      Gender: 'Male',
      Address: '5 Sir William Newton Street',
      'Nominee 1 Surname': 'Nominee Surname',
      'Nominee 1 Name': 'Nominee Name',
      'Nominee 1 NIC': 'Nominee NIC',
      'Nominee 1 Address': 'Nominee Address',
      ...person,
    };
    for (const [header, value] of Object.entries(values)) {
      const col = column.get(header);
      if (col) row.getCell(col).value = value;
    }
    row.commit();
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function importFile(
  members: Awaited<ReturnType<typeof load>>['members'],
  buffer: Buffer
) {
  const { valid, errors } = await members.validateRows(
    await members.parseImportFile(buffer)
  );
  expect(errors).toEqual([]);
  const outcome = await members.importMembers(valid, actor, MIGRATE, 'test');
  expect(outcome.failed).toEqual([]);
}

async function accountOf(memberNo: string, type: 'shares' | 'msa') {
  const result = await run(
    appUrl,
    `select a.id from account a
       join member m on m.id = a.member_id
       join account_type t on t.id = a.account_type_id
      where m.member_no = $1 and t.code = $2`,
    [memberNo, type]
  );
  return result.rows[0].id as string;
}

// The ledger as a member's page and statement read it.
async function ledger() {
  const rows = await run(
    appUrl,
    `select t.reference, t.kind, t.status, t.amount::text,
            coalesce(rn.receipt_no, '') as receipt_no,
            coalesce(rn.state, '') as receipt_state,
            coalesce(tr.reference, '') as transfer,
            coalesce(o.reference, '') as reverses,
            m.member_no, ty.code as type,
            to_char(t.posted_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
              as posted_at,
            (t.payment_line_id is not null
               or t.payment_account_line_id is not null) as opening
       from transaction t
       join account a on a.id = t.account_id
       join account_type ty on ty.id = a.account_type_id
       join member m on m.id = a.member_id
       left join receipt_number rn on rn.id = t.receipt_number_id
       left join transfer tr on tr.id = t.transfer_id
       left join transaction o on o.id = t.reverses_id
      order by t.serial_no`
  );
  return rows.rows;
}

async function balances() {
  const rows = await run(
    appUrl,
    `select m.member_no || ' ' || ty.code as account, b.balance::text,
            b.entry_count::int
       from account_balance b
       join account a on a.id = b.account_id
       join account_type ty on ty.id = a.account_type_id
       join member m on m.id = a.member_id
      order by 1`
  );
  return rows.rows;
}

let before: Awaited<ReturnType<typeof ledger>>;
let balancesBefore: Awaited<ReturnType<typeof balances>>;
let membersBackup: Buffer;
let transactionsBackup: Buffer;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator'),
            ('treasurer@albarakah.mu', 'Treasurer')
     returning id, email`
  );
  const id = new Map(users.rows.map(r => [r.email, r.id]));
  actor.userId = id.get('admin@albarakah.mu');
  officer = principalFor(actor.userId, actor.email, 'Administrator', [
    'transaction.capture',
    'transaction.post',
    'transaction.record_transfer',
    'transaction.disburse',
    'transaction.view',
  ]);
  treasurer = principalFor(
    id.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    'Treasurer',
    ['receipt.void', 'transaction.view']
  );
  await openEveryDrawer(appUrl);

  // The members, and a fortnight of business.
  const m = await load();
  await importFile(m.members, await membersFile(m.members.buildImportTemplate));
  const ab1Msa = await accountOf('AB0001', 'msa');
  const ab2Msa = await accountOf('AB0002', 'msa');
  const ab2Shares = await accountOf('AB0002', 'shares');
  await m.deposits.recordDeposit(
    { accountId: ab1Msa, amount: '1000', method: 'cash' },
    officer
  );
  await m.withdrawals.recordWithdrawal(
    { accountId: ab1Msa, amount: '300', method: 'cash' },
    officer
  );
  await m.transfers.recordTransfer(
    {
      sourceAccountId: ab1Msa,
      amount: '500',
      destination: { kind: 'account', accountId: ab2Msa },
      reason: 'Family',
    },
    officer
  );
  const mistaken = await m.deposits.recordDeposit(
    { accountId: ab2Msa, amount: '400', method: 'cash' },
    officer
  );
  await m.reversals.reverseTransaction(
    mistaken.id,
    { reason: 'Wrong member' },
    treasurer
  );
  const voided = await m.deposits.recordDeposit(
    { accountId: ab2Shares, amount: '250', method: 'cash' },
    officer
  );
  await m.receipts.voidTransactionReceipt(voided.id, 'Misprinted', treasurer);
  // An opening taken back: the account is empty, so the members import
  // carries nothing onto it and the opening comes back from the history.
  const opening = await run(
    appUrl,
    `select id from transaction where account_id = $1`,
    [await accountOf('AB0003', 'msa')]
  );
  await m.reversals.reverseTransaction(
    opening.rows[0].id,
    { reason: 'Never paid' },
    treasurer
  );

  before = await ledger();
  balancesBefore = await balances();
  expect(before.every(t => t.status === 'posted')).toBe(true);

  // The two files the nightly backup saves.
  membersBackup = (await m.members.exportMembers(actor, MIGRATE)).buffer;
  transactionsBackup = (await m.backup.exportTransactions()).buffer;

  // Everything gone, then the members back from their file.
  await run(appUrl, 'select reset_all_test_data($1, $2)', [
    actor.userId,
    actor.email,
  ]);
  await openEveryDrawer(appUrl);
  const again = await load();
  await importFile(again.members, membersBackup);
}, 120_000);

afterAll(async () => {
  await openPool?.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('restoring transaction history', () => {
  it('starts from the members import: the balances, one opening each', async () => {
    expect(await balances()).toEqual(
      balancesBefore
        .filter(b => Number(b.balance) > 0)
        .map(b => ({ ...b, entry_count: 1 }))
    );
  });

  it('refuses a file whose entries do not add up to the balances here, and changes nothing', async () => {
    const { history } = await load();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(transactionsBackup as any);
    const entries = workbook.getWorksheet('Entries')!;
    const amountCol = (entries.getRow(1).values as unknown[]).indexOf('Amount');
    const last = entries.getRow(entries.rowCount);
    last.getCell(amountCol).value = 1;
    last.commit();
    const altered = Buffer.from(await workbook.xlsx.writeBuffer());

    const ledgerBefore = await ledger();
    const error = await history
      .restoreHistory(altered, 'altered', actor, MIGRATE)
      .catch(e => e);
    expect(error).toBeInstanceOf(history.HistoryProblems);
    expect(error.problems.join(' ')).toMatch(/add up to/);
    expect(await ledger()).toEqual(ledgerBefore);
  });

  it('refuses without system.migrate_members', async () => {
    const { history } = await load();
    await expect(
      history.restoreHistory(transactionsBackup, 'x', actor, new Set())
    ).rejects.toThrowError(/permission/);
  });

  it('puts every transaction back as it was: numbers, dates, balances', async () => {
    const { history } = await load();
    const outcome = await history.restoreHistory(
      transactionsBackup,
      'backup',
      actor,
      MIGRATE
    );
    expect(outcome.notPosted).toBe(0);
    expect(outcome.transfers).toBe(1);
    // The Treasurer's account went with the reset; who reversed and voided
    // is recorded as the migration account, and named.
    expect(outcome.unknownStaff).toEqual(['Treasurer']);

    const after = await ledger();
    // AB0003's opening was taken back, so the import carried none: it comes
    // back from the history as an ordinary deposit, without the receipt its
    // fee payment gave it.
    const cameBack = (r: (typeof before)[number]) =>
      r.opening && r.member_no === 'AB0003';
    const strip = (rows: typeof before) =>
      rows.map(r => ({
        reference: r.reference,
        kind: r.kind,
        status: r.status,
        amount: r.amount,
        transfer: r.transfer,
        reverses: r.reverses,
        account: `${r.member_no} ${r.type}`,
        posted_at: r.posted_at,
        opening: r.opening && !cameBack(r),
        receipt_no: cameBack(r) ? '' : r.receipt_no,
        receipt_state: cameBack(r) ? '' : r.receipt_state,
      }));
    expect(strip(after)).toEqual(strip(before));
    // Every account as it was, AB0003's empty MSA included.
    expect(await balances()).toEqual(balancesBefore);
    // The balance cache agrees with the entries (the ledger-verify job's
    // own check).
    expect((await run(ownerUrl, 'select * from ledger_drift()')).rows).toEqual(
      []
    );

    const voided = after.find(r => r.receipt_state === 'void');
    expect(voided?.amount).toBe('250.00');
    expect(
      after.filter(r => r.kind === 'reversal').map(r => r.reverses)
    ).toEqual(before.filter(r => r.kind === 'reversal').map(r => r.reverses));

    const audit = await run(
      appUrl,
      `select new_value from audit_event
        where action = 'migration.history.restored'`
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('carries on numbering after the history, and refuses a second restore', async () => {
    const { deposits, history } = await load();
    const maxTx = Math.max(...before.map(r => Number(r.reference.slice(3))));
    const maxRct = Math.max(
      ...before
        .filter(r => r.receipt_no)
        .map(r => Number(r.receipt_no.slice(4)))
    );
    const fresh = await deposits.recordDeposit(
      {
        accountId: await accountOf('AB0001', 'shares'),
        amount: '100',
        method: 'cash',
      },
      officer
    );
    expect(Number(fresh.reference.slice(3))).toBeGreaterThan(maxTx);
    expect(Number(fresh.receiptNo!.slice(4))).toBeGreaterThan(maxRct);

    await expect(
      history.restoreHistory(transactionsBackup, 'again', actor, MIGRATE)
    ).rejects.toThrowError(/since the members were imported/);
  });
});
