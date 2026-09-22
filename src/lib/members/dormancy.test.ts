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

// Dormancy (S-804, S-805, S-806): found by the nightly job from the
// absence of activity, undone by an officer with a reason, and shown
// approaching before it happens.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `dormancy_test_${Date.now()}`;
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
  process.env.NOTIFY_EMAIL_DELIVERY = 'log';
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  return {
    dormancy: await import('./dormancy'),
    config: await import('../config/reference'),
    reports: await import('../reports/definitions'),
    readiness: await import('../config/readiness'),
    deposits: await import('../ledger/deposits'),
    templates: await import('../notifications/event-codes'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const DAY = 24 * 60 * 60 * 1000;
const monthsAgo = (n: number) => new Date(Date.now() - n * 30.5 * DAY);

let officer: Principal;
let clerk: Principal;
const actor = { userId: '', email: 'officer@albarakah.mu' };

async function memberWithMsa(
  memberNo: string,
  name: string,
  joinedAt: Date,
  createdAt?: Date
) {
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
    [
      application.rows[0].id,
      JSON.stringify({
        name,
        surname: 'Test',
        email: `${name.toLowerCase()}@example.com`,
      }),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member
       (member_no, application_id, membership_type_id, joined_at, created_at)
     values ($1, $2, $3, $4, $5) returning id`,
    // In this system since they joined, unless told otherwise — a migrated
    // member arrives today with the old register's Joined Date.
    [
      memberNo,
      application.rows[0].id,
      type.rows[0].id,
      joinedAt,
      createdAt ?? joinedAt,
    ]
  );
  const account = await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default, status)
     select $1, id, true, 'active' from account_type where code = 'msa'
     returning id`,
    [member.rows[0].id]
  );
  return { memberId: member.rows[0].id as string, msa: account.rows[0].id };
}

let quiet: { memberId: string; msa: string }; // joined long ago, nothing since
let migrated: { memberId: string; msa: string }; // old Joined Date, arrived today
let recent: { memberId: string; msa: string }; // joined long ago, deposited lately
let fresh: { memberId: string; msa: string }; // joined two months ago

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer'),
            ('test-clerk', 'clerk@albarakah.mu', 'Clerk')
     returning id, email`
  );
  const byEmail = new Map(user.rows.map(r => [r.email, r.id]));
  officer = {
    userId: byEmail.get('officer@albarakah.mu'),
    entraSubject: 'test-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: ['account_officer'],
    roleNames: ['Account Officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'member.reactivate',
    ]),
  };
  clerk = {
    userId: byEmail.get('clerk@albarakah.mu'),
    entraSubject: 'test-clerk',
    email: 'clerk@albarakah.mu',
    displayName: 'Clerk',
    roles: ['clerk'],
    roleNames: ['Clerk'],
    permissions: new Set(['member.view']),
  };
  actor.userId = officer.userId;

  quiet = await memberWithMsa('AB0001', 'Quiet', monthsAgo(20));
  recent = await memberWithMsa('AB0002', 'Recent', monthsAgo(20));
  fresh = await memberWithMsa('AB0003', 'Fresh', monthsAgo(2));
  migrated = await memberWithMsa(
    'AB0004',
    'Migrated',
    monthsAgo(60),
    new Date()
  );

  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: recent.msa, amount: '100', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

async function statusOf(memberId: string) {
  return (
    await run(
      appUrl,
      `select status, status_changed_at from member where id = $1`,
      [memberId]
    )
  ).rows[0];
}

describe('dormancy (S-804, S-805, S-806)', () => {
  it('is configuration: twelve months by default, off at zero, and a rule for coming back', async () => {
    const { config, readiness, templates } = await load();
    expect(await config.dormancyMonths()).toBe(12);
    expect(await config.dormancyReactivation()).toBe('staff');
    await expect(
      config.setDormancyMonths('twelve', actor)
    ).rejects.toThrowError(/whole number of months/);
    await expect(
      config.setDormancyReactivation('automatic', actor)
    ).rejects.toThrowError(/not a reactivation rule/);
    const rows = (await readiness.readiness()).filter(i =>
      i.label.startsWith('Dorman')
    );
    expect(rows.map(r => [r.label, r.value, r.state])).toEqual([
      ['Dormant after', '12 months without activity', 'default'],
      ['Dormancy reactivation', 'By an officer, with a reason', 'default'],
    ]);
    expect(templates.placeholdersForEvent('member.dormant')).toEqual([
      'member_name',
      'member_no',
      'last_activity',
      'months',
    ]);
    expect(templates.placeholdersForEvent('member.reactivated')).toEqual([
      'member_name',
      'member_no',
      'reason',
    ]);
  });

  it('shows who is approaching dormancy before the job marks anyone', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('dormancy')!;
    expect(report.permission).toBe('member.view');
    // Quiet joined 20 months ago with nothing since: 8 months past the
    // threshold already. Recent deposited today; Fresh joined two months
    // ago.
    const approaching = await report.run({});
    expect(approaching.rows.map(r => [r['Member no'], r.Status])).toEqual([
      ['AB0001', 'active'],
    ]);
    expect(approaching.rows[0]).toMatchObject({
      Name: 'Quiet Test',
      'Months since': 20,
    });
    expect(approaching.summary).toBe(
      '1 active member(s) within 3 month(s) of dormancy; dormant after 12 month(s) without activity.'
    );
    // Fresh joined two months ago, so becomes dormant in ten; Recent
    // deposited today and has the full twelve.
    const wide = await report.run({ within: '11' });
    expect(wide.rows.map(r => r['Member no'])).toEqual(['AB0001', 'AB0003']);
    const everyone = await report.run({ view: 'active' });
    // Migrated arrived today, before Recent's deposit: both a full twelve.
    expect(everyone.rows.map(r => r['Member no'])).toEqual([
      'AB0001',
      'AB0003',
      'AB0004',
      'AB0002',
    ]);
    expect(await report.run({ view: 'dormant' })).toMatchObject({ rows: [] });
  });

  it('marks the quiet member dormant, dated, audited and told; nobody else', async () => {
    const { dormancy } = await load();
    const first = await dormancy.detectDormancy();
    expect(first.months).toBe(12);
    expect(first.marked.map(m => m.memberNo)).toEqual(['AB0001']);
    expect(await statusOf(quiet.memberId)).toMatchObject({
      status: 'dormant',
      status_changed_at: expect.any(Date),
    });
    expect((await statusOf(recent.memberId)).status).toBe('active');
    expect((await statusOf(fresh.memberId)).status).toBe('active');
    // Joined years ago in the old register, but only just arrived here: the
    // quiet is counted from the day the record came into this system.
    expect((await statusOf(migrated.memberId)).status).toBe('active');

    const trail = await run(
      appUrl,
      `select action, actor_user_id, actor_description,
              new_value->>'months' as months
         from audit_event where entity_type = 'member' and entity_id = $1
        order by occurred_at`,
      [quiet.memberId]
    );
    expect(trail.rows).toEqual([
      {
        action: 'member.dormancy_detected',
        actor_user_id: null,
        actor_description: 'scheduled job: dormancy detection',
        months: '12',
      },
    ]);
    const told = await run(
      appUrl,
      `select event_code, recipient from notification
        where entity_type = 'member' and entity_id = $1`,
      [quiet.memberId]
    );
    expect(told.rows).toEqual([
      { event_code: 'member.dormant', recipient: 'quiet@example.com' },
    ]);

    // A second run the same night finds nothing; off finds nothing either.
    expect((await dormancy.detectDormancy()).marked).toEqual([]);
  });

  it('comes back only by an officer with a reason, audited and told', async () => {
    const { dormancy, reports } = await load();
    await expect(
      dormancy.reactivateMember(quiet.memberId, 'Came to the branch', clerk)
    ).rejects.toThrowError(/permission/);
    await expect(
      dormancy.reactivateMember(quiet.memberId, '  ', officer)
    ).rejects.toThrowError(/Say why/);
    await expect(
      dormancy.reactivateMember(recent.memberId, 'Not dormant', officer)
    ).rejects.toThrowError(/Only a dormant member/);
    await expect(
      dormancy.reactivateMember(
        '00000000-0000-0000-0000-000000000000',
        'Nobody',
        officer
      )
    ).rejects.toThrowError(/No such member/);

    const dormantList = await reports.reportByCode('dormancy')!.run({
      view: 'dormant',
    });
    expect(
      dormantList.rows.map(r => [r['Member no'], r['Dormant on']])
    ).toEqual([['AB0001', expect.any(String)]]);

    const back = await dormancy.reactivateMember(
      quiet.memberId,
      'Came to the branch with NIC',
      officer
    );
    expect(back.memberNo).toBe('AB0001');
    expect((await statusOf(quiet.memberId)).status).toBe('active');
    const trail = await run(
      appUrl,
      `select action, actor_user_id, new_value->>'reason' as reason
         from audit_event where entity_type = 'member' and entity_id = $1
        order by occurred_at`,
      [quiet.memberId]
    );
    expect(trail.rows.map(r => [r.action, r.actor_user_id, r.reason])).toEqual([
      ['member.dormancy_detected', null, null],
      ['member.reactivated', officer.userId, 'Came to the branch with NIC'],
    ]);
    const told = await run(
      appUrl,
      `select event_code from notification
        where entity_type = 'member' and entity_id = $1 order by created_at`,
      [quiet.memberId]
    );
    expect(told.rows.map(r => r.event_code)).toEqual([
      'member.dormant',
      'member.reactivated',
    ]);
    // Reactivation is itself no activity: the next run marks them again.
    expect(
      (await dormancy.detectDormancy()).marked.map(m => m.memberNo)
    ).toEqual(['AB0001']);
  });
});
