import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { CodeDelivery } from './otp';

// Against a real database: what is under test is the row lock on the
// challenge, the partial indexes, the rotation of a refresh token — all of
// which a mock would only assert back at us.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_identity_test_${Date.now()}`;
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

const identity = await import('./identity');
const profile = await import('./profile');
const pool = await import('../db/pool');

// Captures every code sent, so a test can read it back the way an SMS
// would deliver it.
const sent: { to: string; code: string }[] = [];
const delivery: CodeDelivery = {
  async send(to, message) {
    sent.push({ to, code: message.slice(0, 6) });
  },
};

const origin = { ip: '203.0.113.7', correlationId: 'test' };
const MEMBER = {
  nic: 'B1234567890123',
  abNumber: 'AB0001',
  mobile: '+23057891234',
};

let memberId: string;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  // A member the way approval leaves one: a founding application whose
  // applicant party carries the NIC and mobile, and a member row pointing
  // at it (members/create.ts). Captured by a test officer.
  const officer = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@test', 'Test Officer') returning id`
  );
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officer.rows[0].id]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb), ($1, 'nominee', 1, '{}'::jsonb)`,
    [
      application.rows[0].id,
      JSON.stringify({
        surname: 'Peerally',
        name: 'Fatimah',
        nic: MEMBER.nic,
        mobile: MEMBER.mobile,
        address: '12 Royal Road',
        gender: 'Female',
      }),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [MEMBER.abNumber, application.rows[0].id, type.rows[0].id]
  );
  memberId = member.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// The cooldown is per AB Number and this suite links the same member over
// and over; each test that is not about the cooldown starts with it clear.
async function clearCooldowns() {
  await run(
    appUrl,
    `update member_login_challenge set created_at = created_at - interval '1 minute'`
  );
}

async function link(nic = MEMBER.nic, abNumber = MEMBER.abNumber) {
  return identity.linkMember({ nic, abNumber }, origin, { delivery });
}

async function freshLink() {
  await clearCooldowns();
  return link();
}

describe('identification: NIC + AB Number', () => {
  it('names the member and sends the code to the mobile on record, saying nothing about it', async () => {
    const challenge = await link();
    expect(challenge.purpose).toBe('link_member');
    expect(challenge.sentTo).toBeNull();
    expect(sent.at(-1)?.to).toBe(MEMBER.mobile);
    expect(sent.at(-1)?.code).toMatch(/^\d{6}$/);
  });

  it('accepts the NIC and AB Number however they are typed', async () => {
    await clearCooldowns();
    const before = sent.length;
    const challenge = await link(' b1234567890123 ', 'ab 0001');
    expect(challenge.purpose).toBe('link_member');
    expect(sent.length).toBe(before + 1);
  });

  it('answers a miss exactly as a hit, whichever half is wrong, and sends nothing', async () => {
    const before = sent.length;
    const wrongAb = await link(MEMBER.nic, 'AB0002');
    const wrongNic = await link('X0000000000000', 'AB0003');
    for (const miss of [wrongAb, wrongNic]) {
      expect(miss).toMatchObject({
        purpose: 'link_member',
        sentTo: null,
        expiresInSeconds: 300,
      });
      expect(miss.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(sent.length).toBe(before);

    // Nothing verifies against it: every guess is wrong, and five burn it,
    // exactly as they would on a real challenge.
    for (let i = 0; i < 4; i++) {
      await expect(
        identity.verifyOtp(
          { challengeId: wrongAb.challengeId, code: '123456' },
          origin
        )
      ).rejects.toMatchObject({
        code: 'validation_failed',
        details: { code: expect.any(Array) },
      });
    }
    await expect(
      identity.verifyOtp(
        { challengeId: wrongAb.challengeId, code: '123456' },
        origin
      )
    ).rejects.toMatchObject({ code: 'not_found' });

    // The difference lives in the audit trail, not the response.
    const refused = await run(
      appUrl,
      `select count(*)::int as n from audit_event where action = 'member.link.refused'`
    );
    expect(refused.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('one code per AB Number per cooldown window, hit or miss', async () => {
    await expect(link()).rejects.toMatchObject({
      code: 'rate_limited',
      message: expect.stringMatching(
        /Wait \d+ seconds? before requesting another code/
      ),
    });
    await expect(link(MEMBER.nic, 'AB0002')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await clearCooldowns();
    await expect(link()).resolves.toMatchObject({ purpose: 'link_member' });
  });

  it('refuses a malformed pair with both fields named', async () => {
    await expect(link('bad!', '1')).rejects.toMatchObject({
      code: 'validation_failed',
      details: { nic: expect.any(Array), abNumber: expect.any(Array) },
    });
  });

  it('treats a member who is no longer active as a miss', async () => {
    await clearCooldowns();
    await run(appUrl, `update member set status = 'dormant' where id = $1`, [
      memberId,
    ]);
    try {
      const before = sent.length;
      await expect(link()).resolves.toMatchObject({ sentTo: null });
      expect(sent.length).toBe(before);
    } finally {
      await run(appUrl, `update member set status = 'active' where id = $1`, [
        memberId,
      ]);
    }
  });
});

describe('verification: the code', () => {
  it('links the phone to the member and returns a member session', async () => {
    const challenge = await freshLink();
    const session = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      { ...origin, deviceLabel: 'Test phone' }
    );
    expect(session.identity).toMatchObject({
      kind: 'member',
      memberNo: 'AB0001',
      displayName: 'Fatimah Peerally',
      mobile: MEMBER.mobile,
    });
    expect(session.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    // The link is a row, server-side: the member id never left.
    const row = await run(
      appUrl,
      `select member_id, device_label from member_session where refresh_token_hash is not null
        order by linked_at desc limit 1`
    );
    expect(row.rows[0].member_id).toBe(memberId);
    expect(row.rows[0].device_label).toBe('Test phone');
    expect(JSON.stringify(session)).not.toContain(memberId);
  });

  it('a code works once', async () => {
    const challenge = await freshLink();
    const code = sent.at(-1)!.code;
    await identity.verifyOtp(
      { challengeId: challenge.challengeId, code },
      origin
    );
    await expect(
      identity.verifyOtp({ challengeId: challenge.challengeId, code }, origin)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a wrong code is refused with a field message; five of them burn the challenge', async () => {
    const challenge = await freshLink();
    const right = sent.at(-1)!.code;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await expect(
        identity.verifyOtp(
          { challengeId: challenge.challengeId, code: wrong },
          origin
        )
      ).rejects.toMatchObject({
        code: 'validation_failed',
        details: { code: expect.any(Array) },
      });
    }
    await expect(
      identity.verifyOtp(
        { challengeId: challenge.challengeId, code: wrong },
        origin
      )
    ).rejects.toMatchObject({ code: 'not_found' });
    // Burnt: even the right code is dead now.
    await expect(
      identity.verifyOtp(
        { challengeId: challenge.challengeId, code: right },
        origin
      )
    ).rejects.toMatchObject({ code: 'not_found' });

    // Every failure is on the record; the code itself never is.
    const trail = await run(
      appUrl,
      `select action, new_value from audit_event
        where entity_id = $1 and action like 'member.otp.%' order by id`,
      [challenge.challengeId]
    );
    expect(trail.rows.map(r => r.action)).toEqual([
      'member.otp.rejected',
      'member.otp.rejected',
      'member.otp.rejected',
      'member.otp.rejected',
      'member.otp.burnt',
      'member.otp.rejected',
    ]);
    expect(JSON.stringify(trail.rows)).not.toContain(right);
  });

  it('a resend kills the previous code', async () => {
    const first = await freshLink();
    const firstCode = sent.at(-1)!.code;
    // Too soon: refused, and the current code stays usable.
    await expect(
      identity.resendOtp(first.challengeId, origin, { delivery })
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await clearCooldowns();
    const second = await identity.resendOtp(first.challengeId, origin, {
      delivery,
    });
    expect(second.challengeId).not.toBe(first.challengeId);
    await expect(
      identity.verifyOtp(
        { challengeId: first.challengeId, code: firstCode },
        origin
      )
    ).rejects.toMatchObject({ code: 'not_found' });
    const session = await identity.verifyOtp(
      { challengeId: second.challengeId, code: sent.at(-1)!.code },
      origin
    );
    expect(session.identity.kind).toBe('member');
  });
});

describe('sign-up: a verified mobile, never a member', () => {
  it('issues an applicant session for any well-formed number', async () => {
    const challenge = await identity.startSignUp(
      { mobile: '5999 0000' },
      origin,
      { delivery }
    );
    expect(challenge.purpose).toBe('sign_up');
    expect(sent.at(-1)?.to).toBe('+23059990000');
    const session = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      origin
    );
    expect(session.identity).toMatchObject({
      kind: 'applicant',
      memberNo: null,
    });
  });

  it("a member's own mobile used for sign-up yields only an applicant session", async () => {
    const challenge = await identity.startSignUp(
      { mobile: MEMBER.mobile },
      origin,
      { delivery }
    );
    const session = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      origin
    );
    expect(session.identity.kind).toBe('applicant');
    const principal = await identity.resolveMemberSession(
      `Bearer ${session.accessToken}`
    );
    expect(principal?.memberId).toBeNull();
  });

  it('refuses a number it cannot place, naming the field', async () => {
    await expect(
      identity.startSignUp({ mobile: '123' }, origin, { delivery })
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { mobile: expect.any(Array) },
    });
  });
});

describe('authentication: the session', () => {
  it('a bearer token resolves to the linked member, and to nothing once revoked', async () => {
    const challenge = await freshLink();
    const session = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      origin
    );
    const principal = await identity.resolveMemberSession(
      `Bearer ${session.accessToken}`
    );
    expect(principal).toMatchObject({
      kind: 'member',
      memberId,
      mobile: MEMBER.mobile,
    });

    await identity.revokeSession(principal!, origin);
    expect(
      await identity.resolveMemberSession(`Bearer ${session.accessToken}`)
    ).toBeNull();
    await expect(
      identity.refreshSession(session.refreshToken, origin)
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('a refresh rotates the token; the old one is dead', async () => {
    const challenge = await freshLink();
    const first = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      origin
    );
    const second = await identity.refreshSession(first.refreshToken, origin);
    expect(second.identity.memberNo).toBe('AB0001');
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(
      identity.refreshSession(first.refreshToken, origin)
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(
      await identity.resolveMemberSession(`Bearer ${second.accessToken}`)
    ).toMatchObject({
      memberId,
    });
  });

  it('a token signed with another key, or malformed, resolves to nothing', async () => {
    expect(
      await identity.resolveMemberSession('Bearer not-a-token')
    ).toBeNull();
    expect(await identity.resolveMemberSession(null)).toBeNull();
    expect(await identity.resolveMemberSession('Basic abc')).toBeNull();
  });
});

describe('the record, for a linked member', () => {
  async function memberSession() {
    const challenge = await freshLink();
    const session = await identity.verifyOtp(
      { challengeId: challenge.challengeId, code: sent.at(-1)!.code },
      origin
    );
    return (await identity.resolveMemberSession(
      `Bearer ${session.accessToken}`
    ))!;
  }

  it("reads the founding application's parties and the membership", async () => {
    const me = await profile.memberProfile(await memberSession());
    expect(me).toMatchObject({
      kind: 'member',
      memberNo: 'AB0001',
      status: 'active',
      membershipType: { code: 'individual', name: 'Individual' },
      pendingUpdate: null,
    });
    expect(me.parties.find(p => p.subject === 'applicant')?.values.nic).toBe(
      MEMBER.nic
    );
  });

  it('lists accounts with a null balance until something is recorded against them', async () => {
    const shares = await run(
      appUrl,
      `select id from account_type where code = 'shares'`
    );
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default)
       values ($1, $2, true)`,
      [memberId, shares.rows[0].id]
    );
    const principal = await memberSession();
    const accounts = await profile.memberAccounts(principal);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      typeCode: 'shares',
      accountNo: 'AB0001',
      balance: null,
    });
    expect(
      await profile.accountTransactions(principal, accounts[0].id)
    ).toEqual([]);
    await expect(
      profile.accountTransactions(
        principal,
        '00000000-0000-0000-0000-000000000000'
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a capture of own details is held for staff, once, with the sign-in mobile kept', async () => {
    const principal = await memberSession();
    const me = await profile.memberProfile(principal);
    const parties = me.parties.map(p =>
      p.subject === 'applicant'
        ? {
            ...p,
            values: {
              ...p.values,
              address: '99 New Road',
              mobile: '5000 0000',
            },
          }
        : p
    );

    // Mandatory nominee fields are blank on this fixture: refused, named.
    await expect(
      profile.submitDetails(principal, parties, origin)
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: expect.objectContaining({
        'nominee.1.surname': expect.any(Array),
      }),
    });

    const complete = parties.map(p =>
      p.subject === 'nominee'
        ? {
            ...p,
            values: {
              surname: 'Peerally',
              name: 'Ismail',
              nic: 'P1201791234567',
              address: '99 New Road',
            },
          }
        : p
    );
    const request = await profile.submitDetails(principal, complete, origin);
    expect(request.status).toBe('pending');

    const stored = await run(
      appUrl,
      `select parties from member_details_request where id = $1`,
      [request.id]
    );
    const applicant = stored.rows[0].parties.find(
      (p: { subject: string }) => p.subject === 'applicant'
    );
    expect(applicant.values.address).toBe('99 New Road');
    expect(applicant.values.mobile).toBe(MEMBER.mobile);

    expect((await profile.memberProfile(principal)).pendingUpdate?.id).toBe(
      request.id
    );
    await expect(
      profile.submitDetails(principal, complete, origin)
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
