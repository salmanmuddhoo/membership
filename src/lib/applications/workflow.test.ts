// The approval chain, and what it creates (M3 Features 3.2 and 3.3).
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
import type { Principal } from '../access/principal';
import type { PartyValues } from './capture';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `workflow_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

/**
 * Change a configuration table directly.
 *
 * Migration 0010 puts a trigger on those tables that refuses a write it cannot
 * attribute — including one from a test — so this declares an actor, exactly
 * as docs/database.md says to do by hand. Needing this helper is the control
 * working, not an obstacle to route around.
 */
async function runAsActor(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: appUrl, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', $1, true)`,
      ['workflow.test.ts']
    );
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
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

// A stand-in drive, exactly as documents.test.ts uses one — submitApplication
// now refuses unless the required documents are actually filed (S-304), so
// getting an application to a submittable state here means going through the
// same begin/commit steps a real upload would, against a fake Graph rather
// than a real tenant.
interface FakeDrive {
  files: Map<string, { id: string; size: number }>;
}
let drive: FakeDrive = { files: new Map() };

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');

  vi.doMock('../documents/graph', async () => {
    const actual =
      await vi.importActual<typeof import('../documents/graph')>(
        '../documents/graph'
      );
    return {
      ...actual,
      ensureFolder: async () => {},
      getItemByPath: async (itemPath: string) => {
        const file = drive.files.get(itemPath);
        return file ? { ...file, name: itemPath, webUrl: 'https://x' } : null;
      },
    };
  });

  // upload.ts's createUploadTicket calls getGraphConfig() itself to build the
  // ticket, which the mock above does not reach — GRAPH_* is not set here any
  // more than it is in documents.test.ts, which mocks this same function for
  // the same reason.
  vi.doMock('../documents/upload', async () => {
    const actual = await vi.importActual<typeof import('../documents/upload')>(
      '../documents/upload'
    );
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
    capture: await import('./capture'),
    workflow: await import('./workflow'),
    members: await import('../members/create'),
    config: await import('../config/reference'),
    documents: await import('../documents/documents'),
    payments: await import('../payments/payments'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.doUnmock('../documents/graph');
  vi.doUnmock('../documents/upload');
});

function principalFor(
  userId: string,
  email: string,
  permissions: string[],
  roles: string[]
): Principal {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles,
    roleNames: [],
    permissions: new Set(permissions),
  };
}

let officer: Principal;
let regionalManager: Principal;
let secretary: Principal;
let president: Principal;

const COMPLETE_INDIVIDUAL: Array<{
  subject: 'applicant' | 'nominee' | 'guardian' | 'beneficiary';
  ordinal: number;
  values: Record<string, string>;
}> = [
  {
    subject: 'applicant',
    ordinal: 1,
    values: {
      surname: 'Beebeejaun',
      name: 'Aisha',
      nic: 'B1234567890123',
      gender: 'Female',
      address: '12 Royal Road, Curepipe',
      mobile: '5789 1234',
    },
  },
  {
    subject: 'nominee',
    ordinal: 1,
    values: {
      surname: 'Beebeejaun',
      name: 'Yusuf',
      nic: 'B9876543210987',
      address: '12 Royal Road, Curepipe',
    },
  },
];

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer'),
            ('regional.manager@albarakah.mu', 'Regional Manager'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email::text as email`
  );
  const id = (email: string) =>
    users.rows.find(r => r.email === email).id as string;

  officer = principalFor(
    id('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['application.view', 'application.capture', 'application.submit'],
    ['regional_officer']
  );
  regionalManager = principalFor(
    id('regional.manager@albarakah.mu'),
    'regional.manager@albarakah.mu',
    ['application.view', 'application.review'],
    ['regional_manager']
  );
  secretary = principalFor(
    id('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['application.view', 'application.review'],
    ['secretary']
  );
  president = principalFor(
    id('president@albarakah.mu'),
    'president@albarakah.mu',
    ['application.view', 'application.approve'],
    ['president']
  );
}, 60_000);

afterAll(async () => {
  // Before the drop, so the last pool's connections are handed back rather
  // than terminated out from under it.
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// Files every REQUIRED item the type's checklist asks for — whatever they
// are; nothing here needs to know the catalogue, only that submission needs
// it complete (S-304).
async function fileRequiredDocuments(
  documents: Awaited<ReturnType<typeof load>>['documents'],
  applicationId: string
) {
  const actor = { userId: officer.userId, email: officer.email };
  const checklist = await documents.checklistFor({ applicationId });

  for (const entry of checklist.filter(e => e.requirement === 'required')) {
    const begun = await documents.beginUpload(
      {
        applicationId,
        documentTypeId: entry.documentTypeId,
        subject: entry.subject,
        fileName: `${entry.documentCode}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 100,
        ...(entry.tracksExpiry ? { expiresAt: new Date('2030-01-01') } : {}),
      },
      actor
    );
    drive.files.set(begun.ticket.itemPath, {
      id: `${entry.documentCode}-${entry.subject}`,
      size: 100,
    });
    await documents.commitUpload(begun.versionId, actor);
  }
}

// Verifies every required document a fixture has already filed (S-608: the
// Board readiness gate needs Verified, not merely filed). The Secretary
// verifies in the real chain, and never the person who filed it — officer
// files, secretary verifies, so there is no segregation conflict here.
async function verifyRequiredDocuments(
  documents: Awaited<ReturnType<typeof load>>['documents'],
  applicationId: string
) {
  const verifier = {
    ...secretary,
    permissions: new Set([...secretary.permissions, 'document.verify']),
  };
  const checklist = await documents.checklistFor({ applicationId });

  for (const entry of checklist.filter(e => e.requirement === 'required')) {
    await documents.reviewDocument(
      entry.documentId!,
      {
        outcome: 'verify',
        // S-603: the signed form alone needs all four signatures confirmed
        // before it can be Verified — every other document type ignores this.
        ...(entry.documentCode === 'signed_form'
          ? { confirmedSignatures: [...documents.SIGNATURES] }
          : {}),
      },
      verifier
    );
  }
}

// The full schedule, in cash, exactly as it stands — no variance to explain.
async function recordFullPayment(
  payments: Awaited<ReturnType<typeof load>>['payments'],
  applicationId: string
) {
  const due = await payments.amountDueForApplication(applicationId);
  const amounts: Record<string, string> = {};
  for (const component of due.components)
    amounts[component.code] = component.amount;

  await payments.recordPayment(
    { applicationId, method: 'cash', amounts },
    // A throwaway grant rather than adding payment.record to the shared
    // `officer` — several tests below assert on officer's own permission
    // set, and this helper's only job is to make the application payable,
    // not to change who officer is everywhere else in this file.
    {
      ...officer,
      permissions: new Set([...officer.permissions, 'payment.record']),
    }
  );
}

async function captureComplete() {
  // Plain dynamic imports, not another load(): every caller has already
  // called load() once for its own {capture, workflow, ...}, and load()
  // closes the file's last-tracked pool on entry. A second call here would
  // close the caller's pool out from under the `workflow`/`capture` handles
  // it is about to keep using — not a leak so much as its opposite, an extra
  // pool the caller's variables silently fall back to opening on their next
  // query, which is what pushed the suite over CI's connection ceiling.
  // Vitest only changes the module registry on vi.resetModules(), which
  // load() already ran once for this test; importing again here resolves
  // from that same cache — no new modules, no new pool.
  const capture = await import('./capture');
  const documents = await import('../documents/documents');
  const payments = await import('../payments/payments');
  const actor = { userId: officer.userId, email: officer.email };
  const { id } = await capture.startApplication('individual', actor);
  await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
  await fileRequiredDocuments(documents, id);
  await verifyRequiredDocuments(documents, id);
  await recordFullPayment(payments, id);
  return id;
}

