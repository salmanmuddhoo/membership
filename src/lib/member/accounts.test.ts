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
import type { MemberPrincipal } from './identity';

// A member's own balance, history and statement (S-2101): the member app
// reads them through the same payloads the staff endpoints return, and the
// only question the member endpoints add is whether the account is the
// caller's own.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_accounts_test_${Date.now()}`;
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

let openPool: typeof import('../db/pool') | null = null;

async function load() {
  if (openPool) await openPool.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  return {
    profile: await import('./profile'),
    payloads: await import('../ledger/api-payloads'),
    ledger: await import('../ledger/ledger'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let fatimah: MemberPrincipal;
let stranger: MemberPrincipal;
let applicant: MemberPrincipal;
let fatimahMsa: string;
let strangerMsa: string;

function memberPrincipal(memberId: string | null, mobile: string) {
  return {
    sessionId: `session-${mobile}`,
    mobile,
    memberId,
    customerId: null,
    kind: memberId ? 'member' : 'applicant',
  } as MemberPrincipal;
}

async function memberWithMsa(memberNo: string, name: string) {
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
    [application.rows[0].id, JSON.stringify({ name, surname: 'Test' })]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [memberNo, application.rows[0].id, type.rows[0].id]
  );
  const account = await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default, status)
     select $1, id, true, 'active' from account_type where code = 'msa'
     returning id`,
    [member.rows[0].id]
  );
  return { memberId: member.rows[0].id, msa: account.rows[0].id };
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
  officer = {
    userId: user.rows[0].id,
    entraSubject: 'test-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: ['account_officer'],
    roleNames: ['Account Officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.view',
    ]),
  };

  const first = await memberWithMsa('AB0001', 'Fatimah');
  const second = await memberWithMsa('AB0002', 'Yusuf');
  fatimahMsa = first.msa;
  strangerMsa = second.msa;
  fatimah = memberPrincipal(first.memberId, '+23057891234');
  stranger = memberPrincipal(second.memberId, '+23057895678');
  applicant = memberPrincipal(null, '+23057890000');

  // Something on the ledger to read: two deposits and a withdrawal, all
  // cash, all posted at once.
  const { deposits, withdrawals } = await load();
  await deposits.recordDeposit(
    { accountId: fatimahMsa, amount: '1000', method: 'cash' },
    officer
  );
  await deposits.recordDeposit(
    { accountId: fatimahMsa, amount: '500', method: 'cash' },
    officer
  );
  await withdrawals.recordWithdrawal(
    { accountId: fatimahMsa, amount: '300', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe("a member's own accounts (S-2101)", () => {
  it('answers only for an account the caller holds, and says nothing else', async () => {
    const { profile } = await load();
    expect(await profile.ownedAccountId(fatimah, fatimahMsa)).toBe(fatimahMsa);
    // Another member's account, no such account, not even an id, and a
    // caller who is not a member yet: the same not_found every time.
    for (const [who, id] of [
      [fatimah, strangerMsa],
      [fatimah, '00000000-0000-0000-0000-000000000000'],
      [fatimah, 'not-an-id'],
      [applicant, fatimahMsa],
    ] as const) {
      await expect(profile.ownedAccountId(who, id)).rejects.toMatchObject({
        code: 'not_found',
        message: 'No such account.',
      });
    }
    // The older transactions list refuses the same way.
    await expect(
      profile.accountTransactions(stranger, fatimahMsa)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads the balance the branch reads', async () => {
    const { profile, payloads } = await load();
    const id = await profile.ownedAccountId(fatimah, fatimahMsa);
    const balance = await payloads.balancePayload(id);
    expect(balance).toMatchObject({
      accountId: fatimahMsa,
      accountNo: 'AB0001',
      accountTypeName: 'Multiplier Savings Account',
      status: 'active',
      balance: '1200.00',
      pendingDebits: '0.00',
      available: '1200.00',
      currency: 'MUR',
      entryCount: 3,
    });
    expect(balance!.asOfSequenceNo).toBeGreaterThan(0);
    expect(balance!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      await payloads.balancePayload('00000000-0000-0000-0000-000000000000')
    ).toBeNull();
  });

  it('pages the history newest first, as the branch does', async () => {
    const { payloads } = await load();
    const first = await payloads.historyPayload(
      fatimahMsa,
      new URLSearchParams('limit=2')
    );
    expect(
      first.entries.map(e => [e.direction, e.amount, e.runningBalance])
    ).toEqual([
      ['debit', '300.00', '1200.00'],
      ['credit', '500.00', '1500.00'],
    ]);
    expect(first.entries[0].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.entries[0].description).toBe('Withdrawal');
    expect(first.nextBefore).toBe(first.entries[1].sequenceNo);

    const rest = await payloads.historyPayload(
      fatimahMsa,
      new URLSearchParams(`limit=2&before=${first.nextBefore}`)
    );
    expect(
      rest.entries.map(e => [e.direction, e.amount, e.runningBalance])
    ).toEqual([['credit', '1000.00', '1000.00']]);
    expect(rest.nextBefore).toBeNull();

    // Nonsense paging reads as the defaults, never as a refusal.
    const all = await payloads.historyPayload(
      fatimahMsa,
      new URLSearchParams('limit=lots&before=yesterday')
    );
    expect(all.entries).toHaveLength(3);
    expect(all.nextBefore).toBeNull();
  });

  it('gives the statement for a period, and refuses a period that is not one', async () => {
    const { ledger, payloads } = await load();
    const today = new Date().toISOString().slice(0, 10);
    const period = payloads.statementPeriodOrFail(
      new URLSearchParams(`from=${today}&to=${today}`)
    );
    expect(period).toEqual({ from: today, to: today });
    const statement = payloads.statementPayload(
      (await ledger.accountStatement(fatimahMsa, period.from, period.to))!
    );
    expect(statement).toMatchObject({
      accountNo: 'AB0001',
      holderName: 'Fatimah Test',
      memberNo: 'AB0001',
      openingBalance: '0.00',
      closingBalance: '1200.00',
      totalCredits: '1500.00',
      totalDebits: '300.00',
    });
    expect(statement.lines.map(l => [l.credit, l.debit, l.balance])).toEqual([
      ['1000.00', null, '1000.00'],
      ['500.00', null, '1500.00'],
      [null, '300.00', '1200.00'],
    ]);
    expect(statement.lines[0].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(() =>
      payloads.statementPeriodOrFail(new URLSearchParams('from=yesterday'))
    ).toThrowError(
      expect.objectContaining({
        code: 'validation_failed',
        details: { period: [expect.stringContaining('YYYY-MM-DD')] },
      })
    );
    // With no period at all: the month to date.
    const month = payloads.statementPeriodOrFail(new URLSearchParams());
    expect(month.from).toBe(`${today.slice(0, 7)}-01`);
    expect(month.to).toBe(today);

    // The download carries the spreadsheet, named for the account and the
    // period, and nothing cacheable.
    const download = await payloads.statementDownload(
      (await ledger.accountStatement(fatimahMsa, period.from, period.to))!,
      fatimah.mobile
    );
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="statement-AB0001-${today}-${today}.xlsx"`
    );
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
});
