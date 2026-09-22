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

// FRD 9's rule, proved (S-1801): on a fresh database every Phase 2 setting
// reads as something, and nothing an officer needs is left for an
// administrator to author. And the list that shows it (S-1802): what each
// stands at, and who changed it since it was seeded.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `readiness_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'readiness.test'; ${sql}; commit;`
  );

let openPool: typeof import('../db/pool') | null = null;

async function load() {
  if (openPool) await openPool.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    readiness: await import('./readiness'),
    config: await import('./reference'),
    retention: await import('../retention/policy'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let actor: { userId: string; email: string };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator') returning id`
  );
  actor = { userId: user.rows[0].id, email: 'admin@albarakah.mu' };
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

const find = (
  items: import('./readiness').ReadinessItem[],
  group: string,
  label: string
) => items.find(i => i.group === group && i.label === label)!;

describe('every Phase 2 setting has a working default (S-1801)', () => {
  it('reads nothing as missing on a fresh database, and everything as still at default', async () => {
    const { readiness } = await load();
    const items = await readiness.readiness();
    expect(items.filter(i => i.state === 'missing')).toEqual([]);
    expect(items.every(i => i.state === 'default')).toBe(true);
    expect(items.every(i => i.changedAt === null && i.changedBy === null)).toBe(
      true
    );
    const summary = readiness.summarise(items);
    expect(summary).toEqual({
      total: items.length,
      changed: 0,
      atDefault: items.length,
      missing: 0,
    });
    // The groups FRD 9 names, each with something in it.
    expect([...new Set(items.map(i => i.group))]).toEqual([
      'Amounts',
      'Approval matrix',
      'Approval chains',
      'Account types',
      'Payment methods',
      'Notification wording',
      'Retention',
      'Member app',
    ]);
  });

  it('shows each seeded value in words', async () => {
    const { readiness } = await load();
    const items = await readiness.readiness();
    expect(find(items, 'Amounts', 'Cash maximum').value).toBe('Rs 500,000.00');
    expect(find(items, 'Amounts', 'Source of Fund threshold').value).toBe(
      'Rs 45,000.00'
    );
    expect(find(items, 'Amounts', 'Takaful benefit').value).toBe(
      'Rs 15,000.00'
    );
    expect(find(items, 'Amounts', 'Near-floor notice margin').value).toBe(
      'Rs 500.00'
    );
    expect(
      find(items, 'Amounts', 'Resignation check: pending transactions').value
    ).toBe('On');
    expect(find(items, 'Amounts', 'Resignation check: financing').value).toBe(
      'Off'
    );
    // The checklist is the Society's own list (0063), not 0062's placeholder.
    const checklist = find(items, 'Amounts', 'Source of Fund checklist');
    expect(checklist.value).toBe('4 items');
    expect(checklist.note).toBeNull();

    expect(find(items, 'Approval matrix', 'Deposit').value).toBe(
      'Rs 0.00 to Rs 100,000.00: posts at once · Rs 100,000.01 and above: Deposit approval'
    );
    expect(find(items, 'Approval matrix', 'Resignation').value).toBe(
      'Rs 0.00 and above: Resignation approval'
    );
    expect(find(items, 'Approval chains', 'Withdrawal approval').value).toBe(
      'Secretary review (Secretary) → President decision (President / Chairperson)'
    );
    expect(find(items, 'Account types', 'Shares').value).toBe(
      'Floor Rs 5,000.00 · no cap · deposits, withdrawals, transfers'
    );
    expect(find(items, 'Payment methods', 'Offered on a form').value).toContain(
      'Cash'
    );
    expect(find(items, 'Notification wording', 'Receipt').value).toBe(
      '1 of 1 event · WhatsApp and email'
    );
    expect(
      find(items, 'Notification wording', "A member's transactions").value
    ).toBe('7 of 7 events · WhatsApp and email');
    expect(find(items, 'Notification wording', 'Staff').value).toBe(
      '3 of 3 events · email'
    );
    expect(find(items, 'Retention', 'Notification log').value).toBe(
      'Kept indefinitely'
    );
    expect(items.every(i => i.href.startsWith('/admin/configuration/'))).toBe(
      true
    );
  });
});

describe('the readiness list says who changed what (S-1802)', () => {
  it('marks a plain value changed once a person sets it, naming them', async () => {
    const { readiness, config } = await load();
    await config.setCashMaximum('750000', actor);
    const item = find(await readiness.readiness(), 'Amounts', 'Cash maximum');
    expect(item.state).toBe('changed');
    expect(item.value).toBe('Rs 750,000.00');
    expect(item.changedBy).toBe('Administrator');
    expect(item.changedAt).toBeInstanceOf(Date);
    // Only the one that was touched.
    const rest = (await readiness.readiness()).filter(
      i => i.group === 'Amounts' && i.label !== 'Cash maximum'
    );
    expect(rest.every(i => i.state === 'default')).toBe(true);
  });

  it('reads the configuration tables’ own trail for the matrix, a chain and a period', async () => {
    const { config, retention } = await load();
    const rule = (await config.listApprovalRules()).find(
      r => r.kind === 'withdrawal' && r.amountTo !== null
    )!;
    await config.updateApprovalRule(
      rule.id,
      {
        kind: 'withdrawal',
        accountTypeId: null,
        initiatingRoleId: null,
        amountFrom: '0',
        amountTo: '50000',
        workflowDefinitionId: null,
        note: rule.note,
        isActive: true,
      },
      actor
    );
    await retention.setRetentionPeriod('notification_log', 24, actor);

    const items = await (await load()).readiness.readiness();
    const withdrawal = find(items, 'Approval matrix', 'Withdrawal');
    expect(withdrawal.state).toBe('changed');
    expect(withdrawal.changedBy).toBe('Administrator');
    expect(withdrawal.value).toContain(
      'Rs 0.00 to Rs 50,000.00: posts at once'
    );
    expect(find(items, 'Approval matrix', 'Deposit').state).toBe('default');
    const log = find(items, 'Retention', 'Notification log');
    expect(log).toMatchObject({
      state: 'changed',
      value: '24 months',
      changedBy: 'Administrator',
    });
    expect(
      find(items, 'Retention', 'Applications that were not approved').state
    ).toBe('default');
  });

  it('flags what reads as nothing: wording switched off, a rule removed, a chain with no step', async () => {
    await configure(
      `update notification_template set is_active = false where event_code = 'deposit.posted';
       delete from approval_rule where kind = 'transfer';
       update workflow_step set is_enabled = false
        where definition_id = (select id from workflow_definition where code = 'transaction_closure')`
    );
    const { readiness } = await load();
    const items = await readiness.readiness();
    const member = find(
      items,
      'Notification wording',
      "A member's transactions"
    );
    expect(member.state).toBe('missing');
    expect(member.value).toBe('6 of 7 events · WhatsApp and email');
    expect(member.note).toBe('No active wording for deposit.posted.');
    const transfer = find(items, 'Approval matrix', 'Transfer');
    expect(transfer).toMatchObject({ state: 'missing', value: '—' });
    expect(transfer.note).toMatch(/most demanding chain/);
    const closure = find(items, 'Approval chains', 'Account closure approval');
    expect(closure.state).toBe('missing');
    expect(closure.note).toMatch(/No enabled step/);
    expect(readiness.summarise(items).missing).toBe(3);
  });
});
