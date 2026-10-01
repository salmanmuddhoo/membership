import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from './principal';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `audit_detail_test_${Date.now()}`;
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

// Configuration tables (record_configuration_change, migration 0010) refuse
// a write with no actor named.
async function configure(sql: string) {
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'audit-detail.test'; ${sql}; commit;`
  );
}

let openPool: typeof import('../db/pool') | null = null;

async function load() {
  if (openPool) await openPool.closePool();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    audit: await import('./audit'),
    detail: await import('./audit-detail'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function principalFor(
  userId: string,
  email: string,
  roles: string[],
  permissions: string[]
): Principal {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles,
    roleNames: roles,
    permissions: new Set(permissions),
  } satisfies Principal;
}

let officer: Principal;
let memberId: string;
let msa: string;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('sub-officer', 'officer@albarakah.mu', 'Officer')
     returning id`
  );
  officer = principalFor(
    user.rows[0].id,
    'officer@albarakah.mu',
    ['officer'],
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]
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
     values ($1, 'applicant', 1, $2::jsonb)`,
    [
      application.rows[0].id,
      JSON.stringify({ name: 'Jane', surname: 'Ramtohul' }),
    ]
  );
  memberId = (
    await run(
      appUrl,
      `insert into member (application_id, membership_type_id, member_no)
       values ($1, $2, 'AB0002') returning id`,
      [application.rows[0].id, membershipTypeId]
    )
  ).rows[0].id;

  const msaTypeId = (
    await run(appUrl, `select id from account_type where code = 'msa'`)
  ).rows[0].id;
  msa = (
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       values ($1, $2, true, 'active') returning id`,
      [memberId, msaTypeId]
    )
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('describeAuditDetail: transactions', () => {
  it('describes a disbursed withdrawal with amount, kind, account, holder and receipt, never "posted"', async () => {
    const { audit, detail, deposits, withdrawals } = await load();

    // Money to draw on.
    await deposits.recordDeposit(
      { accountId: msa, amount: '5000', method: 'cash' },
      officer
    );
    const withdrawal = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '1500', method: 'cash', reason: 'Fees' },
      officer
    );
    expect(withdrawal.status).toBe('posted');

    const { events } = await audit.listAuditEvents({
      entityType: 'transaction',
      entityId: withdrawal.reference,
      action: 'transaction.posted',
    });
    expect(events).toHaveLength(1);

    const details = await detail.describeAuditDetail(events);
    const described = details.get(events[0].id);
    expect(described).toBeDefined();

    const sentence = described!.sentence;
    expect(sentence).toContain('MUR 1,500.00');
    expect(sentence).toContain('withdrawal');
    // Shares and the MSA are numbered under the member's own number
    // (lookup.ts), not their own — AB0002, not an MSA-prefixed one.
    expect(sentence).toContain('AB0002');
    expect(sentence).toContain('Multiplier Savings Account');
    expect(sentence).toContain('Jane Ramtohul');
    expect(sentence).toContain(withdrawal.receiptNo);
    expect(sentence.toLowerCase()).not.toContain('posted');

    const factLabels = described!.facts.map(f => f.label);
    expect(factLabels).toEqual(
      expect.arrayContaining(['Kind', 'Amount', 'Status', 'Account', 'Receipt'])
    );
  });
});

