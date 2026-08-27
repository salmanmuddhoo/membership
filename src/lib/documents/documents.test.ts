// Filing documents and driving the checklist (M4, S-405 to S-410).
//
// Graph is faked. What is under test is the state machine and the rule that a
// document is not filed until SharePoint says so — the network behaviour of
// the upload session was proved separately in M1 (upload.test.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const dbName = `documents_test_${Date.now()}`;
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

// Configuration tables refuse a write that cannot be attributed (S-210), so a
// fixture that touches one has to say who it is, exactly as the application
// does through withConfigurationActor.
async function runAsConfigurator(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    const result = await client.query(sql);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

// A stand-in drive. Records what was created so the tests can assert on
// folders, and lets a test make a file arrive truncated or not at all.
interface FakeDrive {
  folders: string[];
  files: Map<string, { id: string; size: number }>;
}

let drive: FakeDrive;

function resetDrive() {
  drive = { folders: [], files: new Map() };
}

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';

  vi.doMock('./graph', async () => {
    const actual = await vi.importActual<typeof import('./graph')>('./graph');
    return {
      ...actual,
      ensureFolder: async (parent: string, name: string) => {
        drive.folders.push(parent ? `${parent}/${name}` : name);
      },
      getItemByPath: async (itemPath: string) => {
        const file = drive.files.get(itemPath);
        return file ? { ...file, name: itemPath, webUrl: 'https://x' } : null;
      },
    };
  });

  vi.doMock('./upload', async () => {
    const actual = await vi.importActual<typeof import('./upload')>('./upload');
    return {
      ...actual,
      createUploadTicket: async (request: {
        folderPath: string;
        fileName: string;
      }) => ({
        uploadUrl: 'https://upload.invalid/session',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        chunkSize: 327_680,
        itemPath: `${request.folderPath}/${request.fileName}`,
      }),
    };
  });

  return {
    documents: await import('./documents'),
    config: await import('../config/reference'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.doUnmock('./graph');
  vi.doUnmock('./upload');
});

let officer: { userId: string; email: string };
let secretary: {
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
};
let applicationId: string;
let idCardTypeId: string;

beforeAll(async () => {
  resetDrive();
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer'),
            ('secretary@albarakah.mu', 'Secretary')
     returning id, email::text as email`
  );
  const id = (email: string) => users.rows.find(r => r.email === email).id;
  officer = {
    userId: id('officer@albarakah.mu'),
    email: 'officer@albarakah.mu',
  };
  secretary = {
    userId: id('secretary@albarakah.mu'),
    email: 'secretary@albarakah.mu',
    permissions: new Set(['document.view', 'document.verify']),
  };

  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by)
     values ($1, $2) returning id`,
    [type.rows[0].id, officer.userId]
  );
  applicationId = application.rows[0].id;

  const docType = await run(
    appUrl,
    `select id from document_type where code = 'id_card'`
  );
  idCardTypeId = docType.rows[0].id;
}, 60_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-407: the checklist comes from the configuration', () => {
  it('lists what an Individual application requires, all missing', async () => {
    const { documents } = await load();
    const checklist = await documents.checklistFor({ applicationId });

    expect(checklist.length).toBeGreaterThan(0);
    expect(checklist.every(e => e.state === 'missing')).toBe(true);
    // The applicant's ID card and the signed form, and an ID card for the
    // nominee — nothing in this module knows that; the configuration does.
    expect(
      checklist.filter(e => e.subject === 'applicant').map(e => e.documentCode)
    ).toEqual(
      expect.arrayContaining(['id_card', 'utility_bill', 'signed_form'])
    );
    expect(
      checklist.some(
        e => e.subject === 'nominee' && e.documentCode === 'id_card'
      )
    ).toBe(true);
  });

  it('is not complete while anything required is missing', async () => {
    const { documents } = await load();
    const checklist = await documents.checklistFor({ applicationId });
    expect(documents.isDocumentComplete(checklist)).toBe(false);
  });
});

