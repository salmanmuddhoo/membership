// The document directory (officer feedback): what counts as a holder's
// paper, and what does not — a draft application's upload, or another
// member's.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);
const dbName = `document_directory_test_${Date.now()}`;
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

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';

const directory = await import('./directory');
const pool = await import('../db/pool');

let officerId: string;
let typeId: string;
let documentTypeId: string;
let fatimah: { memberId: string; applicationId: string };
let yusuf: { memberId: string; applicationId: string };
let additionalReference: string;

async function member(memberNo: string, name: string) {
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [typeId, officerId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [application.rows[0].id, JSON.stringify({ name, surname: 'Test' })]
  );
  const row = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [memberNo, application.rows[0].id, typeId]
  );
  return { memberId: row.rows[0].id, applicationId: application.rows[0].id };
}

async function additionalApplication(memberId: string, status: string) {
  const row = await run(
    appUrl,
    `insert into membership_application
       (application_kind, existing_member_id, captured_by, status)
     values ('additional_account', $1, $2, $3) returning id, reference`,
    [memberId, officerId, status]
  );
  return row.rows[0] as { id: string; reference: string };
}

async function filed(
  owner: { applicationId?: string; memberId?: string },
  fileName = 'ID card.jpg',
  committed = true,
  // One document per type and subject on an application, so a second one
  // on the same application goes under another subject.
  subject = 'applicant'
) {
  const doc = await run(
    appUrl,
    `insert into document
       (document_type_id, subject, application_id, member_id, state)
     values ($1, $4, $2, $3, 'verified') returning id`,
    [
      documentTypeId,
      owner.applicationId ?? null,
      owner.memberId ?? null,
      subject,
    ]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, $4, $5, 'image/jpeg', 1234, $3, $2, now())`,
    [
      doc.rows[0].id,
      officerId,
      `/test/${doc.rows[0].id}.jpg`,
      committed ? 'committed' : 'pending',
      fileName,
    ]
  );
  return doc.rows[0].id as string;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  officerId = (
    await run(
      appUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ('test-officer', 'officer@albarakah.mu', 'Officer') returning id`
    )
  ).rows[0].id;
  typeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  documentTypeId = (
    await run(appUrl, `select id from document_type where code = 'id_card'`)
  ).rows[0].id;

  fatimah = await member('AB0001', 'Fatimah');
  yusuf = await member('AB0002', 'Yusuf');

  await filed({ applicationId: fatimah.applicationId }, 'founding.jpg');
  await filed({ memberId: fatimah.memberId }, 'carried.jpg');
  const additional = await additionalApplication(fatimah.memberId, 'approved');
  additionalReference = additional.reference;
  await filed({ applicationId: additional.id }, 'additional.jpg');
  // Not on file: a draft application's upload, and one never committed.
  const draft = await additionalApplication(fatimah.memberId, 'draft');
  await filed({ applicationId: draft.id }, 'draft.jpg');
  await filed(
    { applicationId: fatimah.applicationId },
    'pending.jpg',
    false,
    'nominee'
  );
  await filed({ applicationId: yusuf.applicationId }, 'theirs.jpg');
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('the document directory', () => {
  it('counts what is on file per holder: founding, carried and additional, never a draft or a pending upload', async () => {
    const counts = await directory.documentCountsForHolders([
      fatimah.memberId,
      yusuf.memberId,
    ]);
    expect(counts.get(fatimah.memberId)).toBe(3);
    expect(counts.get(yusuf.memberId)).toBe(1);
    expect((await directory.documentCountsForHolders([])).size).toBe(0);
  });

  it("lists one holder's papers with where each was filed, and nobody else's", async () => {
    const papers = await directory.documentsForHolder(fatimah.memberId);
    expect(papers.map(p => p.fileName).sort()).toEqual([
      'additional.jpg',
      'carried.jpg',
      'founding.jpg',
    ]);
    const bySource = Object.fromEntries(
      papers.map(p => [p.fileName, [p.sourceKind, p.source]])
    );
    expect(bySource['carried.jpg']).toEqual(['member', null]);
    expect(bySource['additional.jpg']).toEqual([
      'application',
      additionalReference,
    ]);
    expect(bySource['founding.jpg'][0]).toBe('application');
    expect(papers.every(p => p.filedByName === 'Officer')).toBe(true);
    expect(papers.every(p => p.documentName.length > 0)).toBe(true);

    expect(
      (await directory.documentsForHolder(yusuf.memberId)).map(p => p.fileName)
    ).toEqual(['theirs.jpg']);
  });
});
