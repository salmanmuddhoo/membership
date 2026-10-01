// The legacy migration a chunk at a time, against real migrations
// (0110): an upload stored as a batch, imported a few rows per call, and
// — while it runs — cancelled, leaving nothing it wrote behind.
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
const dbName = `migration_batch_test_${Date.now()}`;
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
    batches: await import('./batches'),
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

// Every row on the Individual sheet, from row 2 down, by column header.
async function sheetOf(
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
    'Legacy Member Code': `BAT-${i}`,
    Surname: 'Batch',
    Name: `Person ${i}`,
    NIC: `T${String(i).padStart(13, '0')}`,
    Gender: 'Female',
    Address: 'Addr',
    Mobile: `5${7100000 + i}`,
    ...extra,
  };
}

async function count(sql: string, params: unknown[] = []) {
  return Number((await run(appUrl, sql, params)).rows[0].n);
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
     values ('hsa_batch_test', 'Hajj Savings (batch test)', 'savings', 0, false);
     commit;`
  );
}, 60_000);

afterAll(async () => {
  await openPool?.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a migration batch', () => {
  it('imports a chunk at a time, and cancelling removes everything it wrote', async () => {
    const { members, batches } = await load();
    const template = await members.buildImportTemplate();

    // A member already on file from an earlier import, one-shot.
    const earlier = await members.validateRows(
      await members.parseImportFile(
        await sheetOf(template, [
          person(1, {
            'AB Number': 'AB2001',
            'Shares Balance': '5000',
            'MSA Deposit Balance': '1000',
          }),
        ])
      )
    );
    expect(earlier.errors).toEqual([]);
    await members.importMembers(earlier.valid, actor, MIGRATE, 'earlier');
    const kept = (
      await run(appUrl, `select id from member where legacy_code = 'BAT-1'`)
    ).rows[0].id;
    const keptAccounts = await count(
      `select count(*) as n from account where member_id = $1`,
      [kept]
    );

    // The batch: that member again with an HSA added, a new member and a
    // new non-member.
    const upload = await members.validateRows(
      await members.parseImportFile(
        await sheetOf(template, [
          person(1, {
            'AB Number': 'AB2001',
            'Shares Balance': '5000',
            'MSA Deposit Balance': '1000',
            'Hajj Savings (batch test) Number': 'HSA-2001',
            'Hajj Savings (batch test) Balance': '400',
          }),
          person(2, {
            'AB Number': 'AB2002',
            'Shares Balance': '6000',
            'MSA Deposit Balance': '2000',
            'Hajj Savings (batch test) Number': 'HSA-2002',
            'Hajj Savings (batch test) Balance': '700',
          }),
          person(3, {
            'Hajj Savings (batch test) Number': 'HSA-2003',
            'Hajj Savings (batch test) Balance': '900',
          }),
        ])
      )
    );
    expect(upload.errors).toEqual([]);
    const before = {
      members: await count(`select count(*) as n from member`),
      customers: await count(`select count(*) as n from customer`),
      accounts: await count(`select count(*) as n from account`),
      payments: await count(`select count(*) as n from payment`),
      entries: await count(`select count(*) as n from account_entry`),
      applications: await count(
        `select count(*) as n from membership_application`
      ),
    };

    const batchId = await batches.startMigrationBatch(
      upload.valid,
      'upload',
      actor,
      MIGRATE
    );
    await expect(
      batches.startMigrationBatch(upload.valid, 'again', actor, MIGRATE)
    ).rejects.toThrowError(/Another import is still running/);
    expect(await batches.runningBatch()).toMatchObject({
      id: batchId,
      total: 3,
      processed: 0,
    });

    // Two of the three rows in: the member already on file, given its HSA,
    // and the new member. The non-member is still to come.
    const progress = await batches.importNextRows(batchId, actor, MIGRATE, 2);
    expect(progress).toMatchObject({
      status: 'running',
      processed: 2,
      imported: 2,
    });

    const removed = await batches.cancelMigrationBatch(batchId, actor, MIGRATE);
    // The new member (Shares, MSA, HSA) and the HSA added to the member
    // already on file, with their two opening-balance payments.
    expect(removed).toEqual({ holders: 1, accounts: 4, payments: 2 });

    expect({
      members: await count(`select count(*) as n from member`),
      customers: await count(`select count(*) as n from customer`),
      accounts: await count(`select count(*) as n from account`),
      payments: await count(`select count(*) as n from payment`),
      entries: await count(`select count(*) as n from account_entry`),
      applications: await count(
        `select count(*) as n from membership_application`
      ),
    }).toEqual(before);
    // The member already on file keeps what it had.
    expect(
      await count(`select count(*) as n from account where member_id = $1`, [
        kept,
      ])
    ).toBe(keptAccounts);
    // The receipts the batch used stay in the sequence, void.
    expect(
      (
        await run(
          appUrl,
          `select state, reason from receipt_number
            where reason = 'Migration cancelled'`
        )
      ).rows
    ).toHaveLength(2);
    expect((await run(appUrl, `select * from ledger_drift()`)).rows).toEqual(
      []
    );
    expect(await batches.batchProgress(batchId)).toMatchObject({
      status: 'cancelled',
    });
    expect(
      await count(
        `select count(*) as n from audit_event
          where action = 'migration.batch.cancelled' and entity_id = $1`,
        [batchId]
      )
    ).toBe(1);
    await expect(
      batches.cancelMigrationBatch(batchId, actor, MIGRATE)
    ).rejects.toThrowError(/already cancelled/);
  });

  it('will not cancel once money has moved, and finishes with what it added', async () => {
    const { members, batches, deposits } = await load();
    const upload = await members.validateRows(
      await members.parseImportFile(
        await sheetOf(await members.buildImportTemplate(), [
          person(4, {
            'Hajj Savings (batch test) Number': 'HSA-2004',
            'Hajj Savings (batch test) Balance': '1500',
          }),
          person(5, {
            'AB Number': 'AB2005',
            'Shares Balance': '5000',
            'MSA Deposit Balance': '0',
          }),
        ])
      )
    );
    expect(upload.errors).toEqual([]);
    const batchId = await batches.startMigrationBatch(
      upload.valid,
      'second',
      actor,
      MIGRATE
    );
    await batches.importNextRows(batchId, actor, MIGRATE, 1);
    const hsa = (
      await run(appUrl, `select id from account where account_no = 'HSA-2004'`)
    ).rows[0].id;
    await deposits.recordDeposit(
      { accountId: hsa, amount: '100', method: 'cash' },
      officer
    );
    await expect(
      batches.cancelMigrationBatch(batchId, actor, MIGRATE)
    ).rejects.toThrowError(/Money has moved on HSA-2004/);

    const done = await batches.importNextRows(batchId, actor, MIGRATE, 50);
    expect(done).toMatchObject({ status: 'completed', imported: 2 });
    const outcome = await batches.batchOutcome(batchId);
    expect(outcome!.added!.total).toEqual({
      holders: 2,
      amountCents: 650000,
    });
    expect(await batches.runningBatch()).toBeNull();
    await expect(
      batches.cancelMigrationBatch(batchId, actor, MIGRATE)
    ).rejects.toThrowError(/already completed/);
  });

  it('refuses without system.migrate_members', async () => {
    const { batches } = await load();
    await expect(
      batches.importNextRows(
        '00000000-0000-0000-0000-000000000000',
        actor,
        new Set()
      )
    ).rejects.toThrowError(/permission/);
  });
});