describe('S-408: a document is filed only when SharePoint says so', () => {
  it('still reads Missing after begin, before the bytes arrive', async () => {
    const { documents } = await load();

    await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'applicant',
        fileName: 'id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );

    // The row exists; the file does not. An officer whose tablet died here
    // must not come back to a checklist claiming the card is filed.
    const checklist = await documents.checklistFor({ applicationId });
    const entry = checklist.find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;
    expect(entry.state).toBe('missing');
  });

  it('refuses to commit when the file is not in the drive', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'applicant',
        fileName: 'id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );

    // The browser claims success. Graph disagrees, and Graph is the authority
    // because the bytes never came through us.
    await expect(
      documents.commitUpload(begun.versionId, officer)
    ).rejects.toThrowError(/not in SharePoint/);

    const state = await run(
      appUrl,
      'select state from document_version where id = $1',
      [begun.versionId]
    );
    expect(state.rows[0].state).toBe('failed');
    const checklist = await documents.checklistFor({ applicationId });
    expect(
      checklist.find(
        e => e.subject === 'applicant' && e.documentCode === 'id_card'
      )!.state
    ).toBe('missing');
  });

  it('refuses a truncated file', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'applicant',
        fileName: 'id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );

    // Half the bytes arrived. A Verified tick over half a document is worse
    // than no document.
    drive.files.set(begun.ticket.itemPath, { id: 'graph-1', size: 2048 });

    await expect(
      documents.commitUpload(begun.versionId, officer)
    ).rejects.toThrowError(/incomplete/);

    drive.files.delete(begun.ticket.itemPath);
  });

  it('files it once the bytes are really there', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'applicant',
        fileName: 'id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-ok', size: 4096 });

    await documents.commitUpload(begun.versionId, officer, {
      checksumSha256: 'abc123',
    });

    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;
    expect(entry.state).toBe('under_review');
    expect(entry.uploadedByName).toBe('Officer');
    expect(entry.versionCount).toBe(1);
  });

  it('is idempotent, so a retried commit does not double-file', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;
    const versions = await documents.versionsOf(entry.documentId!);

    await expect(
      documents.commitUpload(versions[0].id, officer)
    ).resolves.toEqual({ state: 'committed' });

    expect(await documents.versionsOf(entry.documentId!)).toHaveLength(
      versions.length
    );
  });

  // The commit is what writes document.filed to the audit trail, and
  // segregation of duties reads that trail. If anyone could commit anyone's
  // upload, the wrong name would be recorded as having filed the document.
  it('refuses a commit from someone other than the person who began it', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'nominee',
        fileName: 'nominee-id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-other', size: 2048 });

    await expect(
      documents.commitUpload(begun.versionId, secretary)
    ).rejects.toThrow(/started by someone else/i);

    // Still not filed, and no filing recorded against the wrong person.
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    expect(entry.state).toBe('missing');
    const audited = await run(
      appUrl,
      `select count(*)::int as n from audit_event
        where action = 'document.filed' and actor_user_id = $1`,
      [secretary.userId]
    );
    expect(audited.rows[0].n).toBe(0);

    // And the person who did begin it can still finish it.
    await expect(
      documents.commitUpload(begun.versionId, officer)
    ).resolves.toEqual({ state: 'committed' });
  });

  it('records the filing against the person who did it', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;

    const audited = await run(
      appUrl,
      `select actor_description from audit_event
        where action = 'document.filed' and entity_id = $1`,
      [entry.documentId]
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].actor_description).toBe(officer.email);
  });
});

