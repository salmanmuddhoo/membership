// The nightly members backup: the export saved to SharePoint, two days
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
  it('keeps the new file and the newest before it, and nothing else of ours goes', async () => {
    const { backupsToRemove } = await load();
    const names = [
      'members-backup-2026-10-12.xlsx',
      'members-backup-2026-10-13.xlsx',
      'members-backup-2026-10-14.xlsx',
      'members-backup-2026-10-10.xlsx',
      'notes.docx',
    ];
    expect(
      backupsToRemove(names, 'members-backup-2026-10-14.xlsx').sort()
    ).toEqual([
      'members-backup-2026-10-10.xlsx',
      'members-backup-2026-10-12.xlsx',
    ]);
  });

  it('removes nothing while there is only one earlier day', async () => {
    const { backupsToRemove } = await load();
    expect(
      backupsToRemove(
        ['members-backup-2026-10-14.xlsx', 'members-backup-2026-10-15.xlsx'],
        'members-backup-2026-10-15.xlsx'
      )
    ).toEqual([]);
  });
});

describe('a backup run, night after night', () => {
  const night = (day: string) => new Date(`${day}T00:00:30+04:00`);

  it('holds two days at a time: the third night replaces the first', async () => {
    const { backupMembers, BACKUP_FOLDER } = await load();
    expect(BACKUP_FOLDER).toBe('Test/Al Barakah MCSL – Backups');

    await backupMembers({ at: night('2026-10-14'), config: config() });
    await backupMembers({ at: night('2026-10-15'), config: config() });
    expect([...files.keys()].sort()).toEqual([
      `${BACKUP_FOLDER}/members-backup-2026-10-14.xlsx`,
      `${BACKUP_FOLDER}/members-backup-2026-10-15.xlsx`,
    ]);

    const third = await backupMembers({
      at: night('2026-10-16'),
      config: config(),
    });
    expect(third.removed).toEqual(['members-backup-2026-10-14.xlsx']);
    expect([...files.keys()].sort()).toEqual([
      `${BACKUP_FOLDER}/members-backup-2026-10-15.xlsx`,
      `${BACKUP_FOLDER}/members-backup-2026-10-16.xlsx`,
    ]);
  });

  it('replaces the day’s file when run twice the same day', async () => {
    const { backupMembers, BACKUP_FOLDER } = await load();
    const before = files.size;
    await backupMembers({ at: night('2026-10-16'), config: config() });
    expect(files.size).toBe(before);
    expect(conflictBehaviours.every(b => b === 'replace')).toBe(true);
    expect(files.has(`${BACKUP_FOLDER}/members-backup-2026-10-16.xlsx`)).toBe(
      true
    );
  });

  it('saves the export itself: the template’s sheets, opened as a workbook', async () => {
    const { BACKUP_FOLDER } = await load();
    const saved = files.get(`${BACKUP_FOLDER}/members-backup-2026-10-16.xlsx`)!;
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
