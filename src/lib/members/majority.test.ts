// A minor reaching the age of majority (S-610).
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

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `majority_test_${Date.now()}`;
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

// Configuration tables refuse a write that cannot be attributed (S-210), so
// turning the majority transition on for a fixture has to say who it is.
async function runAsConfigurator(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: appUrl, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return {
    majority: await import('./majority'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officerId: string;
let minorTypeId: string;
let individualTypeId: string;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  officerId = user.rows[0].id;

  const minor = await run(
    appUrl,
    `select id from membership_type where code = 'minor'`
  );
  minorTypeId = minor.rows[0].id;
  const individual = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  individualTypeId = individual.rows[0].id;
}, 60_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

async function setMajorityTransition(age: number | null) {
  await runAsConfigurator(
    `update membership_type
        set majority_age = $2, majority_transition_type_id = $3
      where id = $1`,
    [minorTypeId, age, age === null ? null : individualTypeId]
  );
}

// A member whose applicant party carries a real date of birth — the job
// reads it the same way the capture form stores it, YYYY-MM-DD.
async function seedMinorMember(
  dateOfBirth: string,
  status: 'active' | 'inactive' = 'active'
): Promise<{ memberId: string; memberNo: string; applicationId: string }> {
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by)
     values ($1, $2) returning id`,
    [minorTypeId, officerId]
  );
  const applicationId = application.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [
      applicationId,
      JSON.stringify({
        surname: 'Ramdin',
        name: 'Zaid',
        date_of_birth: dateOfBirth,
      }),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id, status)
     values ($1, $2, $3) returning id, member_no`,
    [applicationId, minorTypeId, status]
  );
  return {
    memberId: member.rows[0].id,
    memberNo: member.rows[0].member_no,
    applicationId,
  };
}

// Every test's own fixture, gone before the next test runs — a minor left
// behind at 30 "years old" would otherwise still be there, still active,
// still eligible, the moment a later test turns the transition on.
async function discardMinorMember(seed: {
  memberId: string;
  applicationId: string;
}) {
  await run(appUrl, `delete from member where id = $1`, [seed.memberId]);
  await run(appUrl, `delete from membership_application where id = $1`, [
    seed.applicationId,
  ]);
}

// N years before `now`, as the YYYY-MM-DD the capture form would have saved.
function yearsBefore(now: Date, years: number): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

describe('S-610: a minor reaching the age of majority', () => {
  it('does nothing while no type has a transition configured', async () => {
    const { majority } = await load();
    const now = new Date('2026-01-01');
    const seed = await seedMinorMember(yearsBefore(now, 30));

    try {
      const { transitioned } = await majority.transitionMinorsAtMajority(now);
      expect(transitioned).toEqual([]);
    } finally {
      await discardMinorMember(seed);
    }
  });

  it('transitions a member once they have reached the configured age', async () => {
    const { majority } = await load();
    const now = new Date('2026-01-01');
    await setMajorityTransition(18);
    const seed = await seedMinorMember(yearsBefore(now, 20));

    try {
      const { transitioned } = await majority.transitionMinorsAtMajority(now);
      expect(transitioned).toEqual([
        {
          memberId: seed.memberId,
          memberNo: seed.memberNo,
          fromTypeCode: 'minor',
          toTypeCode: 'individual',
        },
      ]);

      const after = await run(
        appUrl,
        `select membership_type_id from member where id = $1`,
        [seed.memberId]
      );
      expect(after.rows[0].membership_type_id).toBe(individualTypeId);

      const audited = await run(
        appUrl,
        `select actor_user_id, actor_description, previous_value, new_value
           from audit_event
          where action = 'member.majority_transition' and entity_id = $1`,
        [seed.memberId]
      );
      expect(audited.rowCount).toBe(1);
      expect(audited.rows[0].actor_user_id).toBeNull();
      expect(audited.rows[0].actor_description).toMatch(/scheduled job/);
      expect(audited.rows[0].previous_value).toEqual({
        membershipType: 'minor',
      });
      expect(audited.rows[0].new_value).toEqual({
        membershipType: 'individual',
      });
    } finally {
      await discardMinorMember(seed);
      await setMajorityTransition(null);
    }
  });

  it('leaves someone under the configured age alone', async () => {
    const { majority } = await load();
    const now = new Date('2026-01-01');
    await setMajorityTransition(18);
    const seed = await seedMinorMember(yearsBefore(now, 17));

    try {
      const { transitioned } = await majority.transitionMinorsAtMajority(now);
      expect(transitioned).toEqual([]);

      const after = await run(
        appUrl,
        `select membership_type_id from member where id = $1`,
        [seed.memberId]
      );
      expect(after.rows[0].membership_type_id).toBe(minorTypeId);
    } finally {
      await discardMinorMember(seed);
      await setMajorityTransition(null);
    }
  });

  it('turns on the day they turn 18, not the day after', async () => {
    const { majority } = await load();
    const now = new Date('2026-06-15T00:00:00Z');
    await setMajorityTransition(18);
    const seed = await seedMinorMember('2008-06-15'); // 18th birthday is `now`

    try {
      const { transitioned } = await majority.transitionMinorsAtMajority(now);
      expect(transitioned).toEqual([
        {
          memberId: seed.memberId,
          memberNo: seed.memberNo,
          fromTypeCode: 'minor',
          toTypeCode: 'individual',
        },
      ]);
    } finally {
      await discardMinorMember(seed);
      await setMajorityTransition(null);
    }
  });

  it('ignores a member who is not active', async () => {
    const { majority } = await load();
    const now = new Date('2026-01-01');
    await setMajorityTransition(18);
    const seed = await seedMinorMember(yearsBefore(now, 20), 'inactive');

    try {
      const { transitioned } = await majority.transitionMinorsAtMajority(now);
      expect(transitioned).toEqual([]);

      const after = await run(
        appUrl,
        `select membership_type_id from member where id = $1`,
        [seed.memberId]
      );
      expect(after.rows[0].membership_type_id).toBe(minorTypeId);
    } finally {
      await discardMinorMember(seed);
      await setMajorityTransition(null);
    }
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const { majority } = await load();
    const now = new Date('2026-01-01');
    await setMajorityTransition(18);
    const seed = await seedMinorMember(yearsBefore(now, 20));

    try {
      const first = await majority.transitionMinorsAtMajority(now);
      expect(first.transitioned).toEqual([
        {
          memberId: seed.memberId,
          memberNo: seed.memberNo,
          fromTypeCode: 'minor',
          toTypeCode: 'individual',
        },
      ]);

      const second = await majority.transitionMinorsAtMajority(now);
      expect(second.transitioned).toEqual([]);
    } finally {
      await discardMinorMember(seed);
      await setMajorityTransition(null);
    }
  });
});