describe('a file the service will not take', () => {
  it('is refused before a folder is created for it', async () => {
    const { documents } = await load();

    // A brand new application, so its folder has never been created. Against
    // the application the other tests use, the folder already exists and
    // ensureFolderPath would short-circuit — the assertion below would then
    // hold whatever the order of operations was, and prove nothing.
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const fresh = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by)
       values ($1, $2) returning id`,
      [type.rows[0].id, officer.userId]
    );

    // Snapshot rather than reset: the drive is shared with the tests around
    // this one, and what matters is that this call adds nothing to it.
    const foldersBefore = [...drive.folders];

    await expect(
      documents.beginUpload(
        {
          applicationId: fresh.rows[0].id,
          documentTypeId: idCardTypeId,
          subject: 'applicant',
          fileName: 'notes.docx',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 4096,
          expiresAt: new Date('2030-01-01'),
        },
        officer
      )
    ).rejects.toThrow(/photograph or a PDF/i);

    // Nothing was created in the drive on the way to refusing it.
    expect(drive.folders).toEqual(foldersBefore);
  });
});

describe('S-405: folders are created once', () => {
  it('creates the application folder path, and not again', async () => {
    const { documents } = await load();
    const created = [...drive.folders];

    expect(created).toEqual(
      expect.arrayContaining([expect.stringContaining('Applications')])
    );

    // A second document for the same application must not re-walk the path.
    const before = drive.folders.length;
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'nominee',
        fileName: 'nominee-id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 512,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    expect(drive.folders.length).toBe(before);

    drive.files.set(begun.ticket.itemPath, { id: 'graph-nominee', size: 512 });
    await documents.commitUpload(begun.versionId, officer);
  });

  it('names a member folder by identifier first', async () => {
    const { documents } = await load();
    expect(documents.memberFolderName('ABM-000125', 'Ahmed Mohamed')).toBe(
      'ABM-000125 – Ahmed Mohamed'
    );
    // A name with characters SharePoint refuses must not produce a broken path.
    expect(documents.memberFolderName('ABM-000126', 'A/B:C*D')).toBe(
      'ABM-000126 – ABCD'
    );
    // And a member with no name yet still gets a folder.
    expect(documents.memberFolderName('ABM-000127', '   ')).toBe('ABM-000127');
  });
});

describe('S-407: verifying, and who may', () => {
  it('refuses the officer who filed it, even with the permission', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;

    // Entitled to verify documents in general; filed this one.
    const officerWhoCanVerify = {
      ...officer,
      permissions: new Set(['document.verify']) as ReadonlySet<string>,
    };

    await expect(
      documents.reviewDocument(
        entry.documentId!,
        { outcome: 'verify' },
        officerWhoCanVerify
      )
    ).rejects.toThrowError(/may not verify it/);
  });

  it('refuses someone without the permission at all', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;

    await expect(
      documents.reviewDocument(
        entry.documentId!,
        { outcome: 'verify' },
        { ...officer, permissions: new Set() }
      )
    ).rejects.toThrowError(/permission/);
  });

  it('lets the Secretary verify it', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;

    await documents.reviewDocument(
      entry.documentId!,
      { outcome: 'verify' },
      secretary
    );

    const after = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;
    expect(after.state).toBe('verified');
    expect(after.verifiedByName).toBe('Secretary');
  });

  it('requires a reason to reject', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;

    await expect(
      documents.reviewDocument(
        entry.documentId!,
        { outcome: 'reject', reason: '  ' },
        secretary
      )
    ).rejects.toThrowError(/requires a reason/);

    await documents.reviewDocument(
      entry.documentId!,
      { outcome: 'reject', reason: 'The photograph is out of focus.' },
      secretary
    );

    const after = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    expect(after.state).toBe('rejected');
    expect(after.rejectionReason).toBe('The photograph is out of focus.');
  });

  it('refuses to verify a document with nothing filed against it', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'guardian',
        fileName: 'guardian.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );

    await expect(
      documents.reviewDocument(
        begun.documentId,
        { outcome: 'verify' },
        secretary
      )
    ).rejects.toThrowError(/no filed version/);
  });
});

describe('S-409: replacing a document keeps the original', () => {
  it('supersedes the old version rather than deleting it', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    const before = await documents.versionsOf(entry.documentId!);

    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'nominee',
        fileName: 'nominee-id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 999,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-v2', size: 999 });
    await documents.commitUpload(begun.versionId, officer);

    const after = await documents.versionsOf(entry.documentId!);
    expect(after).toHaveLength(before.length + 1);
    // The earlier file is still there, marked superseded — for the signed
    // form that is the whole point: what was signed stays retrievable.
    expect(after.filter(v => v.supersededAt !== null).length).toBe(
      before.length
    );
    expect(after[0].supersededAt).toBeNull();
  });

  it('returns a replaced document to review, losing the old verdict', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    // It was rejected; the replacement that COMMITTED cleared that, because
    // the verdict was about a file that is no longer the live one.
    expect(entry.state).toBe('under_review');
    expect(entry.rejectionReason).toBeNull();
  });

  it('leaves the verdict alone when the replacement never arrives', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'signed_form'
    )!;

    // File it, and have the Secretary verify it.
    const first = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: (
          await run(
            appUrl,
            `select id from document_type where code = 'signed_form'`
          )
        ).rows[0].id,
        subject: 'applicant',
        fileName: 'signed.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      },
      officer
    );
    drive.files.set(first.ticket.itemPath, { id: 'graph-signed', size: 2048 });
    await documents.commitUpload(first.versionId, officer);
    await documents.reviewDocument(
      first.documentId,
      { outcome: 'verify' },
      secretary
    );

    // Now start a replacement that never lands.
    const failed = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: (
          await run(
            appUrl,
            `select id from document_type where code = 'signed_form'`
          )
        ).rows[0].id,
        subject: 'applicant',
        fileName: 'signed.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
      },
      officer
    );
    await expect(
      documents.commitUpload(failed.versionId, officer)
    ).rejects.toThrowError(/not in SharePoint/);

    // The verified document is untouched. Downgrading it here would discard a
    // verdict about a file that is still the live one.
    const after = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'signed_form'
    )!;
    expect(after.state).toBe('verified');
    expect(after.verifiedByName).toBe('Secretary');
    expect(entry).toBeDefined();
  });

  it('does not remove the good version when a replacement fails', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    const live = (await documents.versionsOf(entry.documentId!)).find(
      v => v.supersededAt === null
    )!;

    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'nominee',
        fileName: 'nominee-id.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 777,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    // The replacement never arrives.
    await expect(
      documents.commitUpload(begun.versionId, officer)
    ).rejects.toThrowError(/not in SharePoint/);

    const stillLive = (await documents.versionsOf(entry.documentId!)).find(
      v => v.supersededAt === null
    )!;
    expect(stillLive.id).toBe(live.id);
  });
});

describe('S-410: expiry', () => {
  // Created here rather than taken from the seeds: no document the Society
  // currently accepts expires, so pinning this to one would make it fail the
  // day that changes. What is under test is the rule, not the catalogue.
  it('requires an expiry date for a type that tracks one', async () => {
    const { documents } = await load();
    const expiring = await runAsConfigurator(
      appUrl,
      `insert into document_type (code, name, description, tracks_expiry)
       values ('passport', 'Passport', 'Expires, unlike the NIC', true)
       on conflict (code) do update set tracks_expiry = true
       returning id`
    );

    await expect(
      documents.beginUpload(
        {
          applicationId,
          documentTypeId: expiring.rows[0].id,
          subject: 'beneficiary',
          fileName: 'x.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
        },
        officer
      )
    ).rejects.toThrowError(/expiry date is required/);
  });

  it('expires a verified document whose date has passed, and no other', async () => {
    const { documents } = await load();
    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'applicant' && e.documentCode === 'id_card'
    )!;
    expect(entry.state).toBe('verified');

    await run(
      appUrl,
      `update document set expires_at = now() - interval '1 day' where id = $1`,
      [entry.documentId]
    );
    // A document still under review also has a past date. It has a more
    // pressing problem than expiry, and moving it to Expired would hide that.
    const underReview = (await documents.checklistFor({ applicationId })).find(
      e => e.subject === 'nominee' && e.documentCode === 'id_card'
    )!;
    await run(
      appUrl,
      `update document set expires_at = now() - interval '1 day' where id = $1`,
      [underReview.documentId]
    );

    const { expired } = await documents.expireDocuments();
    expect(expired).toBe(1);

    const after = await documents.checklistFor({ applicationId });
    expect(
      after.find(
        e => e.subject === 'applicant' && e.documentCode === 'id_card'
      )!.state
    ).toBe('expired');
    expect(
      after.find(e => e.subject === 'nominee' && e.documentCode === 'id_card')!
        .state
    ).toBe('under_review');
  });

  it('records the expiry as the system, not as a person', async () => {
    const { documents } = await load();
    const audited = await run(
      appUrl,
      `select actor_user_id, actor_description from audit_event
        where action = 'document.expired' limit 1`
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].actor_user_id).toBeNull();
    expect(audited.rows[0].actor_description).toContain('scheduled job');
  });

  it('no longer counts an expired document as complete', async () => {
    const { documents } = await load();
    const checklist = await documents.checklistFor({ applicationId });
    expect(documents.isDocumentComplete(checklist)).toBe(false);
  });
});