// FRD 5.2: no NIC, no gender — a registered entity's own particulars plus a
// contact person, and a nominee exactly as an Individual's.
const COMPLETE_CORPORATE: Array<{
  subject: 'applicant' | 'nominee' | 'guardian' | 'beneficiary';
  ordinal: number;
  values: Record<string, string>;
}> = [
  {
    subject: 'applicant',
    ordinal: 1,
    values: {
      name: 'Curepipe Trading Co Ltd',
      registration_no: 'C12345678',
      address: '10 St Georges Street, Port Louis',
      mobile: '5789 1234',
      contact_person: 'Aisha Beebeejaun',
      contact_telephone: '5789 5678',
    },
  },
  {
    subject: 'nominee',
    ordinal: 1,
    values: {
      surname: 'Beebeejaun',
      name: 'Yusuf',
      nic: 'B9876543210987',
      address: '12 Royal Road, Curepipe',
    },
  },
];

async function captureCompleteCorporate() {
  const capture = await import('./capture');
  const documents = await import('../documents/documents');
  const payments = await import('../payments/payments');
  const actor = { userId: officer.userId, email: officer.email };
  const { id } = await capture.startApplication('corporate', actor);
  await capture.saveDraft(id, COMPLETE_CORPORATE, actor);
  await fileRequiredDocuments(documents, id);
  await verifyRequiredDocuments(documents, id);
  await recordFullPayment(payments, id);
  return id;
}