describe('describeAuditDetail: applications', () => {
  it('describes an application status change with previous and new status', async () => {
    const { audit, detail } = await load();

    const membershipTypeId = (
      await run(
        appUrl,
        `select id from membership_type where code = 'individual'`
      )
    ).rows[0].id;
    const application = await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status, application_kind)
       values ($1, $2, 'submitted_for_review', 'membership')
       returning id, reference`,
      [membershipTypeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [
        application.rows[0].id,
        JSON.stringify({ name: 'Ravi', surname: 'Sookun' }),
      ]
    );

    await audit.recordAudit({
      actorUserId: officer.userId,
      actorDescription: officer.email,
      action: 'membership.application.reviewed',
      entityType: 'membership_application',
      entityId: application.rows[0].id,
      previousValue: { status: 'new' },
      newValue: { status: 'submitted_for_review', outcome: 'forward' },
    });

    const { events } = await audit.listAuditEvents({
      entityType: 'membership_application',
      entityId: application.rows[0].id,
    });
    expect(events).toHaveLength(1);

    const details = await detail.describeAuditDetail(events);
    const described = details.get(events[0].id)!;

    expect(described.sentence).toContain('Ravi Sookun');
    expect(described.sentence).toContain(application.rows[0].reference);
    expect(described.sentence).toContain('New');
    expect(described.sentence).toContain('With the Secretary');

    const statusFact = described.facts.find(f => f.label === 'Status');
    expect(statusFact?.value).toBe('New → With the Secretary');
  });
});

describe('describeAuditDetail: configuration changes', () => {
  it('shows only the keys that actually changed, humanised', async () => {
    const { audit, detail } = await load();

    await configure(
      `insert into payment_method (code, name, is_cash, sort_order)
       values ('audit_detail_test', 'Test method', false, 500)`
    );
    const methodId = (
      await run(
        appUrl,
        `select id::text as id from payment_method where code = 'audit_detail_test'`
      )
    ).rows[0].id;
    await configure(
      `update payment_method set name = 'Renamed test method'
        where code = 'audit_detail_test'`
    );

    const { events } = await audit.listAuditEvents({
      entityType: 'payment_method',
      entityId: methodId,
      action: 'config.payment_method.update',
    });
    expect(events).toHaveLength(1);

    const details = await detail.describeAuditDetail(events);
    const described = details.get(events[0].id)!;

    expect(described.sentence).toContain('Payment Method');
    const labels = described.facts.map(f => f.label);
    expect(labels).toContain('Name');
    // is_cash and sort_order did not change, and must not show up as noise.
    expect(labels).not.toContain('Is Cash');
    expect(labels).not.toContain('Sort Order');
    const nameFact = described.facts.find(f => f.label === 'Name');
    expect(nameFact?.value).toBe('Test method → Renamed test method');
  });
});

describe('describeAuditDetail: an unknown shape', () => {
  it('never throws, and falls back to a before/after list', async () => {
    const { audit, detail } = await load();

    await audit.recordAudit({
      actorDescription: 'audit-detail.test',
      action: 'mystery.thing_happened',
      entityType: 'mystery_entity',
      entityId: 'does-not-exist',
      previousValue: { foo: 'bar' },
      newValue: { foo: 'baz', added: 1 },
    });

    const { events } = await audit.listAuditEvents({
      entityType: 'mystery_entity',
      entityId: 'does-not-exist',
    });
    expect(events).toHaveLength(1);

    const details = await detail.describeAuditDetail(events);
    const described = details.get(events[0].id)!;
    expect(described.sentence).toBeTruthy();
    const labels = described.facts.map(f => f.label);
    expect(labels).toContain('Foo');
    expect(labels).toContain('Added');
  });
});

describe('listSignIns', () => {
  it('pairs a sign-in with its idle sign-out and reports how it ended', async () => {
    const { audit } = await load();
    const sessionId = 'sess-idle-test';

    await run(
      appUrl,
      `insert into audit_event
         (actor_user_id, actor_description, action, entity_type, entity_id,
          new_value, ip_address, occurred_at)
       values
         ($1, $2, 'auth.signed_in', 'auth_session', $3,
          $4::jsonb, '198.51.100.9', now() - interval '30 minutes'),
         ($1, $2, 'auth.timed_out', 'auth_session', $3,
          '{}'::jsonb, '198.51.100.9', now())`,
      [
        officer.userId,
        officer.email,
        sessionId,
        JSON.stringify({
          name: 'Officer',
          signedInAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        }),
      ]
    );

    const { sessions } = await audit.listSignIns({ person: 'Officer' });
    const found = sessions.find(s => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.signedInAt).not.toBeNull();
    expect(found!.endedAt).not.toBeNull();
    expect(found!.endedBy).toBe('timed_out');
    expect(found!.ipAddress).toBe('198.51.100.9');
  });

  it('shows a session with only an ending row, from before this shipped', async () => {
    const { audit } = await load();
    const sessionId = 'sess-ending-only';

    await run(
      appUrl,
      `insert into audit_event
         (actor_description, action, entity_type, entity_id, new_value)
       values ('legacy@albarakah.mu', 'auth.signed_out', 'auth_session',
               $1, '{}'::jsonb)`,
      [sessionId]
    );

    const { sessions } = await audit.listSignIns({ person: 'legacy' });
    const found = sessions.find(s => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.signedInAt).toBeNull();
    expect(found!.endedAt).not.toBeNull();
    expect(found!.endedBy).toBe('signed_out');
  });
});
