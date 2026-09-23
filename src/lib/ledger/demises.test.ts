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

// A deceased member's claim (S-1704), against real migrations: the
// claimant, the two papers, the two figures, the chain, and the one
// disbursement that empties every account, closes them and ends the
// membership.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `demises_test_${Date.now()}`;
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

const configure = (sql: string) =>
  run(
    appUrl,
    `begin; set local albarakah.actor_description = 'demises.test'; ${sql}; commit;`
  );

let openPool: typeof import('../db/pool') | null = null;

async function closeOpenPool() {
  if (openPool) {
    await openPool.closePool();
    openPool = null;
  }
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    demises: await import('./demises'),
    closures: await import('./closures'),
    deposits: await import('./deposits'),
    review: await import('./review'),
    ledger: await import('./ledger'),
    timeline: await import('../workflow/timeline'),
    config: await import('../config/reference'),
    cache: await import('../config/cache'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let clerk: Principal;
let officer: Principal;
let treasurer: Principal;
let secretary: Principal;
let president: Principal;
let member: { id: string; shares: string; msa: string; hsa: string };
let certificateTypeId: string;
let affidavitTypeId: string;
let bankAccountId: string;

function principalFor(
  userId: string,
  email: string,
  roles: string[],
  permissions: string[]
) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles,
    roleNames: roles.map(r => r.replace('_', ' ')),
    permissions: new Set(permissions),
  } satisfies Principal;
}