// A member row for a minor's application to point its guardian at, with a
// real applicant NIC behind it — capture.ts's guardian lookup joins back to
// that party, since NIC is not a column on `member` itself.
async function seedGuardianMember(nic: string): Promise<{ memberNo: string }> {
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
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [application.rows[0].id, JSON.stringify({ nic })]
  );
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning member_no`,
    [application.rows[0].id, type.rows[0].id]
  );
  return { memberNo: member.rows[0].member_no };
}

describe('S-604/S-605: a Minor application with a valid guardian, end to end', () => {
  it('is blocked while the guardian cannot be found, then goes through once they can', async () => {
    const { capture, workflow, members } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('minor', actor);

    const parties = (guardianMemberNo: string): PartyValues[] => [
      {
        subject: 'applicant',
        ordinal: 1,
        values: {
          surname: 'Ramdin',
          name: 'Zaid',
          date_of_birth: '2015-01-01',
          gender: 'Male',
          address: '4 Pope Hennessy Street, Port Louis',
        },
      },
      {
        subject: 'guardian' as const,
        ordinal: 1,
        values: {
          surname: 'Ramdin',
          name: 'Farah',
          nic: 'G0000000000000',
          member_id: guardianMemberNo,
          relationship: 'Mother',
          mobile: '5789 1234',
        },
      },
      {
        subject: 'nominee' as const,
        ordinal: 1,
        values: {
          surname: 'Peerthum',
          name: 'Ismail',
          nic: 'H1111111111111',
        },
      },
      {
        subject: 'beneficiary' as const,
        ordinal: 1,
        values: { surname: 'Ramdin', name: 'Zaid', nic: 'H2222222222222' },
      },
    ];

    await capture.saveDraft(id, parties('AB9999'), actor);
    const documents = await import('../documents/documents');
    const payments = await import('../payments/payments');
    await fileRequiredDocuments(documents, id);
    await verifyRequiredDocuments(documents, id);
    await recordFullPayment(payments, id);

    // Not a member yet — submission refuses, and says the guardian is why.
    const refused = await workflow.submitApplication(id, officer);
    expect('problems' in refused).toBe(true);
    if ('problems' in refused) {
      expect(
        refused.problems.some(p => /must join as a member first/.test(p.label))
      ).toBe(true);
    }

    // Now the guardian actually is one — the same application goes through.
    const { memberNo } = await seedGuardianMember('S5555555555555');
    await capture.saveDraft(id, parties(memberNo), actor);

    const submitted = await workflow.submitApplication(id, officer);
    expect(submitted).toEqual({ status: 'new' });

    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Guardian verified.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    expect(decided.status).toBe('approved');
  });
});

describe('S-601: a Corporate application, end to end', () => {
  // The acceptance criterion in the backlog, checked directly: the corporate
  // checklist asks for the entity's own documents, not an ID card, which is
  // an Individual's proof of identity and not a registered entity's.
  it('asks for corporate documents, not an ID card, for the applicant', async () => {
    const { documents } = await load();
    const id = await captureCompleteCorporate();
    const checklist = await documents.checklistFor({ applicationId: id });

    const applicantDocs = checklist
      .filter(e => e.subject === 'applicant')
      .map(e => e.documentCode);
    expect(applicantDocs).toEqual(
      expect.arrayContaining([
        'cert_registration',
        'memorandum',
        'written_resolution',
      ])
    );
    expect(applicantDocs).not.toContain('id_card');

    // The nominee is still proven by ID card, exactly as an Individual's is.
    expect(checklist.find(e => e.subject === 'nominee')?.documentCode).toBe(
      'id_card'
    );
  });

  it('takes a Corporate application all the way to an approved member', async () => {
    const { workflow, members } = await load();
    const id = await captureCompleteCorporate();

    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    expect(decided.status).toBe('approved');
    expect(decided.member?.memberNo).toMatch(/^AB\d{4,}$/);

    const member = await members.loadMember(decided.member!.id);
    expect(member!.accounts.map(a => a.accountTypeName)).toEqual([
      'Shares',
      'Multiplier Savings Account',
    ]);
  });
});

describe('M3: the walking skeleton, end to end', () => {
  it('takes an application from capture to a member with an MSA', async () => {
    const { capture, workflow, members } = await load();
    const id = await captureComplete();
    const capturedReference = (await capture.loadApplication(id))!.reference;

    const submitted = await workflow.submitApplication(id, officer);
    expect(submitted).toEqual({ status: 'new' });

    const reviewed = await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Documents complete.' },
      secretary
    );
    expect(reviewed.status).toBe('submitted_for_approval');

    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    expect(decided.status).toBe('approved');
    // The Society's own format: AB0001 is the member.
    expect(decided.member?.memberNo).toMatch(/^AB\d{4,}$/);

    // A membership opens Shares and an MSA together — every type configured to
    // open on approval, not one (S-206, S-309).
    const member = await members.loadMember(decided.member!.id);
    expect(member!.accounts.map(a => a.accountTypeName)).toEqual([
      'Shares',
      'Multiplier Savings Account',
    ]);
    expect(member!.accounts.every(a => a.isMembershipDefault)).toBe(true);

    // And both carry the member's number. That is the whole point of it: the
    // member, their Shares account and their MSA are one AB number.
    expect(member!.accounts.map(a => a.accountNo)).toEqual([
      member!.memberNo,
      member!.memberNo,
    ]);

    expect(member!.applicationReference).toBe(
      (await capture.loadApplication(id))!.reference
    );

    // Officer feedback: the member page names who captured the founding
    // application — the Regional Officer, per the FRD's capture step.
    expect(member!.capturedByName).toBe('Officer');

    // From approval on there is one identifier, not two: the application
    // takes the member's own number rather than keeping the APP- reference
    // it was captured under.
    const application = await capture.loadApplication(id);
    expect(application!.reference).toBe(decided.member!.memberNo);
    expect(application!.reference).not.toBe(capturedReference);
    expect(capturedReference).toMatch(/^APP-\d{4}-\d{6}$/);
  });

  it('records every transition with actor, timestamp and comment (S-307)', async () => {
    const { workflow, members } = await load();
    const id = await captureComplete();

    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Checked against FRD 8.4.1.' },
      secretary
    );
    await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: 'Approved at the March board.' },
      president,
      members.createMemberFromApplication
    );

    const chain = await workflow.transitionsFor(id);
    expect(chain.map(t => [t.fromStatus, t.toStatus])).toEqual([
      ['draft', 'new'],
      ['new', 'submitted_for_approval'],
      ['submitted_for_approval', 'approved'],
    ]);
    expect(chain.map(t => t.actorEmail)).toEqual([
      'officer@albarakah.mu',
      'secretary@albarakah.mu',
      'president@albarakah.mu',
    ]);
    expect(chain[1].comment).toBe('Checked against FRD 8.4.1.');
    expect(chain[2].comment).toBe('Approved at the March board.');
    expect(chain.every(t => t.occurredAt instanceof Date)).toBe(true);
    // The step each transition came from, so it traces back to the configured
    // chain that authorised it.
    expect(chain.map(t => t.stepCode)).toEqual([
      'capture',
      'secretary_review',
      'president_decision',
    ]);
  });

  it('cannot have its history rewritten', async () => {
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await expect(
      run(appUrl, `update application_transition set comment = 'edited'`)
    ).rejects.toThrowError(/append-only/);
    await expect(
      run(appUrl, `delete from application_transition`)
    ).rejects.toThrowError(/append-only/);
  });
});

describe('S-304: submission', () => {
  it('refuses while a mandatory field is empty, and names them all', async () => {
    const { capture, workflow } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('individual', actor);

    const result = await workflow.submitApplication(id, officer);
    expect('problems' in result).toBe(true);
    if (!('problems' in result)) return;
    expect(result.problems.length).toBeGreaterThan(5);

    // And nothing was submitted.
    expect((await capture.loadApplication(id))!.status).toBe('draft');
    expect(await workflow.transitionsFor(id)).toEqual([]);
  });

  it('locks the application from regional edits once submitted', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await expect(
      capture.saveDraft(
        id,
        [{ subject: 'applicant', ordinal: 1, values: { name: 'Changed' } }],
        { userId: officer.userId, email: officer.email }
      )
    ).rejects.toThrowError(/no longer be edited/);
  });

  it('refuses someone without the submit permission', async () => {
    const { workflow } = await load();
    const id = await captureComplete();

    await expect(
      workflow.submitApplication(id, secretary)
    ).rejects.toThrowError(/permission/);
  });

  it('refuses while a required document has not been filed', async () => {
    const { capture, workflow, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('individual', actor);
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
    // Fields are complete, money is taken — only the KYC pack is missing.
    await recordFullPayment(payments, id);

    await expect(workflow.submitApplication(id, officer)).rejects.toThrowError(
      /required document.*still need to be filed/
    );
    expect((await capture.loadApplication(id))!.status).toBe('draft');
  });

  it('refuses while payment has not been recorded', async () => {
    const { capture, workflow, documents } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('individual', actor);
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
    // Fields and the KYC pack are complete — only the money is missing.
    await fileRequiredDocuments(documents, id);

    await expect(workflow.submitApplication(id, officer)).rejects.toThrowError(
      /Payment must be recorded/
    );
    expect((await capture.loadApplication(id))!.status).toBe('draft');
  });

  it('reports document and payment readiness the same way submitApplication checks it', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    const application = (await capture.loadApplication(id))!;

    const readiness = await workflow.submissionReadiness(application);
    expect(readiness).toEqual({
      fieldProblems: [],
      documentsOutstanding: 0,
      paymentRecorded: true,
    });
  });
});

describe('S-203: segregation of duties, on this record', () => {
  it('refuses the officer who captured it the review, even with the permission', async () => {
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    // Someone who is entitled to review applications in general, but who
    // captured THIS one. Permission is not the question.
    const officerWhoCanAlsoReview = principalFor(
      officer.userId,
      officer.email,
      ['application.view', 'application.review'],
      ['secretary']
    );

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Looks fine to me.' },
        officerWhoCanAlsoReview
      )
    ).rejects.toThrowError(/may not review it/);
  });

  it('refuses the reviewer the approval', async () => {
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    const secretaryWhoCanAlsoApprove = principalFor(
      secretary.userId,
      secretary.email,
      ['application.view', 'application.approve'],
      ['president']
    );

    await expect(
      workflow.decideApplication(
        id,
        { outcome: 'approve', comment: '' },
        secretaryWhoCanAlsoApprove,
        (await load()).members.createMemberFromApplication
      )
    ).rejects.toThrowError(/may not also approve it/);
  });

  it('does not refuse a different application by the same people', async () => {
    // The rule is per record. Blocking a Secretary from reviewing anything an
    // officer captured would stop the Society working.
    const { workflow } = await load();
    const first = await captureComplete();
    const second = await captureComplete();

    await workflow.submitApplication(first, officer);
    await workflow.submitApplication(second, officer);

    await expect(
      workflow.reviewApplication(
        first,
        { outcome: 'forward', comment: 'One.' },
        secretary
      )
    ).resolves.toBeDefined();
    await expect(
      workflow.reviewApplication(
        second,
        { outcome: 'forward', comment: 'Two.' },
        secretary
      )
    ).resolves.toBeDefined();
  });

  it('bars a clerk who submitted work someone else captured', async () => {
    // FRD 7.4.2 lets a Clerk assist with capture. Both people had a hand in
    // it, so both are barred from reviewing — the conservative reading.
    const { capture, workflow, documents, payments } = await load();
    const { id } = await capture.startApplication('individual', {
      userId: officer.userId,
      email: officer.email,
    });
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, {
      userId: officer.userId,
      email: officer.email,
    });
    await fileRequiredDocuments(documents, id);
    await recordFullPayment(payments, id);

    const clerk = principalFor(
      secretary.userId,
      secretary.email,
      ['application.view', 'application.submit', 'application.review'],
      ['regional_officer', 'secretary']
    );
    await workflow.submitApplication(id, clerk);

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Mine to review?' },
        clerk
      )
    ).rejects.toThrowError(/may not review it/);
  });
});

describe('S-305 and S-306: a return or a rejection must say why', () => {
  it('refuses a return with no comment', async () => {
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'return', comment: '   ' },
        secretary
      )
    ).rejects.toThrowError(/requires a comment/);
  });

  it('sends a returned application back to staff, editable again', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    const returned = await workflow.reviewApplication(
      id,
      {
        outcome: 'return',
        comment: 'The NIC does not match the birth certificate.',
      },
      secretary
    );
    expect(returned.status).toBe('returned');

    // The officer can now correct it — the point of returning it.
    await expect(
      capture.saveDraft(
        id,
        [
          {
            subject: 'applicant',
            ordinal: 1,
            values: { ...COMPLETE_INDIVIDUAL[0].values, nic: 'B1111111111111' },
          },
        ],
        { userId: officer.userId, email: officer.email }
      )
    ).resolves.toBeDefined();

    const chain = await workflow.transitionsFor(id);
    expect(chain[chain.length - 1].comment).toBe(
      'The NIC does not match the birth certificate.'
    );
  });

  it('refuses a rejection with no comment', async () => {
    const { workflow, members } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    await expect(
      workflow.decideApplication(
        id,
        { outcome: 'reject', comment: '' },
        president,
        members.createMemberFromApplication
      )
    ).rejects.toThrowError(/requires a comment/);
  });

  it('creates no member when the decision is a rejection', async () => {
    const { capture, workflow, members } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const capturedReference = (await capture.loadApplication(id))!.reference;

    const before = await run(appUrl, 'select count(*) as n from member');
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'reject', comment: 'Shares not paid.' },
      president,
      members.createMemberFromApplication
    );

    expect(decided.status).toBe('rejected');
    expect(decided.member).toBeUndefined();
    const after = await run(appUrl, 'select count(*) as n from member');
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // No member means no number to take: a rejected application keeps the
    // reference it was captured under, for good.
    expect((await capture.loadApplication(id))!.reference).toBe(
      capturedReference
    );
  });
});

describe('S-608: nothing incomplete reaches the Board', () => {
  it('refuses to forward while a required document is filed but not Verified', async () => {
    const { capture, workflow, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('individual', actor);
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, id);
    await recordFullPayment(payments, id);
    await workflow.submitApplication(id, officer);

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Looks fine.' },
        secretary
      )
    ).rejects.toThrowError(/not ready for the Board.*Verified/);
  });

  it('re-checks payment at review time, not just at submission', async () => {
    const { workflow, payments } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    // Not officer: officer recorded it, and segregation refuses the same
    // person both recording and voiding a payment.
    const [payment] = await payments.paymentsForApplication(id);
    await payments.voidPayment(
      payment.id,
      'Recorded against the wrong application.',
      {
        ...secretary,
        permissions: new Set([...secretary.permissions, 'payment.void']),
      }
    );

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Ready.' },
        secretary
      )
    ).rejects.toThrowError(/not ready for the Board.*payment/);
  });

  it('re-checks the guardian at review time, and names every outstanding item together', async () => {
    const { capture, workflow, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { memberNo } = await seedGuardianMember('S1231231231230');
    const { id } = await capture.startApplication('minor', actor);

    const parties: PartyValues[] = [
      {
        subject: 'applicant',
        ordinal: 1,
        values: {
          surname: 'Ramdin',
          name: 'Zaid',
          date_of_birth: '2015-01-01',
          gender: 'Male',
          address: '4 Pope Hennessy Street, Port Louis',
        },
      },
      {
        subject: 'guardian',
        ordinal: 1,
        values: {
          surname: 'Ramdin',
          name: 'Farah',
          nic: 'G0000000000001',
          member_id: memberNo,
          relationship: 'Mother',
          mobile: '5789 1234',
        },
      },
      {
        subject: 'nominee',
        ordinal: 1,
        values: { surname: 'Peerthum', name: 'Ismail', nic: 'H1111111111112' },
      },
      {
        subject: 'beneficiary',
        ordinal: 1,
        values: { surname: 'Ramdin', name: 'Zaid', nic: 'H2222222222223' },
      },
    ];
    await capture.saveDraft(id, parties, actor);
    await fileRequiredDocuments(documents, id);
    // Deliberately left unverified, alongside the guardian problem below —
    // this is also the test that both are named together, not just one.
    await recordFullPayment(payments, id);
    await workflow.submitApplication(id, officer);

    // The guardian was an active member at submission. Not any more.
    await run(
      appUrl,
      `update member set status = 'inactive' where member_no = $1`,
      [memberNo]
    );

    const attempt = workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Ready.' },
      secretary
    );
    await expect(attempt).rejects.toThrowError(/Verified/);
    await expect(attempt).rejects.toThrowError(/not an active member/);
  });

  it('does not block Return for correction on the same incompleteness', async () => {
    const { capture, workflow, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const { id } = await capture.startApplication('individual', actor);
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, id);
    await recordFullPayment(payments, id);
    await workflow.submitApplication(id, officer);

    const returned = await workflow.reviewApplication(
      id,
      { outcome: 'return', comment: 'Please refile a clearer scan.' },
      secretary
    );
    expect(returned.status).toBe('returned');
  });

  it('goes through once every document is Verified, payment stands and the guardian is valid', async () => {
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    const forwarded = await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    expect(forwarded.status).toBe('submitted_for_approval');
  });
});

describe('S-609: a quorum above one needs that many distinct sign-offs', () => {
  async function setQuorum(count: number) {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    const step = definition.steps.find(s => s.code === 'president_decision')!;
    await config.setStepQuorum(step.id, count, {
      userId: officer.userId,
      email: officer.email,
    });
  }

  afterEach(async () => {
    // Every other describe block in this file assumes the shipped default
    // (quorum 1) — restore it so a test order change elsewhere never
    // inherits a quorum this block turned on.
    await setQuorum(1);
  });

  // A second board member, entitled to decide exactly as president is.
  let boardMember2: Principal;
  beforeAll(async () => {
    const user = await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('board2@albarakah.mu', 'Board Member 2') returning id`
    );
    boardMember2 = principalFor(
      user.rows[0].id,
      'board2@albarakah.mu',
      ['application.view', 'application.approve'],
      ['president']
    );
  });

  it('does not transition until enough distinct approvals are in', async () => {
    const { workflow, members } = await load();
    await setQuorum(2);
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    const first = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    expect(first.signoff).toEqual({ recorded: 1, required: 2 });
    expect(first.member).toBeUndefined();

    const { capture } = await load();
    expect((await capture.loadApplication(id))!.status).toBe(
      'submitted_for_approval'
    );

    const second = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      boardMember2,
      members.createMemberFromApplication
    );
    expect(second.signoff).toBeUndefined();
    expect(second.status).toBe('approved');
    expect(second.member).toBeDefined();
  });

  it('lets one reject veto immediately, even with an approval already recorded', async () => {
    const { workflow, members, capture } = await load();
    await setQuorum(3);
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    const partial = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    expect(partial.signoff).toEqual({ recorded: 1, required: 3 });

    const rejected = await workflow.decideApplication(
      id,
      { outcome: 'reject', comment: 'Documents do not match.' },
      boardMember2,
      members.createMemberFromApplication
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.signoff).toBeUndefined();

    // Vetoed, whatever quorum still has not been reached — a third board
    // member showing up to approve finds nothing left to act on.
    expect((await capture.loadApplication(id))!.status).toBe('rejected');
  });

  it('refuses the same person a second sign-off on the same step', async () => {
    const { workflow, members } = await load();
    await setQuorum(2);
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    await expect(
      workflow.decideApplication(
        id,
        { outcome: 'approve', comment: '' },
        president,
        members.createMemberFromApplication
      )
    ).rejects.toThrowError(/already recorded a decision/);
  });

  it('records who signed off, readable back in order', async () => {
    const { workflow, members } = await load();
    await setQuorum(2);
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      boardMember2,
      members.createMemberFromApplication
    );

    const signoffs = await workflow.signoffsFor(id, 'president_decision');
    expect(signoffs.map(s => [s.actorEmail, s.outcome])).toEqual([
      [president.email, 'approve'],
      [boardMember2.email, 'approve'],
    ]);
  });

  it('audits every sign-off, not just the one that completes the step', async () => {
    const { workflow, members } = await load();
    await setQuorum(2);
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    const audited = await run(
      appUrl,
      `select actor_description from audit_event
        where action = 'membership.application.approved' and entity_id = $1
        order by occurred_at`,
      [id]
    );
    expect(audited.rows.map(r => r.actor_description)).toEqual([
      president.email,
    ]);
  });

  it('at the default quorum of one, still transitions on a single decision', async () => {
    const { workflow, members } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    expect(decided.signoff).toBeUndefined();
    expect(decided.status).toBe('approved');
    expect(decided.member).toBeDefined();
  });
});

