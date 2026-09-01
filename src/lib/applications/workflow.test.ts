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
  permissions: string[]
): Principal {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles: [],
    permissions: new Set(permissions),
  };
}

let officer: Principal;
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
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email::text as email`
  );
  const id = (email: string) =>
    users.rows.find(r => r.email === email).id as string;

  officer = principalFor(id('officer@albarakah.mu'), 'officer@albarakah.mu', [
    'application.view',
    'application.capture',
    'application.submit',
  ]);
  secretary = principalFor(
    id('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['application.view', 'application.review']
  );
  president = principalFor(
    id('president@albarakah.mu'),
    'president@albarakah.mu',
    ['application.view', 'application.approve']
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
  await recordFullPayment(payments, id);
  return id;
}

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
      ['application.view', 'application.review']
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
      ['application.view', 'application.approve']
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

    const clerk = principalFor(secretary.userId, secretary.email, [
      'application.view',
      'application.submit',
      'application.review',
    ]);
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

  it('gives every member a distinct number in the documented format', async () => {
    const { members } = await load();
    const all = await members.listMembers({ limit: 100 });

    expect(all.members.length).toBeGreaterThan(1);
    expect(all.members.every(m => /^AB\d{4,}$/.test(m.memberNo))).toBe(true);
    expect(new Set(all.members.map(m => m.memberNo)).size).toBe(
      all.members.length
    );
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
