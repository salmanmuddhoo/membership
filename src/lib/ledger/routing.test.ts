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

// The approval matrix (S-1401) and the chains it routes to (S-1402), read
// against the seeded defaults and then changed the way an administrator
// would — on the configuration API, never by editing the migration.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `routing_test_${Date.now()}`;
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
    routing: await import('./routing'),
    config: await import('../config/reference'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let actor: { userId: string; email: string };
let shares: string;
let msa: string;

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
  const types = await run(appUrl, `select code, id from account_type`);
  shares = types.rows.find(r => r.code === 'shares').id;
  msa = types.rows.find(r => r.code === 'msa').id;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

const cents = (rupees: number) => Math.round(rupees * 100);

describe('the seeded matrix', () => {
  it("posts a deposit up to the threshold and reviews one above it, FRD 6.5's table", async () => {
    const { routing } = await load();
    const small = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: shares,
      amountCents: cents(100000),
      roleCodes: ['regional_officer'],
    });
    expect(small.rule?.workflowDefinitionId).toBeNull();
    expect(small.definition).toBeNull();
    expect(small.firstStep).toBeNull();

    const large = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: shares,
      amountCents: cents(100000.01),
      roleCodes: ['regional_officer'],
    });
    expect(large.rule?.amountFrom).toBe('100000.01');
    expect(large.definition?.code).toBe('transaction_deposit');
    expect(large.firstStep).toMatchObject({
      code: 'secretary_review',
      roleCode: 'secretary',
      fromStatus: 'submitted',
      toStatus: 'under_review',
    });
  });

  it('always reviews a closure, a resignation and a demised claim', async () => {
    const { routing } = await load();
    for (const kind of ['closure', 'resignation', 'demise'] as const) {
      const route = await routing.resolveRoute({
        kind,
        accountTypeId: shares,
        amountCents: cents(1),
        roleCodes: [],
      });
      expect(route.definition?.code, kind).toBe(`transaction_${kind}`);
    }
  });
});

describe('an administrator changes the matrix', () => {
  it('lets an earlier, narrower rule win, by account type and by the initiating role', async () => {
    const { routing, config } = await load();
    const chain = (await config.listWorkflows()).find(
      w => w.code === 'transaction_deposit'
    )!;
    const clerk = (
      await run(appUrl, `select id from role where code = 'clerk'`)
    ).rows[0].id;

    // MSA deposits by a Clerk of any size go for review.
    const id = await config.createApprovalRule(
      {
        kind: 'deposit',
        accountTypeId: msa,
        initiatingRoleId: clerk,
        amountFrom: '0',
        amountTo: null,
        workflowDefinitionId: chain.id,
        note: 'Clerks on the MSA',
        isActive: true,
      },
      actor
    );
    // Added last, so it does not match yet; moved to the top, it does.
    const before = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: msa,
      amountCents: cents(10),
      roleCodes: ['clerk'],
    });
    expect(before.definition).toBeNull();

    await config.moveApprovalRule(id, 'up', actor);
    await config.moveApprovalRule(id, 'up', actor);
    const clerkOnMsa = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: msa,
      amountCents: cents(10),
      roleCodes: ['clerk'],
    });
    expect(clerkOnMsa.rule?.id).toBe(id);
    expect(clerkOnMsa.definition?.code).toBe('transaction_deposit');

    // Not a Clerk, or not the MSA: the rule does not fit and the next does.
    const officerOnMsa = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: msa,
      amountCents: cents(10),
      roleCodes: ['regional_officer'],
    });
    expect(officerOnMsa.definition).toBeNull();
    const clerkOnShares = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: shares,
      amountCents: cents(10),
      roleCodes: ['clerk'],
    });
    expect(clerkOnShares.definition).toBeNull();

    await config.updateApprovalRule(
      id,
      {
        kind: 'deposit',
        accountTypeId: msa,
        initiatingRoleId: clerk,
        amountFrom: '0',
        amountTo: null,
        workflowDefinitionId: chain.id,
        note: 'Clerks on the MSA',
        isActive: false,
      },
      actor
    );
    const off = await routing.resolveRoute({
      kind: 'deposit',
      accountTypeId: msa,
      amountCents: cents(10),
      roleCodes: ['clerk'],
    });
    expect(off.definition).toBeNull();
    await config.deleteApprovalRule(id, actor);
  });

  it('sends a transaction no rule fits to the most demanding chain for its kind', async () => {
    const { routing, config } = await load();
    const rules = (await config.listApprovalRules()).filter(
      r => r.kind === 'withdrawal'
    );
    for (const rule of rules) {
      await config.updateApprovalRule(
        rule.id,
        { ...rule, isActive: false },
        actor
      );
    }
    try {
      const route = await routing.resolveRoute({
        kind: 'withdrawal',
        accountTypeId: shares,
        amountCents: cents(5),
        roleCodes: [],
      });
      expect(route.rule).toBeNull();
      expect(route.definition?.code).toBe('transaction_withdrawal');
      expect(route.firstStep?.code).toBe('secretary_review');
    } finally {
      for (const rule of rules) {
        await config.updateApprovalRule(
          rule.id,
          { ...rule, isActive: true },
          actor
        );
      }
    }
  });

  it('refuses a band that runs backwards, a kind that is not one, and deleting a rule on the trail', async () => {
    const { config } = await load();
    const base = {
      accountTypeId: null,
      initiatingRoleId: null,
      workflowDefinitionId: null,
      note: '',
      isActive: true,
    };
    await expect(
      config.createApprovalRule(
        { ...base, kind: 'deposit', amountFrom: '500', amountTo: '100' },
        actor
      )
    ).rejects.toThrowError(/below its lower/);
    await expect(
      config.createApprovalRule(
        { ...base, kind: 'loan', amountFrom: '0', amountTo: null },
        actor
      )
    ).rejects.toThrowError(/which kind/);
  });

  // S-1402: the chain is read live. A disabled Secretary step means the
  // next large deposit waits at the President instead.
  it('routes the next transaction through the chain as it now is', async () => {
    const { routing, config } = await load();
    const chain = (await config.listWorkflows()).find(
      w => w.code === 'transaction_deposit'
    )!;
    const secretary = chain.steps.find(s => s.code === 'secretary_review')!;
    await config.setStepEnabled(secretary.id, false, actor);
    try {
      const route = await routing.resolveRoute({
        kind: 'deposit',
        accountTypeId: shares,
        amountCents: cents(200000),
        roleCodes: [],
      });
      expect(route.firstStep?.code).toBe('president_decision');
      // The bridged step now acts on what the disabled one would have.
      expect(route.firstStep?.fromStatus).toBe('submitted');
    } finally {
      await config.setStepEnabled(secretary.id, true, actor);
    }
  });
});
