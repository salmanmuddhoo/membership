import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';

// Against a real database: the row lock, the partial unique index that
// allows one pending request per member, and the jsonb merge that leaves
// untouched fields alone are all the database's own behaviour.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `details_requests_test_${Date.now()}`;
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

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';
process.env.MEMBER_SESSION_SECRET =
  'a-test-secret-that-is-at-least-32-characters-long';
process.env.MEMBER_OTP_DELIVERY = 'log';
process.env.RATE_LIMIT_DISABLED = 'true';

const requests = await import('./details-requests');
const profile = await import('../member/profile');
const identity = await import('../member/identity');
const pool = await import('../db/pool');

const MEMBER = {
  nic: 'B1234567890123',
  abNumber: 'AB0001',
  mobile: '+23057891234',
};
const ORIGINAL = {
  surname: 'Peerally',
  name: 'Fatimah',
  nic: MEMBER.nic,
  gender: 'Female',
  address: '12 Royal Road, Rose Hill',
  mobile: MEMBER.mobile,
  email: 'fatimah@example.mu',
};

let memberId: string;
let applicationId: string;
let secretary: Principal;
let officer: Principal;

function principalFor(
  userId: string,
  email: string,
  permissions: string[]
): Principal {
  return {
    userId,
    entraSubject: `subject-${email}`,
    email,
    displayName: email,
    roles: [],
    roleNames: [],
    permissions: new Set(permissions),
  };
}

// The member's own session, as the app would hold one.
async function memberSession() {
  // The link cooldown is per AB Number and this suite links the same member
  // in every test.
  await clearCooldown();
  const challenge = await identity.linkMember(
    { nic: MEMBER.nic, abNumber: MEMBER.abNumber },
    { ip: null, correlationId: 'test' },
    { delivery: { async send() {} } }
  );
  // The code is not readable from here; read the hash's own row instead and
  // verify through the same path by trying every code is absurd — so the
  // fixed code the test environment allows is used.
  const code = process.env.MEMBER_OTP_FIXED_CODE!;
  const session = await identity.verifyOtp(
    { challengeId: challenge.challengeId, code },
    { ip: null, correlationId: 'test' }
  );
  return (await identity.resolveMemberSession(
    `Bearer ${session.accessToken}`
  ))!;
}

async function currentValues(): Promise<Record<string, string>> {
  const result = await run(
    appUrl,
    `select values from application_party
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [applicationId]
  );
  return result.rows[0].values;
}

async function clearCooldown() {
  await run(
    appUrl,
    `update member_login_challenge set created_at = created_at - interval '1 minute'`
  );
}

beforeAll(async () => {
  process.env.MEMBER_OTP_FIXED_CODE = '123456';
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-secretary', 'secretary@test', 'Test Secretary'),
            ('test-officer', 'officer@test', 'Test Officer')
     returning id, email::text`
  );
  const byEmail = new Map<string, string>(
    users.rows.map((r: { id: string; email: string }) => [r.email, r.id])
  );
  secretary = principalFor(byEmail.get('secretary@test')!, 'secretary@test', [
    'member.view',
    'member.details_verify',
  ]);
  officer = principalFor(byEmail.get('officer@test')!, 'officer@test', [
    'member.view',
  ]);

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
  applicationId = application.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb),
            ($1, 'nominee', 1, $3::jsonb)`,
    [
      applicationId,
      JSON.stringify(ORIGINAL),
      JSON.stringify({
        surname: 'Peerally',
        name: 'Ismail',
        nic: 'P1201791234567',
        address: '12 Royal Road, Rose Hill',
      }),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [MEMBER.abNumber, applicationId, type.rows[0].id]
  );
  memberId = member.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

beforeEach(async () => {
  // Not deleted — the application role has no delete on this table
  // (migration 0039: a request is history once made). Closed off instead,
  // which is what frees the one-pending-per-member index for the next test.
  await run(
    appUrl,
    `update member_details_request
        set status = 'declined', decided_at = now()
      where status = 'pending'`
  );
  await run(
    appUrl,
    `update application_party set values = $2::jsonb
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [applicationId, JSON.stringify(ORIGINAL)]
  );
  await clearCooldown();
});

// A request as the member's own app would send it: the whole form back,
// with one or two fields changed.
async function sendUpdate(changes: Record<string, string>) {
  const principal = await memberSession();
  const me = await profile.memberProfile(principal);
  const parties = me.parties.map(p =>
    p.subject === 'applicant'
      ? { ...p, values: { ...p.values, ...changes } }
      : p
  );
  return profile.submitDetails(principal, parties, {
    ip: null,
    correlationId: 'test',
  });
}