describe('S-308 and S-309: what approval creates', () => {
  it('half-creates nothing when account opening fails', async () => {
    const { capture, workflow, members, config } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );

    // Take away the default product. The member insert has already succeeded
    // by the time this is discovered, so if the two were not in one
    // transaction there would now be a member with no account and an approved
    // application to match.
    // Every type, not just the MSA: a membership now opens more than one, so
    // clearing a single flag would leave the Shares account still openable and
    // the approval would succeed.
    await runAsActor(
      `update account_type set is_membership_default = false
        where is_membership_default`
    );

    const membersBefore = await run(appUrl, 'select count(*) as n from member');

    try {
      await expect(
        workflow.decideApplication(
          id,
          { outcome: 'approve', comment: '' },
          president,
          members.createMemberFromApplication
        )
      ).rejects.toThrowError(/no account to open/);

      // Nothing was created...
      const membersAfter = await run(
        appUrl,
        'select count(*) as n from member'
      );
      expect(membersAfter.rows[0].n).toBe(membersBefore.rows[0].n);

      // ...and the application was not approved either. An approved
      // application with no member is the state S-308 exists to prevent.
      expect((await capture.loadApplication(id))!.status).toBe(
        'submitted_for_approval'
      );
      expect(
        (await workflow.transitionsFor(id)).some(t => t.toStatus === 'approved')
      ).toBe(false);
    } finally {
      // Put back exactly what was cleared: the two types a membership opens.
      await runAsActor(
        `update account_type set is_membership_default = true
          where code in ('shares', 'msa')`
      );
    }

    // And it can be approved once the configuration is put back.
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );
    expect(decided.member?.memberNo).toBeDefined();
  });

  it('opens whichever product is configured as the default (S-206)', async () => {
    const { workflow, members, config } = await load();
    const admin = { userId: officer.userId, email: officer.email };

    const premiumId = await config.createAccountType(
      {
        code: 'premium_msa',
        name: 'Premium Multiplier Savings',
        category: 'savings',
        minimumOpeningAmount: '10000.00',
        checklistId: null,
        requiresApproval: false,
        defaultStatus: 'active',
      },
      admin
    );
    // Added alongside Shares and the MSA, so an approval now opens three.
    await config.setOpensOnApproval(premiumId, true, admin);

    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    const member = await members.loadMember(decided.member!.id);
    expect(member!.accounts.map(a => a.accountTypeName)).toContain(
      'Premium Multiplier Savings'
    );

    await config.setOpensOnApproval(premiumId, false, admin);
  });

  // Officer feedback: the Members page's own "Total funds" column sums
  // Shares and the MSA deposit, and nothing else — Entrance and Takaful are
  // the Society's own charge, not the member's money, so recordFullPayment
  // paying every fee component must not inflate the total by them.
  it('sums Shares and the MSA deposit into the Members page total, not Entrance or Takaful', async () => {
    const { workflow, members, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };
    const capture = await import('./capture');
    const documents = await import('../documents/documents');

    const { id } = await capture.startApplication('individual', actor);
    await capture.saveDraft(id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, id);
    await verifyRequiredDocuments(documents, id);

    const due = await payments.amountDueForApplication(id);
    const expected = due.components
      .filter(c => c.code === 'shares' || c.code === 'msa_deposit')
      .reduce((sum, c) => sum + Number(c.amount), 0)
      .toFixed(2);

    await recordFullPayment(payments, id);
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    const listed = (
      await members.listMembers({ search: decided.member!.memberNo })
    ).members[0];
    expect(listed.totalFunds).toBe(expected);
  });

  it('gives every member a distinct number in the documented format', async () => {
    const { members } = await load();
    // listMembers also lists customers (S-614) — filtered here, since their
    // own numbering (HSA0001-style, per selected account type) is not
    // this test's concern.
    const all = (await members.listMembers({ limit: 100 })).members.filter(
      m => m.kind === 'member'
    );

    expect(all.length).toBeGreaterThan(1);
    expect(all.every(m => /^AB\d{4,}$/.test(m.memberNo))).toBe(true);
    expect(new Set(all.map(m => m.memberNo)).size).toBe(all.length);
  });

  it('cannot open a second account of the same type for one member', async () => {
    const { workflow, members, config } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    const shares = (await config.listAccountTypes()).find(
      a => a.code === 'shares'
    )!;
    // A retry that somehow ran twice. The database refuses, so "exactly one of
    // each" does not depend on the service getting it right.
    await expect(
      run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default)
         values ($1, $2, true)`,
        [decided.member!.id, shares.id]
      )
    ).rejects.toThrowError(/account_one_per_type_per_member_idx/);
  });

  it('audits the member and the account against the deciding officer', async () => {
    const { workflow, members } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    const audited = await run(
      appUrl,
      `select action, actor_description, new_value->>'memberNo' as member_no
         from audit_event
        where action in ('member.created', 'account.opened')
          and (entity_id = $1 or new_value->>'memberNo' = $2)
        order by action`,
      [decided.member!.id, decided.member!.memberNo]
    );

    // One entry per account, plus the member. They opened together, but each
    // account's opening is its own thing to answer for.
    expect(audited.rows.map(r => r.action)).toEqual([
      'account.opened',
      'account.opened',
      'member.created',
    ]);
    expect(
      audited.rows.every(r => r.actor_description === president.email)
    ).toBe(true);
  });

  it('audits the reference change against the application itself', async () => {
    const { capture, workflow, members } = await load();
    const id = await captureComplete();
    const capturedReference = (await capture.loadApplication(id))!.reference;
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    const decided = await workflow.decideApplication(
      id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    // Findable from the APPLICATION's own history, not only by knowing to
    // look at the member's.
    const audited = await run(
      appUrl,
      `select previous_value->>'reference' as was,
              new_value->>'reference' as now
         from audit_event
        where action = 'membership.application.renumbered'
          and entity_type = 'membership_application'
          and entity_id = $1`,
      [id]
    );

    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0].was).toBe(capturedReference);
    expect(audited.rows[0].now).toBe(decided.member!.memberNo);
  });
});

describe('the actions offered come from the configured chain', () => {
  it('offers the officer submission, and nobody else', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    const application = (await capture.loadApplication(id))!;

    expect(
      (await workflow.availableActions(application, officer)).map(
        a => a.stepCode
      )
    ).toEqual(['capture']);
    expect(await workflow.availableActions(application, secretary)).toEqual([]);
    expect(await workflow.availableActions(application, president)).toEqual([]);
  });

  it('moves the offer along as the status changes', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    let application = (await capture.loadApplication(id))!;
    expect(
      (await workflow.availableActions(application, secretary)).map(
        a => a.stepCode
      )
    ).toEqual(['secretary_review']);
    expect(await workflow.availableActions(application, president)).toEqual([]);

    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    application = (await capture.loadApplication(id))!;
    expect(
      (await workflow.availableActions(application, president)).map(
        a => a.stepCode
      )
    ).toEqual(['president_decision']);
    expect(await workflow.availableActions(application, secretary)).toEqual([]);
  });

  it('refuses a step an administrator has disabled', async () => {
    const { workflow, config } = await load();
    const admin = { userId: officer.userId, email: officer.email };
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    const review = definition.steps.find(s => s.code === 'secretary_review')!;

    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await config.setStepEnabled(review.id, false, admin);
    try {
      await expect(
        workflow.reviewApplication(
          id,
          { outcome: 'forward', comment: 'Complete.' },
          secretary
        )
      ).rejects.toThrowError(/not enabled in the configured workflow/);
    } finally {
      await config.setStepEnabled(review.id, true, admin);
    }
  });
});

describe('S-611: Regional oversight, enabled or not, gates the chain', () => {
  async function setRegionalReviewEnabled(enabled: boolean) {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    const step = definition.steps.find(s => s.code === 'regional_review')!;
    await config.setStepEnabled(step.id, enabled, {
      userId: officer.userId,
      email: officer.email,
    });
  }

  afterEach(async () => {
    // Every other describe block in this file assumes the shipped default
    // (disabled) — restore it so a test order change elsewhere never
    // inherits it turned on.
    await setRegionalReviewEnabled(false);
  });

  it('is invisible and inert while disabled: submission goes straight to the Secretary', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    const application = (await capture.loadApplication(id))!;

    expect(
      (await workflow.availableActions(application, secretary)).map(
        a => a.stepCode
      )
    ).toEqual(['secretary_review']);
    expect(
      await workflow.availableActions(application, regionalManager)
    ).toEqual([]);
  });

  it('routes to the Regional Manager first once enabled, then to the Secretary once they forward', async () => {
    await setRegionalReviewEnabled(true);
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    let application = (await capture.loadApplication(id))!;

    // The Regional Manager sees it; the Secretary does not, even though both
    // hold application.review — the step's own configured role decides.
    expect(
      (await workflow.availableActions(application, regionalManager)).map(
        a => a.stepCode
      )
    ).toEqual(['regional_review']);
    expect(await workflow.availableActions(application, secretary)).toEqual([]);

    // A gate never moves the record on its own (S-209).
    expect(application.status).toBe('new');

    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Checked at the regional office.' },
      regionalManager,
      'regional_review'
    );
    application = (await capture.loadApplication(id))!;
    expect(application.status).toBe('new');

    // Now it is the Secretary's turn, and the Regional Manager's is done.
    expect(
      (await workflow.availableActions(application, secretary)).map(
        a => a.stepCode
      )
    ).toEqual(['secretary_review']);
    expect(
      await workflow.availableActions(application, regionalManager)
    ).toEqual([]);

    const forwarded = await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    expect(forwarded.status).toBe('submitted_for_approval');
  });

  it('refuses the Secretary who tries to act before Regional oversight has', async () => {
    await setRegionalReviewEnabled(true);
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Jumping the queue.' },
        secretary
      )
    ).rejects.toThrowError(/must happen first/);
  });

  it('refuses a Secretary who tries to act on the Regional oversight step, even holding the same permission', async () => {
    await setRegionalReviewEnabled(true);
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Not my step.' },
        secretary,
        'regional_review'
      )
    ).rejects.toThrowError(/not yours/);
  });

  it('lets the Regional Manager return an application for correction, same as the Secretary can', async () => {
    await setRegionalReviewEnabled(true);
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    const returned = await workflow.reviewApplication(
      id,
      { outcome: 'return', comment: 'Missing the signed form.' },
      regionalManager,
      'regional_review'
    );
    expect(returned.status).toBe('returned');
    expect((await capture.loadApplication(id))!.status).toBe('returned');
  });

  it('bars whoever gave regional oversight from also doing the Secretary review of the same application', async () => {
    await setRegionalReviewEnabled(true);
    const { workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Fine.' },
      regionalManager,
      'regional_review'
    );

    // Someone who holds both roles — the rule is about this record's
    // history, not which roles a person happens to hold (mirrors S-203).
    const regionalManagerWhoCanAlsoReview = principalFor(
      regionalManager.userId,
      regionalManager.email,
      ['application.view', 'application.review'],
      ['secretary']
    );

    await expect(
      workflow.reviewApplication(
        id,
        { outcome: 'forward', comment: 'Reviewing my own oversight.' },
        regionalManagerWhoCanAlsoReview
      )
    ).rejects.toThrowError(/may not also review it centrally/);
  });

  it('counts what is pending for each role, live off the chain rather than stored', async () => {
    await setRegionalReviewEnabled(true);
    const { workflow } = await load();

    const regionalBaseline = await workflow.pendingActionCount(regionalManager);
    const secretaryBaseline = await workflow.pendingActionCount(secretary);

    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    expect(await workflow.pendingActionCount(regionalManager)).toBe(
      regionalBaseline + 1
    );
    expect(await workflow.pendingActionCount(secretary)).toBe(
      secretaryBaseline
    );

    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Checked at the regional office.' },
      regionalManager,
      'regional_review'
    );

    expect(await workflow.pendingActionCount(regionalManager)).toBe(
      regionalBaseline
    );
    expect(await workflow.pendingActionCount(secretary)).toBe(
      secretaryBaseline + 1
    );
  });

  it('says who actually holds it while status is still new', async () => {
    await setRegionalReviewEnabled(true);
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    let application = (await capture.loadApplication(id))!;
    expect(await workflow.reviewStageLabel(application)).toBe(
      'With the Regional Manager'
    );

    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Checked at the regional office.' },
      regionalManager,
      'regional_review'
    );
    application = (await capture.loadApplication(id))!;
    expect(await workflow.reviewStageLabel(application)).toBe(
      'With the Secretary'
    );

    // Nothing to say once it has moved past 'new' altogether.
    await workflow.reviewApplication(
      id,
      { outcome: 'forward', comment: 'Complete.' },
      secretary
    );
    application = (await capture.loadApplication(id))!;
    expect(await workflow.reviewStageLabel(application)).toBeNull();
  });

  it('says "With the Secretary" straight away while disabled', async () => {
    const { capture, workflow } = await load();
    const id = await captureComplete();
    await workflow.submitApplication(id, officer);

    const application = (await capture.loadApplication(id))!;
    expect(await workflow.reviewStageLabel(application)).toBe(
      'With the Secretary'
    );
  });

  it('marks only the applications that have actually passed the gate', async () => {
    await setRegionalReviewEnabled(true);
    const { capture, workflow } = await load();
    const pending = await captureComplete();
    const passed = await captureComplete();
    await workflow.submitApplication(pending, officer);
    await workflow.submitApplication(passed, officer);
    await workflow.reviewApplication(
      passed,
      { outcome: 'forward', comment: 'Checked.' },
      regionalManager,
      'regional_review'
    );

    const passedIds = await workflow.regionalReviewPassedIds([pending, passed]);
    expect(passedIds.has(pending)).toBe(false);
    expect(passedIds.has(passed)).toBe(true);
  });
});

// S-613, phase 7: an additional-account application shares the exact same
// chain a membership application does (S-612) — proved here by driving one
// through submit, review and decide with zero changes to the functions
// above, the same way M3's own walking-skeleton test above proves the
// membership path. openAccountsForApplication (members/create.ts) is the
// counterpart to createMemberFromApplication as the decide callback.
describe('S-613: an additional-account application, end to end', () => {
  let accountTypeId: string;
  let accountTypeName: string;

  beforeAll(async () => {
    const type = await runAsActor(
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('hsa_workflow_test', 'Hajj Savings (test)', 'savings', 1000.00, false)
       returning id, name`
    );
    accountTypeId = type.rows[0].id;
    accountTypeName = type.rows[0].name;
  });

  async function activeMember() {
    const membershipType = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by)
       values ($1, $2) returning id`,
      [membershipType.rows[0].id, officer.userId]
    );
    const member = await run(
      appUrl,
      `insert into member (application_id, membership_type_id, status)
       values ($1, $2, 'active') returning id, member_no`,
      [application.rows[0].id, membershipType.rows[0].id]
    );
    return {
      id: member.rows[0].id as string,
      memberNo: member.rows[0].member_no as string,
    };
  }

  it('takes an application from capture to an opened account, under the existing member', async () => {
    const { capture, workflow, members, payments } = await load();
    const member = await activeMember();

    const application = await capture.startAdditionalAccountApplication(
      member.id,
      [accountTypeId],
      officer
    );

    // The document checklist is complete with nothing filed: this test
    // account type has no checklist_id, so checklistForAccountTypes
    // (reference.ts, S-613 phase 4) has nothing required to offer.
    const paymentClerk: Principal = {
      ...officer,
      permissions: new Set([...officer.permissions, 'payment.record']),
    };
    await payments.recordAccountOpeningPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      paymentClerk
    );

    const submitted = await workflow.submitApplication(application.id, officer);
    expect(submitted).toEqual({ status: 'new' });

    const reviewed = await workflow.reviewApplication(
      application.id,
      { outcome: 'forward', comment: 'Payment confirmed.' },
      secretary
    );
    expect(reviewed.status).toBe('submitted_for_approval');

    const decided = await workflow.decideApplication(
      application.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForApplication
    );

    expect(decided.status).toBe('approved');
    // Unlike a membership approval, this is the member who already existed —
    // not a fresh AB number.
    expect(decided.member?.id).toBe(member.id);
    expect(decided.member?.memberNo).toBe(member.memberNo);
    expect(decided.member?.accounts).toEqual([
      expect.objectContaining({ typeName: accountTypeName }),
    ]);

    const loaded = await members.loadMember(member.id);
    expect(loaded!.accounts.map(a => a.accountTypeName)).toContain(
      accountTypeName
    );
    // Opened under the member's own number, the same as any other account.
    expect(
      loaded!.accounts.find(a => a.accountTypeName === accountTypeName)!
        .accountNo
    ).toBe(member.memberNo);

    // Members page feedback: clicking this account's button gives every
    // credit and debit recorded against it — traced back through the
    // additional_account application that opened it, since the account row
    // itself keeps no link to it.
    const openedAccountId = loaded!.accounts.find(
      a => a.accountTypeName === accountTypeName
    )!.id;
    const transactions = await payments.transactionsForAccount(openedAccountId);
    expect(transactions).toEqual([
      expect.objectContaining({
        type: 'credit',
        amount: '1000.00',
        currency: 'MUR',
      }),
    ]);
  });

  // Officer feedback: the Members page's own "Total funds" column — the
  // member's founding application here (activeMember) carries no Shares or
  // MSA payment, so this account's own 1000.00 is the whole of it, proving
  // the additional_account branch of listMembers' total_funds sum reaches an
  // account this way — traced through the application, since the account row
  // itself carries no link back to what opened it (same reason
  // transactionsForAccount, above, has to trace it the same way).
  it('counts an opened additional account towards the Members page total', async () => {
    const { capture, workflow, members, payments } = await load();
    const member = await activeMember();

    const application = await capture.startAdditionalAccountApplication(
      member.id,
      [accountTypeId],
      officer
    );
    await payments.recordAccountOpeningPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(application.id, officer);
    await workflow.reviewApplication(
      application.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    await workflow.decideApplication(
      application.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForApplication
    );

    const listed = (await members.listMembers({ search: member.memberNo }))
      .members[0];
    expect(listed.totalFunds).toBe('1000.00');
  });

  it('refuses a second application for an account type already open', async () => {
    const { capture, members, payments, workflow } = await load();
    const member = await activeMember();

    // First one goes all the way through and opens it.
    const first = await capture.startAdditionalAccountApplication(
      member.id,
      [accountTypeId],
      officer
    );
    await payments.recordAccountOpeningPayment(
      {
        applicationId: first.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(first.id, officer);
    await workflow.reviewApplication(
      first.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    await workflow.decideApplication(
      first.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForApplication
    );

    // A second application selecting the same account type is exactly what
    // account_one_per_type_per_member_idx (migration 0018) exists to stop —
    // refused here with a plain message rather than a raw constraint error.
    const second = await capture.startAdditionalAccountApplication(
      member.id,
      [accountTypeId],
      officer
    );
    await payments.recordAccountOpeningPayment(
      {
        applicationId: second.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(second.id, officer);
    await workflow.reviewApplication(
      second.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );

    await expect(
      workflow.decideApplication(
        second.id,
        { outcome: 'approve', comment: '' },
        president,
        members.openAccountsForApplication
      )
    ).rejects.toThrowError(/already has/);
  });

  it('refuses openAccountsForApplication for a membership application', async () => {
    const { capture, members } = await load();
    const id = await captureComplete();
    const application = (await capture.loadApplication(id))!;

    const { withTransaction } = await import('../db/pool');
    await expect(
      withTransaction(client =>
        members.openAccountsForApplication(client, application, {
          userId: officer.userId,
          email: officer.email,
        })
      )
    ).rejects.toThrowError(/does not open an account/);
  });
});

// S-614, phase 3: someone not yet on the system at all shares the exact same
// chain both a membership and an additional-account application do — proved
// here the same way S-613's own end-to-end test proves it for an existing
// member. openAccountsForCustomerApplication (members/create.ts) is the
// decide callback, the counterpart to createMemberFromApplication and
// openAccountsForApplication for someone who was never a member to begin
// with.
describe('S-614: a customer_account application, end to end', () => {
  let accountTypeId: string;
  let accountTypeName: string;

  beforeAll(async () => {
    const type = await runAsActor(
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default,
          number_prefix)
       values ('hsa_customer_test', 'Hajj Savings (customer test)', 'savings',
               1000.00, false, 'HSA')
       returning id, name`
    );
    accountTypeId = type.rows[0].id;
    accountTypeName = type.rows[0].name;
  });

  it('takes an application from capture to an opened, numbered account for a non-member', async () => {
    const { capture, workflow, members, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };

    const application = await capture.startCustomerAccountApplication(
      [accountTypeId],
      officer
    );
    // Nothing was captured at start — the applicant's own details are filled
    // in the same way a membership application's are, against the same
    // fields (S-614 phase 2).
    await capture.saveDraft(application.id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, application.id);
    await verifyRequiredDocuments(documents, application.id);

    const paymentClerk: Principal = {
      ...officer,
      permissions: new Set([...officer.permissions, 'payment.record']),
    };
    await payments.recordAccountOpeningPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      paymentClerk
    );

    const submitted = await workflow.submitApplication(application.id, officer);
    expect(submitted).toEqual({ status: 'new' });

    const reviewed = await workflow.reviewApplication(
      application.id,
      { outcome: 'forward', comment: 'Payment confirmed.' },
      secretary
    );
    expect(reviewed.status).toBe('submitted_for_approval');

    const decided = await workflow.decideApplication(
      application.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForCustomerApplication
    );

    expect(decided.status).toBe('approved');
    // Not a member — nothing named memberNo here, unlike either of the other
    // two kinds.
    expect(decided.member?.memberNo).toBe('');
    expect(decided.member?.accounts).toEqual([
      expect.objectContaining({
        typeName: accountTypeName,
        accountNo: expect.stringMatching(/^HSA\d{4}$/),
      }),
    ]);

    const customer = await run(
      appUrl,
      `select id, application_id from customer where id = $1`,
      [decided.member!.id]
    );
    expect(customer.rows[0].application_id).toBe(application.id);

    const account = await run(
      appUrl,
      `select member_id, customer_id, account_no
         from account where id = $1`,
      [decided.member!.accounts[0].id]
    );
    expect(account.rows[0].member_id).toBeNull();
    expect(account.rows[0].customer_id).toBe(decided.member!.id);
    expect(account.rows[0].account_no).toBe(
      decided.member!.accounts[0].accountNo
    );
  });

  it('refuses to open an account of a type with no numbering configured', async () => {
    const { capture, workflow, members, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };

    const unprefixed = await runAsActor(
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default)
       values ('inv_no_prefix_test', 'Investment (no prefix)', 'savings',
               500.00, false)
       returning id`
    );

    const application = await capture.startCustomerAccountApplication(
      [unprefixed.rows[0].id],
      officer
    );
    await capture.saveDraft(application.id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, application.id);
    await verifyRequiredDocuments(documents, application.id);
    await payments.recordAccountOpeningPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { [unprefixed.rows[0].id]: '500.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(application.id, officer);
    await workflow.reviewApplication(
      application.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );

    await expect(
      workflow.decideApplication(
        application.id,
        { outcome: 'approve', comment: '' },
        president,
        members.openAccountsForCustomerApplication
      )
    ).rejects.toThrowError(/no account numbering set/);
  });

  it('refuses openAccountsForCustomerApplication for a membership application', async () => {
    const { capture, members } = await load();
    const id = await captureComplete();
    const application = (await capture.loadApplication(id))!;

    const { withTransaction } = await import('../db/pool');
    await expect(
      withTransaction(client =>
        members.openAccountsForCustomerApplication(client, application, {
          userId: officer.userId,
          email: officer.email,
        })
      )
    ).rejects.toThrowError(/does not open accounts for a non-member/);
  });

  // S-614: an approved customer appears on the same list a member does —
  // tagged, and findable both by name and by the account number just
  // opened, since an officer searching does not know in advance which kind
  // of record they are looking for.
  it('lists on listMembers, tagged, and loads its own detail', async () => {
    const { capture, workflow, members, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };

    const application = await capture.startCustomerAccountApplication(
      [accountTypeId],
      officer
    );
    const values = COMPLETE_INDIVIDUAL.map(p =>
      p.subject === 'applicant'
        ? { ...p, values: { ...p.values, surname: 'Ramtoola' } }
        : p
    );
    await capture.saveDraft(application.id, values, actor);
    await fileRequiredDocuments(documents, application.id);
    await verifyRequiredDocuments(documents, application.id);
    await payments.recordAccountOpeningPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { [accountTypeId]: '1000.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(application.id, officer);
    await workflow.reviewApplication(
      application.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    const decided = await workflow.decideApplication(
      application.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForCustomerApplication
    );
    const accountNo = decided.member!.accounts[0].accountNo!;

    const byName = await members.listMembers({ search: 'Ramtoola' });
    expect(byName.members).toEqual([
      expect.objectContaining({
        id: decided.member!.id,
        kind: 'customer',
        memberNo: accountNo,
        membershipTypeName: accountTypeName,
        // The Members page's own "Total funds" column — a customer has no
        // Shares or MSA (they are not a member), only what they paid to
        // open this account.
        totalFunds: '1000.00',
      }),
    ]);

    const byAccountNo = await members.listMembers({ search: accountNo });
    expect(byAccountNo.members.map(m => m.id)).toEqual([decided.member!.id]);

    const loaded = await members.loadCustomer(decided.member!.id);
    expect(loaded!.kind).toBe('customer');
    expect(loaded!.applicationReference).toBe(application.reference);
    expect(loaded!.accounts).toEqual([
      expect.objectContaining({ accountNo, accountTypeName }),
    ]);

    // A member's own id is not found through loadCustomer, the same way a
    // customer's is not found through loadMember.
    const anyMember = (await members.listMembers({ limit: 100 })).members.find(
      m => m.kind === 'member'
    )!;
    expect(await members.loadCustomer(anyMember.id)).toBeNull();
  });
});

// S-614, phase 6: an existing non-member's account moves with them when
// they become a member — createMemberFromApplication (members/create.ts)
// reads application.sourceCustomerId (migration 0029), set only by
// startMembershipApplicationFromCustomer (capture.ts).
describe('S-614: the account a non-member already held transfers when they become a member', () => {
  it('transfers the account, opens Shares and the MSA alongside it, and marks the customer converted', async () => {
    const { capture, workflow, members, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };

    const accountType = await runAsActor(
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default,
          number_prefix)
       values ('hsa_transfer_test', 'Hajj Savings (transfer test)', 'savings',
               1000.00, false, 'HST')
       returning id, name`
    );

    // A real customer, holding a real account, through the same chain
    // S-614's own end-to-end test above already proves.
    const custApp = await capture.startCustomerAccountApplication(
      [accountType.rows[0].id],
      officer
    );
    await capture.saveDraft(custApp.id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, custApp.id);
    await verifyRequiredDocuments(documents, custApp.id);
    await payments.recordAccountOpeningPayment(
      {
        applicationId: custApp.id,
        method: 'cash',
        amounts: { [accountType.rows[0].id]: '1000.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(custApp.id, officer);
    await workflow.reviewApplication(
      custApp.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    const custDecided = await workflow.decideApplication(
      custApp.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForCustomerApplication
    );
    const customerId = custDecided.member!.id;
    const heldAccountId = custDecided.member!.accounts[0].id;

    // Now they apply to become a member. Parties are already complete
    // (copied from the customer_account application), so this goes
    // straight to documents and payment — an ordinary Individual
    // application from here, per startMembershipApplicationFromCustomer's
    // own contract.
    const memApp = await capture.startMembershipApplicationFromCustomer(
      customerId,
      officer
    );
    await fileRequiredDocuments(documents, memApp.id);
    await verifyRequiredDocuments(documents, memApp.id);
    await recordFullPayment(payments, memApp.id);
    await workflow.submitApplication(memApp.id, officer);
    await workflow.reviewApplication(
      memApp.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    const memDecided = await workflow.decideApplication(
      memApp.id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    // Shares and the MSA open the same way any membership approval opens
    // them; the HSA is not a third, freshly opened account but the one
    // already held, now under the new member.
    expect(memDecided.member!.accounts.map(a => a.typeCode).sort()).toEqual(
      ['hsa_transfer_test', 'msa', 'shares'].sort()
    );
    expect(
      memDecided.member!.accounts.find(a => a.id === heldAccountId)
    ).toBeDefined();

    const transferred = await run(
      appUrl,
      `select member_id, customer_id, account_no, is_membership_default
         from account where id = $1`,
      [heldAccountId]
    );
    expect(transferred.rows[0].member_id).toBe(memDecided.member!.id);
    expect(transferred.rows[0].customer_id).toBeNull();
    expect(transferred.rows[0].account_no).toBeNull();
    expect(transferred.rows[0].is_membership_default).toBe(false);

    const customerRow = await run(
      appUrl,
      `select status from customer where id = $1`,
      [customerId]
    );
    expect(customerRow.rows[0].status).toBe('converted');
  });

  it('refuses to apply again once converted', async () => {
    const { capture, workflow, members, documents, payments } = await load();
    const actor = { userId: officer.userId, email: officer.email };

    const accountType = await runAsActor(
      `insert into account_type
         (code, name, category, minimum_opening_amount, is_membership_default,
          number_prefix)
       values ('inv_transfer_test', 'Investment (transfer test)', 'savings',
               500.00, false, 'INV')
       returning id`
    );
    const custApp = await capture.startCustomerAccountApplication(
      [accountType.rows[0].id],
      officer
    );
    await capture.saveDraft(custApp.id, COMPLETE_INDIVIDUAL, actor);
    await fileRequiredDocuments(documents, custApp.id);
    await verifyRequiredDocuments(documents, custApp.id);
    await payments.recordAccountOpeningPayment(
      {
        applicationId: custApp.id,
        method: 'cash',
        amounts: { [accountType.rows[0].id]: '500.00' },
      },
      {
        ...officer,
        permissions: new Set([...officer.permissions, 'payment.record']),
      }
    );
    await workflow.submitApplication(custApp.id, officer);
    await workflow.reviewApplication(
      custApp.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    const custDecided = await workflow.decideApplication(
      custApp.id,
      { outcome: 'approve', comment: '' },
      president,
      members.openAccountsForCustomerApplication
    );
    const customerId = custDecided.member!.id;

    const memApp = await capture.startMembershipApplicationFromCustomer(
      customerId,
      officer
    );
    await fileRequiredDocuments(documents, memApp.id);
    await verifyRequiredDocuments(documents, memApp.id);
    await recordFullPayment(payments, memApp.id);
    await workflow.submitApplication(memApp.id, officer);
    await workflow.reviewApplication(
      memApp.id,
      { outcome: 'forward', comment: 'ok' },
      secretary
    );
    await workflow.decideApplication(
      memApp.id,
      { outcome: 'approve', comment: '' },
      president,
      members.createMemberFromApplication
    );

    await expect(
      capture.startMembershipApplicationFromCustomer(customerId, officer)
    ).rejects.toThrowError(/Only an active customer/);
  });
});