async function filePaper(
  transactionId: string,
  documentTypeId: string,
  by: Principal
) {
  const doc = await run(
    appUrl,
    `insert into document (document_type_id, subject, transaction_id, state)
     values ($1, 'applicant', $2, 'under_review') returning id`,
    [documentTypeId, transactionId]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'paper.pdf', 'application/pdf', 1234,
             $3, $2, now())`,
    [doc.rows[0].id, by.userId, `/test/${doc.rows[0].id}.pdf`]
  );
}

async function accountStatus(id: string) {
  return (
    await run(appUrl, `select status, closed_at from account where id = $1`, [
      id,
    ])
  ).rows[0];
}

async function memberStatus() {
  return (
    await run(
      appUrl,
      `select status, status_changed_at from member where id = $1`,
      [member.id]
    )
  ).rows[0];
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('clerk@albarakah.mu', 'Clerk'),
            ('officer@albarakah.mu', 'Officer'),
            ('treasurer@albarakah.mu', 'Treasurer'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  clerk = principalFor(
    byEmail.get('clerk@albarakah.mu'),
    'clerk@albarakah.mu',
    ['clerk'],
    ['transaction.capture', 'transaction.view']
  );
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['transaction.post', 'transaction.disburse', 'transaction.view']
  );
  secretary = principalFor(
    byEmail.get('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['secretary'],
    ['transaction.review', 'transaction.view']
  );
  president = principalFor(
    byEmail.get('president@albarakah.mu'),
    'president@albarakah.mu',
    ['president'],
    ['transaction.approve', 'transaction.view']
  );

  await configure(
    `insert into account_type
       (code, name, category, number_prefix, sort_order, allows_withdrawal)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false)`
  );

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}'),
            ($1, 'nominee', 1, '{"name": "Yusuf", "surname": "Test", "nic": "Y1234567890123", "address": "12 Rue des Palmiers, Curepipe"}')`,
    [application.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (code: string, accountNo: string | null) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, 'active', $4) returning id`,
        [m.rows[0].id, types[code], accountNo === null, accountNo]
      )
    ).rows[0].id;
  member = {
    id: m.rows[0].id,
    shares: await open('shares', null),
    msa: await open('msa', null),
    hsa: await open('hsa', 'HSA0001'),
  };
  certificateTypeId = (
    await run(
      appUrl,
      `select id from document_type where code = 'death_certificate'`
    )
  ).rows[0].id;
  affidavitTypeId = (
    await run(appUrl, `select id from document_type where code = 'affidavit'`)
  ).rows[0].id;

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;

  // Money on every account: Shares 8,000, MSA 12,000, HSA 1,000.
  const { deposits } = await load();
  for (const [accountId, amount] of [
    [member.shares, '8000'],
    [member.msa, '12000'],
    [member.hsa, '1000'],
  ] as const) {
    await deposits.recordDeposit(
      { accountId, amount, method: 'cash' },
      officer
    );
  }
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a demised claim (S-1704)', () => {
  it('names the nominee by default, or another person in full', async () => {
    const { demises } = await load();
    expect(await demises.nomineeFor(member.id)).toEqual({
      name: 'Yusuf Test',
      nic: 'Y1234567890123',
      address: '12 Rue des Palmiers, Curepipe',
      relation: 'Nominee',
      email: null,
      mobile: null,
    });
    await expect(
      demises.startDemise(
        {
          memberId: member.id,
          claimant: { kind: 'other', name: 'Fatima Test' },
          method: 'cash',
        },
        clerk
      )
    ).rejects.toThrowError(/Enter the claimant’s NIC, address, relation/);
    await expect(
      demises.startDemise(
        { memberId: member.id, claimant: { kind: 'nominee' }, method: 'cash' },
        secretary
      )
    ).rejects.toThrowError(/permission/);
  });

  it('adds the Takaful benefit as its own line, and the total is every account plus it', async () => {
    const { demises, config } = await load();
    expect(await config.takafulBenefit()).toBe('15000');
    const totals = await demises.claimTotals(member.id);
    expect(totals.accounts.map(a => a.id)).toEqual([
      member.shares,
      member.msa,
      member.hsa,
    ]);
    expect(totals).toMatchObject({
      accountsTotal: '21000.00',
      takafulBenefit: '15000.00',
      total: '36000.00',
    });
  });

  it('is a draft with the claimant, submits with the certificate and the affidavit, and posting pays the claimant, closes every account and ends the membership', async () => {
    const { demises, deposits, review, ledger, timeline, config, cache } =
      await load();
    const draft = await demises.startDemise(
      {
        memberId: member.id,
        claimant: { kind: 'nominee' },
        method: 'bank_transfer',
        methodReference: 'MCB 9',
        bankAccountId,
      },
      clerk
    );
    expect(draft).toMatchObject({
      kind: 'demise',
      status: 'draft',
      amount: '36000.00',
      takafulBenefit: '15000.00',
      claimantKind: 'nominee',
      payeeName: 'Yusuf Test',
    });
    expect(draft.claimant).toMatchObject({ nic: 'Y1234567890123' });
    expect(await demises.demiseInFlightFor(member.id)).toMatchObject({
      id: draft.id,
    });
    await expect(
      demises.startDemise(
        { memberId: member.id, claimant: { kind: 'nominee' }, method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/is already settling this member/);

    // The claimant can be changed to another person while it is a draft.
    const edited = await demises.updateDemise(
      draft.id,
      {
        claimant: {
          kind: 'other',
          name: 'Fatima Test',
          nic: 'F0987654321098',
          address: '3 Avenue des Roses, Rose Hill',
          relation: 'Daughter',
        },
        method: 'cash',
      },
      clerk
    );
    expect(edited.payeeName).toBe('Fatima Test');
    expect(edited.claimant?.relation).toBe('Daughter');

    // Both papers, or nothing submits.
    await expect(demises.submitDemise(draft.id, clerk)).rejects.toThrowError(
      /File the death certificate and the affidavit/
    );
    await filePaper(draft.id, certificateTypeId, clerk);
    await expect(demises.submitDemise(draft.id, clerk)).rejects.toThrowError(
      /File the death certificate and the affidavit/
    );
    expect(
      (await timeline.chainTimeline('transaction', draft.id))!.map(s => [
        s.key,
        s.label,
        s.state,
        s.detail ?? null,
      ])
    ).toEqual([
      ['details', 'Claimant', 'done', null],
      ['documents', 'Documents', 'current', '1 to file'],
      ['capture', 'Submitted', 'todo', null],
      ['secretary_review', 'Secretary review', 'todo', 'Secretary'],
      [
        'president_decision',
        'President decision',
        'todo',
        'President / Chairperson',
      ],
      ['posted', 'Disbursement', 'todo', 'Treasurer'],
    ]);
    await filePaper(draft.id, affidavitTypeId, clerk);
    const checklist = await demises.demiseChecklist(draft.id);
    expect(checklist.map(i => [i.documentCode, i.filed !== null])).toEqual([
      ['death_certificate', true],
      ['affidavit', true],
    ]);

    // The benefit is read when the claim is submitted, so a change in
    // configuration before then is what is paid.
    await config.setTakafulBenefit('20000', {
      userId: officer.userId,
      email: officer.email,
    });
    cache.clearReferenceCache();
    const submitted = await demises.submitDemise(draft.id, clerk);
    expect(submitted.status).toBe('submitted');
    expect(submitted.workflowCode).toBe('transaction_demise');
    expect(submitted.takafulBenefit).toBe('20000.00');
    expect(submitted.amount).toBe('41000.00');
    for (const id of [member.shares, member.msa, member.hsa]) {
      expect((await accountStatus(id)).status).toBe('closing');
    }
    await expect(
      deposits.recordDeposit(
        { accountId: member.hsa, amount: '10', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This account is closing/);

    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: 'Papers in order' },
      president
    );
    const posted = await review.postApprovedTransaction(draft.id, treasurer, {
      method: 'cash',
    });
    expect(posted.status).toBe('posted');
    expect(posted.amount).toBe('41000.00');
    expect(posted.payeeName).toBe('Fatima Test');
    expect(posted.receiptNo).toMatch(/^RCT-/);
    for (const id of [member.shares, member.msa, member.hsa]) {
      expect(await accountStatus(id)).toMatchObject({
        status: 'closed',
        closed_at: expect.any(Date),
      });
      expect((await ledger.accountBalance(id))?.balance).toBe('0.00');
    }
    const entries = await run(
      appUrl,
      `select account_id, amount from account_entry
        where transaction_id = $1 order by sequence_no`,
      [draft.id]
    );
    expect(entries.rows).toEqual([
      { account_id: member.shares, amount: '8000.00' },
      { account_id: member.msa, amount: '12000.00' },
      { account_id: member.hsa, amount: '1000.00' },
    ]);
    expect(await memberStatus()).toMatchObject({
      status: 'demised',
      status_changed_at: expect.any(Date),
    });
    const event = await run(
      appUrl,
      `select payload from financial_event where transaction_id = $1`,
      [draft.id]
    );
    expect(event.rows[0].payload).toMatchObject({
      kind: 'demise',
      account_closed: true,
      membership_ended: true,
      takaful_benefit: 20000,
      claimant: 'Fatima Test',
      amount: 41000,
    });
    await expect(
      demises.startDemise(
        { memberId: member.id, claimant: { kind: 'nominee' }, method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This member is demised/);
  });

  it('reopens every account when the chain rejects it, and when the officer withdraws it', async () => {
    const { demises, review } = await load();
    const membershipTypeId = (
      await run(
        appUrl,
        `select id from membership_type where code = 'individual'`
      )
    ).rows[0].id;
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, '{"name": "Bilal", "surname": "Test"}')`,
      [application.rows[0].id]
    );
    const m = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const types = Object.fromEntries(
      (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
        r.code,
        r.id,
      ])
    );
    const accounts: string[] = [];
    for (const code of ['shares', 'msa']) {
      accounts.push(
        (
          await run(
            appUrl,
            `insert into account (member_id, account_type_id, is_membership_default, status)
             values ($1, $2, true, 'active') returning id`,
            [m.rows[0].id, types[code]]
          )
        ).rows[0].id
      );
    }
    // No nominee on file: the claimant has to be named.
    await expect(
      demises.startDemise(
        {
          memberId: m.rows[0].id,
          claimant: { kind: 'nominee' },
          method: 'cash',
        },
        clerk
      )
    ).rejects.toThrowError(/No nominee is on file/);
    const claimant = {
      kind: 'other' as const,
      name: 'Zainab Test',
      nic: 'Z1111111111111',
      address: 'Port Louis',
      relation: 'Wife',
    };
    // Empty accounts: the total is the benefit alone, whatever it is set
    // to by now.
    const expected = (await demises.claimTotals(m.rows[0].id)).total;
    const first = await demises.startDemise(
      { memberId: m.rows[0].id, claimant, method: 'cash' },
      clerk
    );
    expect(first.amount).toBe(expected);
    expect(first.amount).toBe(first.takafulBenefit);
    await filePaper(first.id, certificateTypeId, clerk);
    await filePaper(first.id, affidavitTypeId, clerk);
    await demises.submitDemise(first.id, clerk);
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('closing');
    }
    await review.reviewTransaction(
      first.id,
      { outcome: 'reject', comment: 'Wrong certificate' },
      secretary
    );
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('active');
    }

    const second = await demises.startDemise(
      { memberId: m.rows[0].id, claimant, method: 'cash' },
      clerk
    );
    await filePaper(second.id, certificateTypeId, clerk);
    await filePaper(second.id, affidavitTypeId, clerk);
    await demises.submitDemise(second.id, clerk);
    await review.reviewTransaction(
      second.id,
      { outcome: 'return', comment: 'Affidavit again' },
      secretary
    );
    const cancelled = await demises.cancelDemise(second.id, clerk);
    expect(cancelled.status).toBe('cancelled');
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('active');
    }
    expect(await demises.demiseInFlightFor(m.rows[0].id)).toBeNull();
  });
});
