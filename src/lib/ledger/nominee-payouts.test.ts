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
import { openEveryDrawer } from '../cash/drawers.testing';
import type { Principal } from '../access/principal';

// Nominees per account (applications/account-nominee.ts) and a death claim
// split between them (ledger/nominee-payouts.ts), against real migrations:
// the Shares and MSA go to the nominee on the founding application, a Hajj
// Savings account opened later to the different nominee named for it, and
// the Treasurer pays each their own cheque.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `nominee_payouts_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'nominee-payouts.test'; ${sql}; commit;`
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
    deposits: await import('./deposits'),
    review: await import('./review'),
    payouts: await import('./nominee-payouts'),
    accountNominee: await import('../applications/account-nominee'),
    capture: await import('../applications/capture'),
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
let hsaApplicationId: string;
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
    ['transaction.capture', 'transaction.view', 'application.capture']
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
  const founding = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}'),
            ($1, 'nominee', 1, '{"name": "Yusuf", "surname": "Test", "nic": "Y1234567890123", "address": "Curepipe"}')`,
    [founding.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id, member_no)
     values ($1, $2, 'AB0001') returning id`,
    [founding.rows[0].id, membershipTypeId]
  );
  // The Hajj Savings account, opened later on an application of its own
  // that names a different nominee.
  const further = await run(
    appUrl,
    `insert into membership_application
       (application_kind, existing_member_id, captured_by, status)
     values ('additional_account', $1, $2, 'approved') returning id`,
    [m.rows[0].id, officer.userId]
  );
  hsaApplicationId = further.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'nominee', 1, '{"name": "Bilal", "surname": "Test", "nic": "B1234567890123", "address": "Port Louis"}')`,
    [hsaApplicationId]
  );
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (
    code: string,
    accountNo: string | null,
    applicationId: string
  ) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status,
            account_no, opened_by_application_id)
         values ($1, $2, $3, 'active', $4, $5) returning id`,
        [
          m.rows[0].id,
          types[code],
          accountNo === null,
          accountNo,
          applicationId,
        ]
      )
    ).rows[0].id;
  member = {
    id: m.rows[0].id,
    shares: await open('shares', null, founding.rows[0].id),
    msa: await open('msa', null, founding.rows[0].id),
    hsa: await open('hsa', 'HSA0001', hsaApplicationId),
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

  await openEveryDrawer(ownerUrl);

  // Shares 8,000, MSA 12,000, HSA 3,000.
  const { deposits } = await load();
  for (const [accountId, amount] of [
    [member.shares, '8000'],
    [member.msa, '12000'],
    [member.hsa, '3000'],
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

describe('a nominee per account', () => {
  it('offers the nominee on file, or a different one with every mandatory field', async () => {
    const { accountNominee, capture } = await load();
    const draft = await run(
      appUrl,
      `insert into membership_application
         (application_kind, existing_member_id, captured_by, status)
       values ('additional_account', $1, $2, 'draft') returning id`,
      [member.id, clerk.userId]
    );
    const id = draft.rows[0].id;
    const application = (await capture.loadApplication(id))!;
    const choice = await accountNominee.accountNomineeChoice(application);
    expect(choice?.existingName).toBe('Yusuf Test');
    expect(choice?.own).toBeNull();
    expect(choice?.fields.map(f => f.fieldKey)).toEqual(
      expect.arrayContaining(['surname', 'name', 'nic', 'address'])
    );

    await expect(
      accountNominee.setAccountNominee(
        id,
        { choice: 'different', values: { name: 'Bilal' } },
        clerk
      )
    ).rejects.toThrowError(/required/);

    await accountNominee.setAccountNominee(
      id,
      {
        choice: 'different',
        values: {
          surname: 'Test',
          name: 'Bilal',
          nic: 'B1234567890123',
          address: 'Port Louis',
        },
      },
      clerk
    );
    const named = await accountNominee.accountNomineeChoice(
      (await capture.loadApplication(id))!
    );
    expect(named?.own).toMatchObject({ name: 'Bilal', nic: 'B1234567890123' });

    await accountNominee.setAccountNominee(
      id,
      { choice: 'same', values: {} },
      clerk
    );
    const same = await accountNominee.accountNomineeChoice(
      (await capture.loadApplication(id))!
    );
    expect(same?.own).toBeNull();
  });
});

describe('a death claim to the nominees', () => {
  it('splits by nominee: the Shares and MSA and the benefit to one, the Hajj Savings to the other', async () => {
    const { payouts } = await load();
    const split = await payouts.nomineePayouts(
      { memberId: member.id, customerId: null },
      '15000'
    );
    expect(
      split.map(p => [
        p.claimant.name,
        p.accounts.map(a => a.typeName),
        p.amount,
        p.takafulBenefit,
      ])
    ).toEqual([
      [
        'Yusuf Test',
        ['Shares', 'Multiplier Savings Account'],
        '35000.00',
        '15000.00',
      ],
      ['Bilal Test', ['Hajj Savings'], '3000.00', '0.00'],
    ]);
  });

  it('is paid as one cheque per nominee, each recorded with its reference', async () => {
    const { demises, review } = await load();
    const draft = await demises.startDemise(
      { memberId: member.id, claimant: { kind: 'nominee' } },
      clerk
    );
    await filePaper(draft.id, certificateTypeId, clerk);
    await filePaper(draft.id, affidavitTypeId, clerk);
    await demises.submitDemise(draft.id, clerk);
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

    // A cheque for each nominee, each with its own number.
    await expect(
      review.postApprovedTransaction(draft.id, treasurer, {
        method: 'cheque',
        payoutReferences: ['CHQ-001', ''],
        bankAccountId,
      })
    ).rejects.toThrowError(/Bilal Test/);

    const posted = await review.postApprovedTransaction(draft.id, treasurer, {
      method: 'cheque',
      payoutReferences: ['CHQ-001', 'CHQ-002'],
      bankAccountId,
    });
    expect(posted.status).toBe('posted');
    expect(posted.amount).toBe('38000.00');
    expect(posted.methodReference).toBe('CHQ-001; CHQ-002');
    expect(posted.payouts).toEqual([
      {
        name: 'Yusuf Test',
        nic: 'Y1234567890123',
        relation: 'Nominee',
        accounts: ['AB0001', 'AB0001'],
        amount: '35000.00',
        methodReference: 'CHQ-001',
      },
      {
        name: 'Bilal Test',
        nic: 'B1234567890123',
        relation: 'Nominee',
        accounts: ['HSA0001'],
        amount: '3000.00',
        methodReference: 'CHQ-002',
      },
    ]);
  });
});
