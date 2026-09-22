import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { MemberPrincipal } from './identity';

// A member opening one of their own documents from the app: the bytes come
// from SharePoint through getDocumentContent, as for an officer, so the
// only question the member endpoint adds is whether the document is the
// caller's own — and that is answered here, against a real database.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_documents_test_${Date.now()}`;
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

const profile = await import('./profile');
const pool = await import('../db/pool');

let officerId: string;
let typeId: string;
let documentTypeId: string;
let fatimah: MemberPrincipal;
let yusuf: MemberPrincipal;
let applicant: MemberPrincipal;

const docs: Record<string, string> = {};

function memberPrincipal(memberId: string | null, mobile: string) {
  return {
    sessionId: `session-${mobile}`,
    mobile,
    memberId,
    customerId: null,
    kind: memberId ? 'member' : 'applicant',
  } as MemberPrincipal;
}

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
     values ('additional_account', $1, $2, $3) returning id`,
    [memberId, officerId, status]
  );
  return row.rows[0].id as string;
}

// An application's checklist is the snapshot taken at capture
// (application_checklist_item), not the type's live one; one row is enough
// for the listing to have somewhere to put an ID card.
async function snapshot(applicationId: string) {
  await run(
    appUrl,
    `insert into application_checklist_item
       (application_id, document_type_id, subject, requirement, sort_order)
     values ($1, $2, 'applicant', 'required', 1)`,
    [applicationId, documentTypeId]
  );
  return applicationId;
}

// A filed document — one committed version — against an application or
// carried onto a member record.
async function filed(owner: { applicationId?: string; memberId?: string }) {
  const doc = await run(
    appUrl,
    `insert into document
       (document_type_id, subject, application_id, member_id, state)
     values ($1, 'applicant', $2, $3, 'verified') returning id`,
    [documentTypeId, owner.applicationId ?? null, owner.memberId ?? null]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'ID card.jpg', 'image/jpeg', 1234,
             $3, $2, now())`,
    [doc.rows[0].id, officerId, `/test/${doc.rows[0].id}.jpg`]
  );
  return doc.rows[0].id as string;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer') returning id`
  );
  officerId = user.rows[0].id;
  typeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  documentTypeId = (
    await run(appUrl, `select id from document_type where code = 'id_card'`)
  ).rows[0].id;

  const first = await member('AB0001', 'Fatimah');
  const second = await member('AB0002', 'Yusuf');
  fatimah = memberPrincipal(first.memberId, '+23057891234');
  yusuf = memberPrincipal(second.memberId, '+23057895678');
  applicant = memberPrincipal(null, '+23057890000');

  docs.founding = await filed({
    applicationId: await snapshot(first.applicationId),
  });
  docs.carried = await filed({ memberId: first.memberId });
  docs.additional = await filed({
    applicationId: await snapshot(
      await additionalApplication(first.memberId, 'approved')
    ),
  });
  docs.draft = await filed({
    applicationId: await snapshot(
      await additionalApplication(first.memberId, 'draft')
    ),
  });
  docs.theirs = await filed({
    applicationId: await snapshot(second.applicationId),
  });
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('which documents a member may open', () => {
  it('their own: on the founding application, carried onto the record, or on an account application that left draft', async () => {
    expect(await profile.ownedDocumentId(fatimah, docs.founding)).toBe(
      docs.founding
    );
    expect(await profile.ownedDocumentId(fatimah, docs.carried)).toBe(
      docs.carried
    );
    expect(await profile.ownedDocumentId(fatimah, docs.additional)).toBe(
      docs.additional
    );
  });

  it('nothing else, and always the same not_found', async () => {
    const refused = { code: 'not_found', message: 'No such document.' };
    // Someone else's.
    await expect(
      profile.ownedDocumentId(fatimah, docs.theirs)
    ).rejects.toMatchObject(refused);
    await expect(
      profile.ownedDocumentId(yusuf, docs.founding)
    ).rejects.toMatchObject(refused);
    // Their own draft: not listed, so not opened either.
    await expect(
      profile.ownedDocumentId(fatimah, docs.draft)
    ).rejects.toMatchObject(refused);
    // An applicant session holds no member, so no documents.
    await expect(
      profile.ownedDocumentId(applicant, docs.founding)
    ).rejects.toMatchObject(refused);
    // Not even a uuid.
    await expect(
      profile.ownedDocumentId(fatimah, 'not-an-id')
    ).rejects.toMatchObject(refused);
  });

  it('opens exactly what the listing shows', async () => {
    const listed = await profile.memberDocuments(fatimah);
    const ids = listed.map(d => d.id).sort();
    expect(ids).toEqual([docs.founding, docs.additional].sort());
    for (const id of ids) {
      expect(await profile.ownedDocumentId(fatimah, id)).toBe(id);
    }
  });
});
