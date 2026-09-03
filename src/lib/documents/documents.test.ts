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

// The pool the last load() built.
//
// Each load() calls vi.resetModules(), which builds a NEW pool on the next
// import. The one it replaces has to be given back: an abandoned pool holds
// its connections until they idle out, and a suite that loads this often then
// exhausts the server's connection slots — which fails as
// "remaining connection slots are reserved", far from the test that caused it.
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

  vi.doMock('./graph', async () => {
    const actual = await vi.importActual<typeof import('./graph')>('./graph');
    return {
      ...actual,
      ensureFolder: async (parent: string, name: string) => {
        drive.folders.push(parent ? `${parent}/${name}` : name);
      },
      getItemByPath: async (itemPath: string) => {
        const file = drive.files.get(itemPath);
        return file
          ? {
              ...file,
              name: itemPath,
              webUrl: 'https://x',
              downloadUrl: `https://download.invalid/${encodeURIComponent(itemPath)}`,
            }
          : null;
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
    capture: await import('../applications/capture'),
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
  // Before the drop, so the last pool's connections are handed back rather
  // than terminated out from under it.
  await closeOpenPool();
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

// S-612: an additional-account application has no membership_type_id — the
// bug this closes is resolveOwner's old inner join to membership_type
// silently returning zero rows for one of these, which checklistFor then
// misreported as "That application no longer exists." The application was
// never missing; the checklist source was just the wrong table.
describe('S-612: the checklist for an additional-account application comes from its account types', () => {
  let additionalAccountApplicationId: string;

  beforeAll(async () => {
    const member = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const holder = await run(
      appUrl,
      `insert into member (membership_type_id, status) values ($1, 'active')
       returning id`,
      [member.rows[0].id]
    );

    // Reuses the seeded 'msa_opening' checklist rather than inventing a new
    // one — what is under test is that an additional_account application
    // reads its checklist from account_type at all, not which checklist.
    const checklist = await run(
      appUrl,
      `select id from document_checklist where code = 'msa_opening'`
    );
    const accountType = await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, checklist_id,
          is_membership_default)
       values ('hsa_docs_test', 'HSA (documents test)', 'savings', 1000,
               '${checklist.rows[0].id}', false)
       returning id`
    );

    const application = await run(
      appUrl,
      `insert into membership_application
         (application_kind, existing_member_id, captured_by)
       values ('additional_account', $1, $2)
       returning id`,
      [holder.rows[0].id, officer.userId]
    );
    additionalAccountApplicationId = application.rows[0].id;

    await run(
      appUrl,
      `insert into application_account_selection
         (application_id, account_type_id)
       values ($1, $2)`,
      [additionalAccountApplicationId, accountType.rows[0].id]
    );
  });

  it('lists what the selected account type requires, not "not found"', async () => {
    const { documents } = await load();
    const checklist = await documents.checklistFor({
      applicationId: additionalAccountApplicationId,
    });

    expect(checklist.length).toBeGreaterThan(0);
    expect(checklist.every(e => e.state === 'missing')).toBe(true);
    expect(checklist.map(e => e.documentCode)).toEqual(
      expect.arrayContaining(['id_card'])
    );
  });
});

// S-614: a customer_account application reuses the Individual type's own
// field configuration to capture an applicant (S-614 phase 2), but its
// checklist reads Individual's non_member_checklist_id (migration 0028) —
// deliberately not checklist_id, which is what a MEMBER of that type must
// provide and is not all asked of a non-member — unioned with whatever the
// selected account type asks for.
describe('S-614: the checklist for a customer_account application unions the non-member checklist with the account type’s', () => {
  it('lists the non-member checklist and what the selected account type requires, not the member’s own', async () => {
    const { capture, documents } = await load();

    const accountChecklist = await runAsConfigurator(
      appUrl,
      `insert into document_checklist (code, name, description)
       values ('s614_docs_account_test', 'S-614 docs account test', '')
       returning id`
    );
    const certRegistration = await run(
      appUrl,
      `select id from document_type where code = 'cert_registration'`
    );
    await runAsConfigurator(
      appUrl,
      `insert into document_checklist_item
         (checklist_id, document_type_id, subject, requirement, sort_order)
       values ('${accountChecklist.rows[0].id}',
               '${certRegistration.rows[0].id}', 'applicant', 'optional', 1)`
    );
    const accountType = await runAsConfigurator(
      appUrl,
      `insert into account_type
         (code, name, category, minimum_opening_amount, checklist_id,
          is_membership_default)
       values ('hsa_customer_docs_test', 'HSA (customer documents test)',
               'savings', 1000, '${accountChecklist.rows[0].id}', false)
       returning id`
    );

    const application = await capture.startCustomerAccountApplication(
      [accountType.rows[0].id],
      { userId: officer.userId, email: officer.email }
    );

    const entries = await documents.checklistFor({
      applicationId: application.id,
    });
    const codes = entries.map(e => e.documentCode);

    // Migration 0028's own seed for Individual's non-member checklist
    // (id_card, utility_bill, and — since migration 0030, S-614 phase 8 —
    // signed_form, once the flow gained a print step of its own) union
    // the selected account type's own (cert_registration).
    expect(codes).toEqual(
      expect.arrayContaining([
        'id_card',
        'utility_bill',
        'signed_form',
        'cert_registration',
      ])
    );
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

describe('S-603: all four signatures before the signed form can be Verified', () => {
  async function fileSignedForm() {
    const { documents } = await load();
    const typeId = (
      await run(
        appUrl,
        `select id from document_type where code = 'signed_form'`
      )
    ).rows[0].id;
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: typeId,
        subject: 'applicant',
        fileName: 'signed.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-signed', size: 2048 });
    await documents.commitUpload(begun.versionId, officer);
    return { documents, documentId: begun.documentId };
  }

  it('refuses to verify with none confirmed', async () => {
    const { documents, documentId } = await fileSignedForm();

    await expect(
      documents.reviewDocument(documentId, { outcome: 'verify' }, secretary)
    ).rejects.toThrowError(/All four signatures/);
  });

  it('names exactly which are still missing', async () => {
    const { documents, documentId } = await fileSignedForm();

    await expect(
      documents.reviewDocument(
        documentId,
        { outcome: 'verify', confirmedSignatures: ['Applicant', 'Nominee'] },
        secretary
      )
    ).rejects.toThrowError(/Witness 1, Witness 2/);
  });

  it('verifies once all four are confirmed', async () => {
    const { documents, documentId } = await fileSignedForm();

    const result = await documents.reviewDocument(
      documentId,
      { outcome: 'verify', confirmedSignatures: [...documents.SIGNATURES] },
      secretary
    );
    expect(result.state).toBe('verified');

    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.documentId === documentId
    )!;
    expect(entry.confirmedSignatures.sort()).toEqual(
      [...documents.SIGNATURES].sort()
    );
  });

  it('does not gate any other document type — only signed_form carries this rule', async () => {
    const { documents } = await load();
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: idCardTypeId,
        subject: 'nominee',
        fileName: 'nominee2.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        expiresAt: new Date('2030-01-01'),
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-nominee2', size: 100 });
    await documents.commitUpload(begun.versionId, officer);

    const result = await documents.reviewDocument(
      begun.documentId,
      { outcome: 'verify' },
      secretary
    );
    expect(result.state).toBe('verified');
  });

  it('lets a rejection keep whatever signatures were already confirmed', async () => {
    const { documents, documentId } = await fileSignedForm();

    await documents.reviewDocument(
      documentId,
      {
        outcome: 'reject',
        reason: 'Scan is too blurry to read the second witness.',
        confirmedSignatures: ['Applicant', 'Nominee', 'Witness 1'],
      },
      secretary
    );

    const entry = (await documents.checklistFor({ applicationId })).find(
      e => e.documentId === documentId
    )!;
    expect(entry.state).toBe('rejected');
    expect(entry.confirmedSignatures.sort()).toEqual(
      ['Applicant', 'Nominee', 'Witness 1'].sort()
    );
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
      { outcome: 'verify', confirmedSignatures: [...documents.SIGNATURES] },
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

// Uses the 'utility_bill' document type seeded in migration 0010 — configured
// for 'guardian' on Minor, not for anything on Individual — against a
// subject/type combination the Individual checklist does not configure.
// beginUpload does not check that: any active document type may be filed
// against any subject, and what is under test here is the view/remove
// behaviour, not the checklist configuration.
describe('S-403: viewing a filed document', () => {
  it('returns a URL good for opening the current version, and its file name', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );

    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: type.rows[0].id,
        subject: 'applicant',
        fileName: 'bill.pdf',
        contentType: 'application/pdf',
        sizeBytes: 200,
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-bill', size: 200 });
    await documents.commitUpload(begun.versionId, officer);

    const result = await documents.getDocumentViewUrl(begun.documentId);
    expect(result.fileName).toBe('bill.pdf');
    expect(result.url).toContain(encodeURIComponent(begun.ticket.itemPath));
  });

  it('refuses when nothing has been committed yet', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: type.rows[0].id,
        subject: 'nominee',
        fileName: 'unfinished.pdf',
        contentType: 'application/pdf',
        sizeBytes: 200,
      },
      officer
    );
    // Never committed — no live version exists to view.
    await expect(
      documents.getDocumentViewUrl(begun.documentId)
    ).rejects.toThrowError(/no filed version/);
  });
});

describe('undoing a mistaken upload, so it can be filed again', () => {
  // Built inside each test, not here: describe bodies run at collection
  // time, before beforeAll has populated `officer` — spreading it here would
  // silently carry no userId or email at all.
  const asUploader = () => ({
    ...officer,
    permissions: new Set(['document.upload']),
  });
  const asViewerOnly = () => ({
    ...officer,
    permissions: new Set(['document.view']),
  });

  it('supersedes the live version, without touching the file in SharePoint', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: type.rows[0].id,
        subject: 'guardian',
        fileName: 'bill2.pdf',
        contentType: 'application/pdf',
        sizeBytes: 300,
      },
      officer
    );
    drive.files.set(begun.ticket.itemPath, { id: 'graph-bill2', size: 300 });
    await documents.commitUpload(begun.versionId, officer);

    const before = await documents.versionsOf(begun.documentId);
    expect(before.filter(v => v.supersededAt === null)).toHaveLength(1);

    const result = await documents.removeFiledDocument(
      begun.documentId,
      asUploader()
    );
    expect(result.state).toBe('missing');

    const after = await documents.versionsOf(begun.documentId);
    // Nothing live — but the version itself is kept, exactly as a replacement
    // keeps what it supersedes (S-409): the same guarantee, reached from a
    // different direction.
    expect(after.filter(v => v.supersededAt === null)).toHaveLength(0);
    expect(after).toHaveLength(before.length);
    expect(drive.files.has(begun.ticket.itemPath)).toBe(true);

    const audited = await run(
      appUrl,
      `select previous_value->>'state' as was, new_value->>'state' as now
         from audit_event
        where action = 'document.removed' and entity_id = $1`,
      [begun.documentId]
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].now).toBe('missing');
  });

  it('can be filed again afterwards, as a new version', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );
    const documentId = (
      await run(
        appUrl,
        `select id from document
          where application_id = $1 and subject = 'guardian'
            and document_type_id = $2`,
        [applicationId, type.rows[0].id]
      )
    ).rows[0].id;

    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: type.rows[0].id,
        subject: 'guardian',
        fileName: 'bill3.pdf',
        contentType: 'application/pdf',
        sizeBytes: 150,
      },
      officer
    );
    expect(begun.documentId).toBe(documentId);
    drive.files.set(begun.ticket.itemPath, { id: 'graph-bill3', size: 150 });
    await documents.commitUpload(begun.versionId, officer);

    const versions = await documents.versionsOf(documentId);
    const live = versions.find(v => v.supersededAt === null)!;
    expect(versions.filter(v => v.supersededAt === null)).toHaveLength(1);
    // Carries a version prefix once it is not the first — the removed
    // version still counts (S-409), so this is version 3, not 2.
    expect(live.fileName).toContain('bill3.pdf');
  });

  it('refuses when there is nothing filed to remove', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: type.rows[0].id,
        subject: 'beneficiary',
        fileName: 'still-pending.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      },
      officer
    );
    // Never committed — nothing live to remove.
    await expect(
      documents.removeFiledDocument(begun.documentId, asUploader())
    ).rejects.toThrowError(/no filed version/);
  });

  it('refuses someone without document.upload', async () => {
    const { documents } = await load();
    const type = await run(
      appUrl,
      `select id from document_type where code = 'utility_bill'`
    );
    const documentId = (
      await run(
        appUrl,
        `select id from document
          where application_id = $1 and subject = 'guardian'
            and document_type_id = $2`,
        [applicationId, type.rows[0].id]
      )
    ).rows[0].id;

    await expect(
      documents.removeFiledDocument(documentId, asViewerOnly())
    ).rejects.toThrowError(/permission/);
  });
});
