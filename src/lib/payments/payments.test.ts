// Fees, payments and receipts (M5, S-501 to S-506).
//
// Against a real database, because almost everything worth proving here is a
// property of the schema: that a number is never reused, that a recorded
// payment cannot be edited, that a rolled-back payment leaves its gap behind.
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

const dbName = `payments_test_${Date.now()}`;
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
  return {
    payments: await import('./payments'),
    receipts: await import('./receipts'),
    capture: await import('../applications/capture'),
    config: await import('../config/reference'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: { userId: string; email: string };
let treasurer: { userId: string; email: string };

const ALL = [
  'application.capture',
  'payment.view',
  'payment.record',
  'payment.refund',
  'payment.void',
  'receipt.reconcile',
];

function principalFor(
  actor: { userId: string; email: string },
  permissions: string[] = ALL
): Principal {
  return {
    userId: actor.userId,
    entraSubject: `sub-${actor.email}`,
    email: actor.email,
    displayName: actor.email,
    roles: [],
    permissions: new Set(permissions),
  };
}

// The individual schedule seeded by 0010: 1500 + 2000 + 5000 + 5000.
const FULL = {
  entrance: '1500.00',
  takaful: '2000.00',
  shares: '5000.00',
  msa_deposit: '5000.00',
} as const;
const FULL_TOTAL = '13500.00';

async function newApplication(type = 'individual') {
  const { capture } = await load();
  return capture.startApplication(type, officer);
}

// The highest receipt number allocated so far.
//
// Tests share one database and run in order, so "the last two rows" is not the
// same claim as "the two rows this test caused". Anchoring to a mark taken at
// the start says the second thing, which is the one being asserted.
async function highWaterMark(): Promise<number> {
  const result = await run(
    appUrl,
    'select coalesce(max(serial_no), 0)::int as n from receipt_number'
  );
  return result.rows[0].n;
}

/**
 * Make recordPayment fail AFTER it has taken a receipt number.
 *
 * Racing two officers looks like the natural way to do this and is not: when
 * the second call happens to run after the first has committed, it is refused
 * by the duplicate check BEFORE allocating anything — no number spent, which
 * is better behaviour but not the behaviour under test. A test that asserts a
 * stranded number would then fail on the good outcome.
 *
 * So the window is opened deliberately. The number is allocated before the
 * transaction opens (see receipts.ts), so holding the application's row lock
 * stops the call inside its transaction; deleting the application while it
 * waits makes its re-read find nothing, which is exactly the failure the catch
 * exists for. Waiting on the ledger rather than on a clock is what makes it
 * deterministic: we only delete once the number is provably taken.
 */
async function failAfterAllocation(applicationId: string) {
  const before = await highWaterMark();

  const holder = new pg.Client({ connectionString: appUrl, ssl: false });
  await holder.connect();
  await holder.query('begin');
  await holder.query(
    'select 1 from membership_application where id = $1 for no key update',
    [applicationId]
  );

  const { payments } = await load();
  const attempt = payments.recordPayment(
    { applicationId, method: 'cash', amounts: FULL },
    principalFor(officer)
  );
  // Swallowed here and re-thrown by the caller's own expectation, so an
  // unhandled rejection cannot escape while we wait below.
  const settled = attempt.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  );

  for (let waited = 0; waited < 5_000; waited += 20) {
    if ((await highWaterMark()) > before) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const allocated = await highWaterMark();
  expect(allocated).toBeGreaterThan(before);

  await holder.query(
    'delete from application_party where application_id = $1',
    [applicationId]
  );
  await holder.query('delete from membership_application where id = $1', [
    applicationId,
  ]);
  await holder.query('commit');
  await holder.end();

  return { outcome: await settled, serialNo: allocated };
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const one = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  officer = { userId: one.rows[0].id, email: 'officer@albarakah.mu' };

  const two = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('treasurer@albarakah.mu', 'Treasurer') returning id`
  );
  treasurer = { userId: two.rows[0].id, email: 'treasurer@albarakah.mu' };
}, 60_000);

afterAll(async () => {
  // Before the drop, so the last pool's connections are handed back rather
  // than terminated out from under it.
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-501: what is due comes from the schedule, not from the screen', () => {
  it('offers the components the membership type configures', async () => {
    const { payments } = await load();
    const application = await newApplication();

    const due = await payments.amountDueForApplication(application.id);

    expect(due.components.map(c => c.code)).toEqual([
      'entrance',
      'takaful',
      'shares',
      'msa_deposit',
    ]);
    expect(due.expectedTotal).toBe(FULL_TOTAL);
  });

  // 0010 ships the processing fee configured, zero and not applicable,
  // because FRD 7.8.3 describes it without confirming an amount. Until that
  // is answered it must be impossible to charge, not merely absent.
  it('leaves out a component configured not applicable, and refuses it', async () => {
    const { payments } = await load();
    const application = await newApplication();

    const due = await payments.amountDueForApplication(application.id);
    expect(due.components.map(c => c.code)).not.toContain('processing');

    await expect(
      payments.recordPayment(
        {
          applicationId: application.id,
          method: 'cash',
          amounts: { ...FULL, processing: '250.00' },
        },
        principalFor(officer)
      )
    ).rejects.toThrow(/Processing fee is not payable/);
  });

  // FRD 7.10.6: a minor pays no MSA deposit.
  it('charges a minor the schedule for minors', async () => {
    const { payments } = await load();
    const application = await newApplication('minor');

    const due = await payments.amountDueForApplication(application.id);

    expect(due.components.map(c => c.code)).not.toContain('msa_deposit');
    expect(due.expectedTotal).toBe('8500.00');
  });
});

describe('S-501: recording a payment', () => {
  it('itemises it against the version in force and issues a receipt', async () => {
    const { payments } = await load();
    const application = await newApplication();

    const payment = await payments.recordPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: FULL,
      },
      principalFor(officer)
    );

    expect(payment.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(payment.totalAmount).toBe(FULL_TOTAL);
    expect(payment.lines.map(l => [l.componentCode, l.amount])).toEqual([
      ['entrance', '1500.00'],
      ['takaful', '2000.00'],
      ['shares', '5000.00'],
      ['msa_deposit', '5000.00'],
    ]);
    // Every line carries what the schedule said, so the receipt can be read
    // against it without the schedule being consulted again.
    expect(payment.lines.every(l => l.scheduledAmount !== null)).toBe(true);
    expect(payment.recordedByEmail).toBe(officer.email);
  });

  it('records which fee version was charged, so a later change cannot reach it', async () => {
    const { payments, config } = await load();
    const application = await newApplication();

    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    const schedules = await config.listFeeSchedules();
    const individual = schedules.find(s => s.code === 'individual_membership')!;
    await config.publishFeeVersion(
      individual.id,
      [
        { code: 'entrance', amount: '9999.00', requirement: 'required' },
        { code: 'takaful', amount: '2000.00', requirement: 'required' },
        { code: 'shares', amount: '5000.00', requirement: 'required' },
        { code: 'msa_deposit', amount: '5000.00', requirement: 'required' },
      ],
      treasurer
    );

    const charged = await payments.feeVersionFor(payment);
    expect(charged!.components.find(c => c.code === 'entrance')!.amount).toBe(
      '1500.00'
    );

    const after = await payments.loadPayment(payment.id);
    expect(
      after!.lines.find(l => l.componentCode === 'entrance')!.scheduledAmount
    ).toBe('1500.00');

    // Put the schedule back. Fee versions are shared configuration, so a test
    // that leaves one raised charges every test after it.
    await config.publishFeeVersion(
      individual.id,
      [
        { code: 'entrance', amount: '1500.00', requirement: 'required' },
        { code: 'takaful', amount: '2000.00', requirement: 'required' },
        { code: 'shares', amount: '5000.00', requirement: 'required' },
        { code: 'msa_deposit', amount: '5000.00', requirement: 'required' },
      ],
      treasurer
    );
  });

  it('refuses a shortfall until someone says why, then records what they said', async () => {
    const { payments } = await load();
    const application = await newApplication();

    await expect(
      payments.recordPayment(
        {
          applicationId: application.id,
          method: 'cash',
          amounts: { ...FULL, shares: '4000.00' },
        },
        principalFor(officer)
      )
    ).rejects.toThrow(/1000.00 less than the 13500.00 due/);

    const payment = await payments.recordPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { ...FULL, shares: '4000.00' },
        varianceReason: 'Balance to follow next week.',
      },
      principalFor(officer)
    );
    expect(payment.totalAmount).toBe('12500.00');
    expect(payment.varianceReason).toBe('Balance to follow next week.');
  });

  it('will not take a second receipt for the same application', async () => {
    const { payments } = await load();
    const application = await newApplication();

    const first = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await expect(
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(officer)
      )
    ).rejects.toThrow(new RegExp(`already receipted as ${first.receiptNo}`));
  });

  it('refuses someone without the permission', async () => {
    const { payments } = await load();
    const application = await newApplication();

    await expect(
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(officer, ['application.capture'])
      )
    ).rejects.toThrow(/do not have permission to record payments/);
  });
});

describe('S-502: the receipt sequence is evidence', () => {
  it('never reuses a number, and never issues one twice', async () => {
    const { payments } = await load();

    const issued: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const application = await newApplication();
      const payment = await payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(officer)
      );
      issued.push(payment.receiptNo);
    }

    expect(new Set(issued).size).toBe(issued.length);

    const clash = await run(
      appUrl,
      `select count(*) - count(distinct receipt_no) as duplicates
         from receipt_number`
    );
    expect(clash.rows[0].duplicates).toBe('0');
  });

  // The property the whole allocation design exists for. A payment that fails
  // must not consume a number invisibly: the number is spent — it can never
  // come back — and WHY it was spent is on the record.
  it('leaves a failed payment behind as a visible, explained gap', async () => {
    const { receipts } = await load();
    const application = await newApplication();

    const { outcome, serialNo } = await failAfterAllocation(application.id);

    expect(outcome.ok).toBe(false);

    const ledger = await run(
      appUrl,
      `select state, coalesce(reason, '') as reason
         from receipt_number where serial_no = $1`,
      [serialNo]
    );
    expect(ledger.rows[0].state).toBe('abandoned');
    // Not merely marked: the reason is what an auditor asks for.
    expect(ledger.rows[0].reason).not.toBe('');

    // And it is reportable as a gap, carrying that reason.
    const period = await receipts.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    const gap = period.exceptions.find(
      e => e.kind === 'unissued' && e.serialNo === serialNo
    );
    expect(gap).toBeDefined();
    expect(gap!.reason).not.toBe('');
  });

  // The number is gone for good. The next receipt is the next number, and the
  // sequence carries the hole rather than closing over it.
  it('never hands a spent number to the next payment', async () => {
    const { payments } = await load();
    const abandonedApplication = await newApplication();
    const { serialNo } = await failAfterAllocation(abandonedApplication.id);

    const next = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: next.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    expect(payment.serialNo).toBeGreaterThan(serialNo);
  });

  // Two officers receipting the same application at once. Which of them is
  // refused, and whether the loser had taken a number first, depends on
  // timing — but exactly one receipt exists either way, and that is the
  // guarantee.
  it('lets only one of two simultaneous officers receipt an application', async () => {
    const { payments } = await load();
    const application = await newApplication();

    const both = await Promise.allSettled([
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(officer)
      ),
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(treasurer)
      ),
    ]);

    expect(both.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.filter(r => r.status === 'rejected')).toHaveLength(1);

    const live = await run(
      appUrl,
      `select count(*)::int as n from payment
        where application_id = $1 and kind = 'payment' and voided_at is null`,
      [application.id]
    );
    expect(live.rows[0].n).toBe(1);
  });

  it('refuses to delete a number, or to renumber one', async () => {
    await load();
    await expect(
      run(appUrl, 'delete from receipt_number where serial_no = 1')
    ).rejects.toThrow(/ledger|permission denied/);

    await expect(
      run(
        appUrl,
        'update receipt_number set serial_no = 9999 where serial_no = 1'
      )
    ).rejects.toThrow(/cannot be changed once allocated/);
  });
});

describe('a recorded payment is a record, not a row', () => {
  it('refuses an edit, and refuses a delete', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await expect(
      run(appUrl, 'update payment set total_amount = 1 where id = $1', [
        payment.id,
      ])
    ).rejects.toThrow(/cannot be edited/);

    await expect(
      run(appUrl, 'delete from payment where id = $1', [payment.id])
    ).rejects.toThrow(/append-only|permission denied/);

    await expect(
      run(appUrl, 'update payment_line set amount = 1 where payment_id = $1', [
        payment.id,
      ])
    ).rejects.toThrow(/append-only|permission denied/);
  });
});

describe('S-504: a structured event per payment', () => {
  it('emits one with the fee version, the components and the receipt', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cheque', amounts: FULL },
      principalFor(officer)
    );

    const events = await payments.financialEventsSince(0, 500);
    const mine = events.find(e => e.paymentId === payment.id)!;

    expect(mine.eventType).toBe('payment.recorded');
    expect(mine.receiptNo).toBe(payment.receiptNo);
    expect(mine.payload.feeVersionId).toBe(payment.feeVersionId);
    expect(mine.payload.totalAmount).toBe(FULL_TOTAL);
    expect((mine.payload.components as unknown[]).length).toBe(4);
  });

  it('is append-only', async () => {
    await load();
    await expect(
      run(appUrl, `update financial_event set payload = '{}'::jsonb`)
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(run(appUrl, 'delete from financial_event')).rejects.toThrow(
      /append-only|permission denied/
    );
  });
});

describe('S-505: refunding', () => {
  it('returns money against the original receipt and compensates it', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    const refund = await payments.refundPayment(
      {
        paymentId: payment.id,
        method: 'cash',
        reason: 'Application withdrawn.',
        amounts: { shares: '5000.00', msa_deposit: '5000.00' },
      },
      principalFor(treasurer)
    );

    expect(refund.kind).toBe('refund');
    expect(refund.refundsReceiptNo).toBe(payment.receiptNo);
    expect(refund.totalAmount).toBe('10000.00');
    expect(refund.receiptNo).not.toBe(payment.receiptNo);

    // The original is untouched.
    const original = await payments.loadPayment(payment.id);
    expect(original!.totalAmount).toBe(FULL_TOTAL);
    expect(original!.voidedAt).toBeNull();

    const events = await payments.financialEventsSince(0, 500);
    expect(events.find(e => e.paymentId === refund.id)!.eventType).toBe(
      'payment.refunded'
    );
  });

  it('itemises a partial refund and will not go past what was paid', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await payments.refundPayment(
      {
        paymentId: payment.id,
        method: 'cash',
        reason: 'Partial.',
        amounts: { shares: '2000.00' },
      },
      principalFor(treasurer)
    );

    const remaining = await payments.refundableComponents(payment.id);
    const shares = remaining.find(c => c.code === 'shares')!;
    expect(shares.alreadyRefunded).toBe('2000.00');
    expect(shares.refundable).toBe('3000.00');

    await expect(
      payments.refundPayment(
        {
          paymentId: payment.id,
          method: 'cash',
          reason: 'Too much.',
          amounts: { shares: '3000.01' },
        },
        principalFor(treasurer)
      )
    ).rejects.toThrow(/only 3000.00 of the 5000.00 paid/);
  });

  // FRD 7.10.6: the entrance fee and the Takaful contribution have been earned
  // once the membership is approved.
  it('will not return the entrance fee or Takaful once approved', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await run(
      appUrl,
      `update membership_application set status = 'approved' where id = $1`,
      [application.id]
    );

    const refundable = await payments.refundableComponents(payment.id);
    expect(refundable.find(c => c.code === 'entrance')!.refundable).toBe(
      '0.00'
    );
    expect(refundable.find(c => c.code === 'takaful')!.blockedReason).toMatch(
      /approved/
    );
    // The member's own money still comes back.
    expect(refundable.find(c => c.code === 'shares')!.refundable).toBe(
      '5000.00'
    );

    await expect(
      payments.refundPayment(
        {
          paymentId: payment.id,
          method: 'cash',
          reason: 'Trying it on.',
          amounts: { entrance: '1500.00' },
        },
        principalFor(treasurer)
      )
    ).rejects.toThrow(/Not refundable once the membership has been approved/);
  });

  it('bars the person who took the money from returning it', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await expect(
      payments.refundPayment(
        {
          paymentId: payment.id,
          method: 'cash',
          reason: 'Mine to undo.',
          amounts: { shares: '100.00' },
        },
        principalFor(officer)
      )
    ).rejects.toThrow(/may not refund it/);

    // The Treasurer, who did not take it, can.
    const refund = await payments.refundPayment(
      {
        paymentId: payment.id,
        method: 'cash',
        reason: 'Withdrawn.',
        amounts: { shares: '100.00' },
      },
      principalFor(treasurer)
    );
    expect(refund.totalAmount).toBe('100.00');
  });
});

describe('voiding a receipt issued in error', () => {
  it('withdraws it without the number ever coming back', async () => {
    const { payments, receipts } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    const voided = await payments.voidPayment(
      payment.id,
      'Wrong applicant.',
      principalFor(treasurer)
    );
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('Wrong applicant.');

    const state = await run(
      appUrl,
      'select state, reason from receipt_number where receipt_no = $1',
      [payment.receiptNo]
    );
    expect(state.rows[0].state).toBe('void');

    // The application is free to be receipted again — under a NEW number.
    const replacement = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );
    expect(replacement.receiptNo).not.toBe(payment.receiptNo);

    const period = await receipts.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    expect(
      period.exceptions.some(
        e => e.kind === 'void' && e.receiptNo === payment.receiptNo
      )
    ).toBe(true);
  });

  it('bars the person who recorded it, and refuses a refunded receipt', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await expect(
      payments.voidPayment(payment.id, 'Mine.', principalFor(officer))
    ).rejects.toThrow(/may not void it/);

    await payments.refundPayment(
      {
        paymentId: payment.id,
        method: 'cash',
        reason: 'Some back.',
        amounts: { shares: '10.00' },
      },
      principalFor(treasurer)
    );

    await expect(
      payments.voidPayment(payment.id, 'Now void it.', principalFor(treasurer))
    ).rejects.toThrow(/has been refunded/);
  });
});

describe('S-506: reconciliation', () => {
  it('says so explicitly when a period holds nothing', async () => {
    const { receipts } = await load();
    const long_ago = new Date('2020-01-01T00:00:00Z');

    const period = await receipts.reconcileReceipts(
      long_ago,
      new Date('2020-02-01T00:00:00Z')
    );

    expect(period.issuedCount).toBe(0);
    expect(period.exceptions).toEqual([]);
    expect(period.firstSerial).toBeNull();
  });

  it('totals the issued receipts net of refunds', async () => {
    const { payments, receipts } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    const before = await receipts.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );

    await payments.refundPayment(
      {
        paymentId: payment.id,
        method: 'cash',
        reason: 'Back out.',
        amounts: { shares: '1000.00' },
      },
      principalFor(treasurer)
    );

    const after = await receipts.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );

    expect(after.issuedCount).toBe(before.issuedCount + 1);
    expect(Number(after.issuedTotal)).toBe(Number(before.issuedTotal) - 1000);
  });
});

describe('a draft with a receipt against it', () => {
  // Deleting an abandoned draft is for a draft nobody has acted on. Taking
  // payment is acting on it: the applicant is holding a receipt that names
  // this application, and voiding the receipt does not unsay that.
  it('cannot be deleted, voided receipt or not', async () => {
    const { payments, capture } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    const refused = new RegExp(`Receipt ${payment.receiptNo} was issued`);

    await expect(
      capture.deleteDraftApplication(
        application.id,
        principalFor(officer),
        async () => {}
      )
    ).rejects.toThrow(refused);

    await payments.voidPayment(
      payment.id,
      'Wrong one.',
      principalFor(treasurer)
    );

    await expect(
      capture.deleteDraftApplication(
        application.id,
        principalFor(officer),
        async () => {}
      )
    ).rejects.toThrow(refused);

    // A draft that was never receipted still deletes.
    const untouched = await newApplication();
    const deleted = await capture.deleteDraftApplication(
      untouched.id,
      principalFor(officer),
      async () => {}
    );
    expect(deleted.reference).toBe(untouched.reference);
  });
});

describe('S-503: a reprint is identifiably a reprint', () => {
  // Opening a receipt to read it is not a reprint. Only an actual print is
  // recorded, so the stamp still means something after a week of people
  // looking things up.
  it('marks the second print and not the first', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    expect((await payments.printHistoryFor(payment.id)).count).toBe(0);

    await payments.recordReceiptPrint(payment.id, principalFor(officer));

    const after = await payments.printHistoryFor(payment.id);
    expect(after.count).toBe(1);
    expect(after.firstPrintedByName).toBe('Officer');
    expect(after.firstPrintedAt).not.toBeNull();

    await payments.recordReceiptPrint(payment.id, principalFor(treasurer));
    const twice = await payments.printHistoryFor(payment.id);
    expect(twice.count).toBe(2);
    // The first print is still the first: a later one does not overwrite it.
    expect(twice.firstPrintedByName).toBe('Officer');
  });

  it('refuses someone who may not see receipts, and is append-only', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    await expect(
      payments.recordReceiptPrint(payment.id, principalFor(officer, []))
    ).rejects.toThrow(/do not have permission to view receipts/);

    await payments.recordReceiptPrint(payment.id, principalFor(officer));
    await expect(
      run(appUrl, 'delete from receipt_print where payment_id = $1', [
        payment.id,
      ])
    ).rejects.toThrow(/append-only|permission denied/);
  });
});

describe('an application that has been decided', () => {
  // The page hides the form, but a hidden form is still a form that posts.
  it.each([
    ['approved', /Record the payment against the member instead/],
    ['rejected', /no receipt can be issued against it/],
  ])('refuses a receipt once it is %s', async (status, message) => {
    const { payments } = await load();
    const application = await newApplication();
    await run(
      appUrl,
      'update membership_application set status = $2 where id = $1',
      [application.id, status]
    );

    await expect(
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        principalFor(officer)
      )
    ).rejects.toThrow(message);
  });
});

describe('what a member has paid', () => {
  // The receipt that admitted someone names their APPLICATION — they were not
  // a member when it was taken. A query on member_id alone therefore finds
  // nothing for almost every member, which is precisely the receipt a
  // Treasurer looking one up wants.
  it('finds the receipt that admitted them, not just later ones', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const admitted = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );

    // Approved, so the member exists and points back at the application. Done
    // directly: what is under test is the lookup, not the approval chain.
    await run(
      appUrl,
      `update membership_application set status = 'approved' where id = $1`,
      [application.id]
    );
    const member = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       select $1, membership_type_id from membership_application where id = $1
       returning id`,
      [application.id]
    );
    const memberId = member.rows[0].id;

    const found = await payments.paymentsForMember(memberId);
    expect(found.map(p => p.receiptNo)).toEqual([admitted.receiptNo]);

    // A refund against it belongs to the member too, so the page shows the
    // money that went back beside the money that came in.
    const refund = await payments.refundPayment(
      {
        paymentId: admitted.id,
        method: 'cash',
        reason: 'Shares returned.',
        amounts: { shares: '500.00' },
      },
      principalFor(treasurer)
    );

    const both = await payments.paymentsForMember(memberId);
    expect(both.map(p => p.receiptNo)).toEqual([
      admitted.receiptNo,
      refund.receiptNo,
    ]);
  });

  it('returns nothing for a member who has paid nothing', async () => {
    const { payments } = await load();
    const application = await newApplication();
    const member = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       select $1, membership_type_id from membership_application where id = $1
       returning id`,
      [application.id]
    );

    expect(await payments.paymentsForMember(member.rows[0].id)).toEqual([]);
  });
});

describe('S-506: an exception leads back to its receipt', () => {
  // "An anomaly is found by the system rather than by an auditor" is only half
  // the job if the Treasurer then has to hunt for the receipt by hand.
  it('carries the payment behind a void, and nothing behind an abandonment', async () => {
    const { payments, receipts } = await load();
    const application = await newApplication();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      principalFor(officer)
    );
    await payments.voidPayment(
      payment.id,
      'Wrong applicant.',
      principalFor(treasurer)
    );

    // An allocation that never became a payment.
    const contested = await newApplication();
    const { serialNo } = await failAfterAllocation(contested.id);

    const period = await receipts.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );

    const voided = period.exceptions.find(
      e => e.kind === 'void' && e.receiptNo === payment.receiptNo
    )!;
    expect(voided.paymentId).toBe(payment.id);

    // An abandoned number never became a receipt, so there is nothing to open.
    const abandoned = period.exceptions.find(
      e => e.kind === 'unissued' && e.serialNo === serialNo
    );
    expect(abandoned).toBeDefined();
    expect(abandoned!.paymentId).toBeNull();
  });
});
