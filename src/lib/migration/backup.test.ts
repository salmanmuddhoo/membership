// The nightly members backup: the export saved to SharePoint, five days
// kept. Against a real database (the export reads it) and a stand-in for
// Graph that keeps the files it is given, so what is asserted is what the
// library would hold afterwards, not what was asked of it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { GraphConfig } from '../documents/graph';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `backup_test_${Date.now()}`;
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

// The library: path -> bytes. Folders are implied by the paths in it.
const files = new Map<string, Buffer>();
const conflictBehaviours: string[] = [];
let server: Server;
let baseUrl: string;

function config(): GraphConfig {
  return {
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: 'secret',
    driveId: 'drive-1',
    graphBaseUrl: `${baseUrl}/v1.0`,
    loginBaseUrl: baseUrl,
  };
}

// "/v1.0/drives/drive-1/root:/A/B/c.xlsx:/createUploadSession" -> "A/B/c.xlsx"
function itemPath(pathname: string, suffix = ''): string {
  const marker = '/root:/';
  const start = pathname.indexOf(marker) + marker.length;
  const end = suffix ? pathname.lastIndexOf(suffix) : pathname.length;
  return decodeURI(pathname.slice(start, end));
}

const uploads = new Map<string, string>(); // session -> item path

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl);
    const body: Buffer[] = [];
    req.on('data', (c: Buffer) => body.push(c));
    req.on('end', () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.endsWith('/oauth2/v2.0/token')) {
        return json(200, { access_token: 't', expires_in: 3600 });
      }
      // Folder creation (ensureFolder): nothing to keep.
      if (req.method === 'POST' && url.pathname.endsWith('/children')) {
        return json(201, { id: 'folder' });
      }
      if (url.pathname.endsWith(':/createUploadSession')) {
        const request = JSON.parse(Buffer.concat(body).toString());
        conflictBehaviours.push(
          request.item['@microsoft.graph.conflictBehavior']
        );
        const id = `s${uploads.size + 1}`;
        uploads.set(id, itemPath(url.pathname, ':/createUploadSession'));
        return json(200, { uploadUrl: `${baseUrl}/upload/${id}` });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
        const target = uploads.get(url.pathname.split('/')[2])!;
        files.set(target, Buffer.concat(body)); // one chunk: the files are small
        return json(201, { id: target, name: path.basename(target) });
      }
      if (req.method === 'GET' && url.pathname.endsWith(':/children')) {
        const folder = itemPath(url.pathname, ':/children');
        const value = [...files.keys()]
          .filter(p => path.dirname(p) === folder)
          .map(p => ({ name: path.basename(p) }));
        return json(200, { value });
      }
      if (req.method === 'DELETE') {
        files.delete(itemPath(url.pathname));
        res.writeHead(204).end();
        return;
      }
      json(404, {});
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
}, 60_000);

let openPool: { closePool: () => Promise<void> } | undefined;
async function load() {
  await openPool?.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return import('./backup');
}