describe('a member’s own details update, verified by staff', () => {
  it('changes nothing until someone applies it, then only what differs', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });

    // Still as it was: the request is a proposal, not an edit.
    expect(await currentValues()).toMatchObject({
      address: ORIGINAL.address,
    });

    const [queued] = await requests.listDetailsRequests();
    expect(queued).toMatchObject({
      memberNo: 'AB0001',
      memberName: 'Fatimah Peerally',
      status: 'pending',
      changeCount: 1,
      mobile: MEMBER.mobile,
    });
    expect(queued.changes[0]).toMatchObject({
      label: 'Address',
      before: ORIGINAL.address,
      after: '99 New Road, Quatre Bornes',
    });

    const result = await requests.applyDetailsRequest(queued.id, secretary);
    expect(result).toEqual({ memberId, applied: 1 });

    const now = await currentValues();
    expect(now.address).toBe('99 New Road, Quatre Bornes');
    // Everything the request did not change is exactly as it was.
    expect(now).toMatchObject({
      surname: ORIGINAL.surname,
      name: ORIGINAL.name,
      nic: ORIGINAL.nic,
      email: ORIGINAL.email,
    });

    const decided = await requests.loadDetailsRequest(queued.id);
    expect(decided).toMatchObject({
      status: 'applied',
      decidedByName: 'Test Secretary',
    });
    // The member is no longer told an update is pending.
    const principal = await memberSession();
    expect((await profile.memberProfile(principal)).pendingUpdate).toBeNull();
  });

  it('does not revert a field an officer corrected while it waited — even though the app sends the whole form back', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });
    const [queued] = await requests.listDetailsRequests();

    // Meanwhile, at the branch: a different field is corrected.
    await run(
      appUrl,
      `update application_party
          set values = values || '{"email":"corrected@example.mu"}'::jsonb
        where application_id = $1 and subject = 'applicant' and ordinal = 1`,
      [applicationId]
    );

    await requests.applyDetailsRequest(queued.id, secretary);

    const now = await currentValues();
    expect(now.address).toBe('99 New Road, Quatre Bornes');
    expect(now.email).toBe('corrected@example.mu');
  });

  it('is refused without the permission, and cannot be applied twice', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });
    const [queued] = await requests.listDetailsRequests();

    await expect(
      requests.applyDetailsRequest(queued.id, officer)
    ).rejects.toMatchObject({ reason: 'forbidden' });
    expect((await currentValues()).address).toBe(ORIGINAL.address);

    await requests.applyDetailsRequest(queued.id, secretary);
    await expect(
      requests.applyDetailsRequest(queued.id, secretary)
    ).rejects.toMatchObject({ reason: 'conflict' });
  });

  it('declines with a reason the member is shown, and needs one', async () => {
    await sendUpdate({ surname: 'Beebeejaun' });
    const [queued] = await requests.listDetailsRequests();

    await expect(
      requests.declineDetailsRequest(queued.id, '   ', secretary)
    ).rejects.toMatchObject({ reason: 'invalid' });
    await expect(
      requests.declineDetailsRequest(queued.id, 'anything', officer)
    ).rejects.toMatchObject({ reason: 'forbidden' });

    await requests.declineDetailsRequest(
      queued.id,
      'Bring your marriage certificate to a branch.',
      secretary
    );

    expect((await currentValues()).surname).toBe(ORIGINAL.surname);

    // The member is told, in the app, why nothing changed.
    const principal = await memberSession();
    expect((await profile.memberProfile(principal)).lastUpdate).toMatchObject({
      status: 'declined',
      comment: 'Bring your marriage certificate to a branch.',
    });
    const decided = await requests.loadDetailsRequest(queued.id);
    expect(decided).toMatchObject({
      status: 'declined',
      comment: 'Bring your marriage certificate to a branch.',
    });
    await expect(
      requests.declineDetailsRequest(queued.id, 'again', secretary)
    ).rejects.toMatchObject({ reason: 'conflict' });
  });

  it('lets the member send another once the first is decided, but not before', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });
    await expect(
      sendUpdate({ address: '100 Other Road' })
    ).rejects.toMatchObject({ code: 'conflict' });

    const [queued] = await requests.listDetailsRequests();
    await requests.declineDetailsRequest(
      queued.id,
      'Not evidenced.',
      secretary
    );

    await expect(
      sendUpdate({ address: '100 Other Road' })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('refuses a form sent back with nothing changed', async () => {
    await expect(sendUpdate({})).rejects.toMatchObject({
      code: 'conflict',
      message: 'Nothing has changed.',
    });
    expect(await requests.countPendingDetailsRequests()).toBe(0);
  });

  it('keeps what the record held, so the review reads was/now after applying', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });
    const [queued] = await requests.listDetailsRequests();
    await requests.applyDetailsRequest(queued.id, secretary);

    // The record now holds the new value; the request still shows what it
    // replaced, from previous_parties rather than from the record.
    const decided = await requests.loadDetailsRequest(queued.id);
    expect(decided!.changes[0]).toMatchObject({
      before: ORIGINAL.address,
      after: '99 New Road, Quatre Bornes',
    });

    const audit = await run(
      appUrl,
      `select action, previous_value, new_value from audit_event
        where entity_id = $1 order by id`,
      [queued.id]
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual([
      'member.details.applied',
    ]);
    expect(audit.rows[0].new_value.changes[0]).toMatchObject({
      field: 'applicant.1.address',
      from: ORIGINAL.address,
      to: '99 New Road, Quatre Bornes',
    });
  });

  it('keeps every request: the application role cannot delete one', async () => {
    await sendUpdate({ address: '99 New Road, Quatre Bornes' });
    await expect(
      run(appUrl, `delete from member_details_request`)
    ).rejects.toThrowError(/permission denied/i);
  });

  it('refuses an update from a member with no application to write it to', async () => {
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const legacy = await run(
      appUrl,
      `insert into member (member_no, membership_type_id) values ('AB9999', $1)
       returning id`,
      [type.rows[0].id]
    );
    const principal = {
      sessionId: '00000000-0000-0000-0000-000000000000',
      mobile: '+23050000000',
      memberId: legacy.rows[0].id as string,
      customerId: null,
      kind: 'member' as const,
    };
    await expect(
      profile.submitDetails(principal, [], { ip: null, correlationId: 'test' })
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/visit a branch/i),
    });
  });
});