afterAll(async () => {
  await openPool?.closePool();
  await new Promise(resolve => server.close(resolve));
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('which backups are kept', () => {
  const pair = (day: string) => [
    `members-backup-${day}.xlsx`,
    `transactions-backup-${day}.xlsx`,
  ];

  it('keeps the new day and the four newest before it, both files of each, and nothing else of ours goes', async () => {
    const { backupsToRemove, BACKUPS_KEPT } = await load();
    expect(BACKUPS_KEPT).toBe(5);
    const names = [
      ...['08', '09', '10', '11', '12', '13', '14'].flatMap(d =>
        pair(`2026-10-${d}`)
      ),
      'members-before-reset-2026-10-01-1530.xlsx',
      'notes.docx',
    ];
    expect(backupsToRemove(names, '2026-10-14').sort()).toEqual([
      'members-backup-2026-10-08.xlsx',
      'members-backup-2026-10-09.xlsx',
      'transactions-backup-2026-10-08.xlsx',
      'transactions-backup-2026-10-09.xlsx',
    ]);
  });

  it('removes nothing while there are four earlier days or fewer', async () => {
    const { backupsToRemove } = await load();
    expect(
      backupsToRemove(
        ['11', '12', '13', '14', '15'].flatMap(d => pair(`2026-10-${d}`)),
        '2026-10-15'
      )
    ).toEqual([]);
  });

  it('counts a day once whether one file of it or both are there', async () => {
    const { backupsToRemove } = await load();
    expect(
      backupsToRemove(
        [
          'members-backup-2026-10-10.xlsx',
          ...['11', '12', '13', '14'].flatMap(d => pair(`2026-10-${d}`)),
          'members-backup-2026-10-15.xlsx',
        ],
        '2026-10-15'
      )
    ).toEqual(['members-backup-2026-10-10.xlsx']);
  });
});

describe('a backup run, night after night', () => {
  const night = (day: string) => new Date(`${day}T00:00:30+04:00`);
  const days = ['14', '15', '16', '17', '18', '19'].map(d => `2026-10-${d}`);

  it('holds five days at a time: the sixth night replaces the first', async () => {
    const { backupMembers, BACKUP_FOLDER } = await load();
    expect(BACKUP_FOLDER).toBe('Test/Al Barakah MCSL – Backups');
    const held = (from: number, to: number) =>
      days
        .slice(from, to)
        .flatMap(d => [
          `${BACKUP_FOLDER}/members-backup-${d}.xlsx`,
          `${BACKUP_FOLDER}/transactions-backup-${d}.xlsx`,
        ])
        .sort();

    for (const day of days.slice(0, 5)) {
      const outcome = await backupMembers({ at: night(day), config: config() });
      expect(outcome.removed).toEqual([]);
    }
    expect([...files.keys()].sort()).toEqual(held(0, 5));

    const sixth = await backupMembers({ at: night(days[5]), config: config() });
    expect(sixth.removed.sort()).toEqual([
      'members-backup-2026-10-14.xlsx',
      'transactions-backup-2026-10-14.xlsx',
    ]);
    expect([...files.keys()].sort()).toEqual(held(1, 6));
  });

  it('replaces the day’s files when run twice the same day', async () => {
    const { backupMembers, BACKUP_FOLDER } = await load();
    const before = files.size;
    await backupMembers({ at: night('2026-10-19'), config: config() });
    expect(files.size).toBe(before);
    expect(conflictBehaviours.every(b => b === 'replace')).toBe(true);
    expect(files.has(`${BACKUP_FOLDER}/members-backup-2026-10-19.xlsx`)).toBe(
      true
    );
    expect(
      files.has(`${BACKUP_FOLDER}/transactions-backup-2026-10-19.xlsx`)
    ).toBe(true);
  });

  it('saves the export itself: the template’s sheets, opened as a workbook', async () => {
    const { BACKUP_FOLDER } = await load();
    const saved = files.get(`${BACKUP_FOLDER}/members-backup-2026-10-19.xlsx`)!;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(saved as any);
    expect(workbook.worksheets.map(w => w.name)).toEqual(
      expect.arrayContaining(['Instructions', 'Individual', 'Minor'])
    );
  });

  it('is recorded as an export, by the job', async () => {
    const audit = await run(
      appUrl,
      `select actor_description from audit_event
        where action = 'migration.exported' order by occurred_at desc limit 1`
    );
    expect(audit.rows[0]?.actor_description).toBe('members-backup job');
  });
});

describe('the transactions file', () => {
  it('holds every entry, adding up to each account’s balance, with each transaction and its steps', async () => {
    const { backupMembers, BACKUP_FOLDER } = await load();
    const { openEveryDrawer } = await import('../cash/drawers.testing');
    const deposits = await import('../ledger/deposits');
    const withdrawals = await import('../ledger/withdrawals');

    const user = await run(
      appUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ('backup-officer', 'officer@albarakah.mu', 'Officer') returning id`
    );
    const officer = {
      userId: user.rows[0].id,
      entraSubject: 'backup-officer',
      email: 'officer@albarakah.mu',
      displayName: 'Officer',
      roles: ['account_officer'],
      roleNames: ['Account Officer'],
      permissions: new Set([
        'transaction.capture',
        'transaction.post',
        'transaction.disburse',
        'transaction.view',
      ]),
    };
    await openEveryDrawer(appUrl);

    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [type.rows[0].id, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [
        application.rows[0].id,
        JSON.stringify({ name: 'Fatimah', surname: 'Test' }),
      ]
    );
    const member = await run(
      appUrl,
      `insert into member (member_no, application_id, membership_type_id)
       values ('AB0001', $1, $2) returning id`,
      [application.rows[0].id, type.rows[0].id]
    );
    const account = await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       select $1, id, true, 'active' from account_type where code = 'msa'
       returning id`,
      [member.rows[0].id]
    );
    const accountId = account.rows[0].id;
    await deposits.recordDeposit(
      { accountId, amount: '1000', method: 'cash' },
      officer
    );
    await deposits.recordDeposit(
      { accountId, amount: '500', method: 'cash' },
      officer
    );
    await withdrawals.recordWithdrawal(
      { accountId, amount: '300', method: 'cash' },
      officer
    );

    const outcome = await backupMembers({
      at: new Date('2026-10-20T00:00:30+04:00'),
      config: config(),
    });
    expect(outcome.transactions).toBe(3);
    expect(outcome.entries).toBe(3);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      files.get(`${BACKUP_FOLDER}/transactions-backup-2026-10-20.xlsx`) as any
    );
    expect(workbook.worksheets.map(w => w.name)).toEqual([
      'Entries',
      'Transactions',
      'Approvals',
      'Accounts',
    ]);

    const rows = (name: string) => {
      const ws = workbook.getWorksheet(name)!;
      const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      const out: Record<string, unknown>[] = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const values = (row.values as unknown[]).slice(1);
        out.push(Object.fromEntries(headers.map((h, i) => [h, values[i]])));
      });
      return out;
    };

    const entries = rows('Entries');
    expect(entries.map(e => [e['Kind'], e['Direction'], e['Amount']])).toEqual([
      ['Deposit', 'In', 1000],
      ['Deposit', 'In', 500],
      ['Withdrawal', 'Out', 300],
    ]);
    expect(entries.every(e => e['Holder'] === 'AB0001')).toBe(true);
    expect(entries.every(e => e['Holder name'] === 'Test Fatimah')).toBe(true);
    expect(
      entries.every(e => e['Account Type'] === 'Multiplier Savings Account')
    ).toBe(true);
    expect(
      entries.every(e => /^\d{4}-\d{2}-\d{2} /.test(String(e['Posted at'])))
    ).toBe(true);

    const accounts = rows('Accounts');
    expect(accounts).toHaveLength(1);
    const sum = entries.reduce(
      (total, e) =>
        total + (e['Direction'] === 'In' ? 1 : -1) * Number(e['Amount']),
      0
    );
    expect(accounts[0]['Balance']).toBe(1200);
    expect(sum).toBe(1200);
    expect(accounts[0]['Entries']).toBe(3);

    expect(rows('Transactions').map(t => t['Status'])).toEqual([
      'posted',
      'posted',
      'posted',
    ]);
    expect(rows('Approvals').length).toBeGreaterThan(0);
  });
});
