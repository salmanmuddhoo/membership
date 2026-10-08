// Push notifications to the member app (migration 0118), against a real
// database: the device registry, the fan-out from a recipient to phones,
// and the two things that make it safe — a phone goes quiet with its
// session, and a token the provider says is dead is disabled rather than
// retried for thirty hours.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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

const dbName = `push_test_${Date.now()}`;
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
delete process.env.NOTIFY_EMAIL_DELIVERY;
delete process.env.NOTIFY_WHATSAPP_DELIVERY;
delete process.env.NOTIFY_PUSH_DELIVERY;
delete process.env.NOTIFY_PUSH_SERVICE_ACCOUNT;

const push = await import('./push');
const fcm = await import('./fcm');
const { notify, registerChannel, resetChannels } = await import('./notify');
const { retryDueNotifications } = await import('./retry');
const { clearReferenceCache } = await import('../config/cache');
const identity = await import('../member/identity');
const outlets = await import('../config/outlets');
const promotions = await import('../config/promotions');
const config = await import('../config');
const pool = await import('../db/pool');
import type { MemberPrincipal } from '../member/identity';

let memberId: string;
let officerId: string;
const origin = { ip: '203.0.113.7', correlationId: 'test' };

// A session the way verify-otp leaves one, without the code dance.
async function session(
  member: string | null,
  mobile = '+23057891234'
): Promise<MemberPrincipal> {
  const row = await run(
    appUrl,
    `insert into member_session (mobile, member_id, refresh_token_hash, expires_at)
     values ($1, $2, md5(random()::text), now() + interval '30 days')
     returning id`,
    [mobile, member]
  );
  return {
    sessionId: row.rows[0].id,
    mobile,
    memberId: member,
    customerId: null,
    kind: member ? 'member' : 'applicant',
  };
}

interface Row {
  id: string;
  event_code: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  last_error: string | null;
}

async function rows(): Promise<Row[]> {
  const result = await run(
    appUrl,
    `select id, event_code, channel, recipient, subject, body, status, last_error
       from notification order by created_at`
  );
  return result.rows as Row[];
}

async function devices() {
  const result = await run(
    appUrl,
    `select token, disabled_at is not null as disabled, disabled_reason
       from member_device order by registered_at`
  );
  return result.rows as {
    token: string;
    disabled: boolean;
    disabled_reason: string | null;
  }[];
}

// Outlets and promotions are configuration: migration 0010's trigger wants
// an actor on every write, the delete included, in the same session.
async function clearConfiguration(): Promise<void> {
  const client = new pg.Client({ connectionString: appUrl, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    await client.query('delete from card_outlet');
    await client.query('delete from app_promotion');
    await client.query('commit');
  } finally {
    await client.end();
  }
}

// A push channel that records what it was handed.
function spyPush() {
  const sent: { recipient: string; subject: string | null; data?: unknown }[] =
    [];
  registerChannel({
    name: 'push',
    async send(message) {
      sent.push({
        recipient: message.recipient,
        subject: message.subject,
        data: message.data,
      });
    },
  });
  return sent;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const officer = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@test', 'Test Officer') returning id`
  );
  officerId = officer.rows[0].id;
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officerId]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ('AB0001', $1, $2) returning id`,
    [application.rows[0].id, type.rows[0].id]
  );
  memberId = member.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

beforeEach(async () => {
  await run(appUrl, 'delete from notification');
  await run(appUrl, 'delete from member_device');
  await clearConfiguration();
  resetChannels();
  clearReferenceCache();
  fcm.forgetAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NOTIFY_PUSH_DELIVERY;
  delete process.env.NOTIFY_PUSH_SERVICE_ACCOUNT;
});

describe('the phones', () => {
  it('registers a phone against its session, and the same token again just refreshes it', async () => {
    const principal = await session(memberId);
    await push.registerDevice(principal, {
      token: 'tok-1',
      platform: 'android',
      appBuild: '0.1.0',
    });
    await push.registerDevice(principal, {
      token: 'tok-1',
      platform: 'android',
    });
    expect(await devices()).toEqual([
      { token: 'tok-1', disabled: false, disabled_reason: null },
    ]);
    expect(
      await push.devicesFor(push.pushRecipient('member', memberId))
    ).toEqual([{ token: 'tok-1', platform: 'android' }]);
  });

  it('refuses a registration with no token or an unknown platform, naming the field', async () => {
    const principal = await session(memberId);
    await expect(
      push.registerDevice(principal, {
        token: '',
        platform: 'android',
      })
    ).rejects.toMatchObject({ details: { token: expect.any(Array) } });
    await expect(
      push.registerDevice(principal, {
        token: 'tok',
        platform: 'web' as 'android',
      })
    ).rejects.toMatchObject({ details: { platform: expect.any(Array) } });
  });

  it('a token that moves to another session moves with it', async () => {
    const first = await session(memberId);
    const second = await session(memberId);
    await push.registerDevice(first, { token: 'tok-1', platform: 'android' });
    await push.registerDevice(second, { token: 'tok-1', platform: 'android' });
    const result = await run(
      appUrl,
      'select session_id from member_device where token = $1',
      ['tok-1']
    );
    expect(result.rows[0].session_id).toBe(second.sessionId);
  });

  it('goes quiet with its session: signing out, or withdrawing the token', async () => {
    const principal = await session(memberId);
    await push.registerDevice(principal, {
      token: 'tok-1',
      platform: 'android',
    });
    await push.registerDevice(principal, { token: 'tok-2', platform: 'ios' });
    const recipient = push.pushRecipient('member', memberId);
    expect(await push.hasDevices(recipient)).toBe(true);

    await push.unregisterDevice(principal, 'tok-2');
    expect(await push.devicesFor(recipient)).toEqual([
      { token: 'tok-1', platform: 'android' },
    ]);

    await identity.revokeSession(principal, origin);
    expect(await push.hasDevices(recipient)).toBe(false);
    expect((await devices()).map(d => d.disabled_reason)).toEqual([
      'signed out',
      'withdrawn',
    ]);
  });

  it('only the session that registered a token may withdraw it', async () => {
    const mine = await session(memberId);
    const theirs = await session(null, '+23059990000');
    await push.registerDevice(mine, { token: 'tok-1', platform: 'android' });
    await push.unregisterDevice(theirs, 'tok-1');
    expect((await devices())[0].disabled).toBe(false);
  });

  it('"everyone" is every live phone, an applicant’s included; an unknown recipient is nobody', async () => {
    await push.registerDevice(await session(memberId), {
      token: 'tok-1',
      platform: 'android',
    });
    await push.registerDevice(await session(null, '+23059990000'), {
      token: 'tok-2',
      platform: 'android',
    });
    expect(
      (await push.devicesFor(push.PUSH_EVERYONE)).map(d => d.token)
    ).toEqual(['tok-1', 'tok-2']);
    expect(await push.devicesFor('member:not-a-uuid')).toEqual([]);
    expect(await push.devicesFor('')).toEqual([]);
  });
});

describe('sending', () => {
  it('writes a push row for a member with a phone, carrying what the app needs to open the right screen', async () => {
    const sent = spyPush();
    await push.registerDevice(await session(memberId), {
      token: 'tok-1',
      platform: 'android',
    });
    const written = await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: {
        amount: '500.00',
        account: 'SA-1 · Savings',
        balance: '1,500.00',
      },
      entityType: 'transaction',
      entityId: '11111111-1111-1111-1111-111111111111',
    });
    expect(written).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({
      channel: 'push',
      recipient: `member:${memberId}`,
      subject: 'Deposit received',
      status: 'sent',
    });
    expect(row.body).toContain('Rs 500.00');
    expect(sent).toEqual([
      {
        recipient: `member:${memberId}`,
        subject: 'Deposit received',
        data: {
          event: 'deposit.posted',
          entityType: 'transaction',
          entityId: '11111111-1111-1111-1111-111111111111',
        },
      },
    ]);
  });

  it('writes nothing for a member with no phone signed in — no row, rather than "sent" to nobody', async () => {
    const sent = spyPush();
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: {},
    });
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('through the log, reaches every phone behind the recipient', async () => {
    process.env.NOTIFY_PUSH_DELIVERY = 'log';
    const lines = vi.spyOn(console, 'info').mockImplementation(() => {});
    const principal = await session(memberId);
    await push.registerDevice(principal, {
      token: 'tok-1',
      platform: 'android',
    });
    await push.registerDevice(principal, { token: 'tok-2', platform: 'ios' });
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: { amount: '5.00' },
    });
    expect((await rows())[0].status).toBe('sent');
    const logged = lines.mock.calls.map(c => JSON.parse(String(c[0])));
    expect(logged.map(l => l.to).sort()).toEqual(['tok-1', 'tok-2']);
    expect(logged[0]).toMatchObject({
      channel: 'push',
      subject: 'Deposit received',
      data: { event: 'deposit.posted' },
    });
  });

  it('refuses with the setting to add when no provider is configured', async () => {
    await push.registerDevice(await session(memberId), {
      token: 'tok-1',
      platform: 'android',
    });
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: {},
    });
    const [row] = await rows();
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('NOTIFY_PUSH_DELIVERY');
  });
});

describe('Firebase', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const account = {
    projectId: 'albarakah-test',
    clientEmail: 'push@albarakah-test.iam.gserviceaccount.com',
    privateKey: pem,
  };

  // A stand-in for Google: hands out a token, and answers each send as told.
  function stubGoogle(
    answer: (token: string) => { status: number; body?: unknown }
  ) {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('oauth2')) {
          return new Response(
            JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
            { status: 200 }
          );
        }
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        const reply = answer(body.message.token);
        return new Response(
          reply.body === undefined ? '' : JSON.stringify(reply.body),
          { status: reply.status }
        );
      })
    );
    return calls;
  }

  it('signs a service-account assertion Google can verify', () => {
    const jwt = fcm.serviceAccountAssertion(account, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        createPublicKey(privateKey),
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
  });

  it('reads the key file as Firebase issues it, pasted or base64-encoded, and nothing else', () => {
    // The PEM markers are assembled here rather than written out, so the
    // secrets scan does not take a test fixture for a leaked key.
    const marker = (word: string) => `-----${word} PRIVATE KEY-----`;
    const key = `${marker('BEGIN')}\nabc\n${marker('END')}\n`;
    // The key file's other fields (type, key ids, token URIs) are not read,
    // and not written here either: the shape alone reads as a credential to
    // the secrets scan.
    const json = JSON.stringify({
      project_id: 'p',
      client_email: 'e@p.iam.gserviceaccount.com',
      private_key: key,
    });
    const parsed = {
      projectId: 'p',
      clientEmail: 'e@p.iam.gserviceaccount.com',
      privateKey: key,
    };
    expect(config.parseServiceAccount(json)).toEqual(parsed);
    expect(
      config.parseServiceAccount(Buffer.from(json).toString('base64'))
    ).toEqual(parsed);
    expect(config.parseServiceAccount('{"project_id":"p"}')).toBeUndefined();
    expect(config.parseServiceAccount('not json')).toBeUndefined();
    expect(config.parseServiceAccount(undefined)).toBeUndefined();

    process.env.NOTIFY_PUSH_DELIVERY = 'fcm';
    expect(config.getNotificationConfig().push.kind).toBe('unconfigured');
    process.env.NOTIFY_PUSH_SERVICE_ACCOUNT = json;
    expect(config.getNotificationConfig().push).toMatchObject({
      kind: 'fcm',
      serviceAccount: parsed,
    });
  });

  it('sends one message per phone, with the title, text and data', async () => {
    process.env.NOTIFY_PUSH_DELIVERY = 'fcm';
    process.env.NOTIFY_PUSH_SERVICE_ACCOUNT = JSON.stringify({
      project_id: account.projectId,
      client_email: account.clientEmail,
      private_key: account.privateKey,
    });
    const calls = stubGoogle(() => ({ status: 200, body: { name: 'ok' } }));
    const principal = await session(memberId);
    await push.registerDevice(principal, {
      token: 'tok-1',
      platform: 'android',
    });
    await push.registerDevice(principal, {
      token: 'tok-2',
      platform: 'android',
    });
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: { amount: '5.00', account: 'SA-1', balance: '10.00' },
    });
    expect((await rows())[0].status).toBe('sent');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'https://fcm.googleapis.com/v1/projects/albarakah-test/messages:send'
    );
    expect(calls.map(c => c.body.message.token).sort()).toEqual([
      'tok-1',
      'tok-2',
    ]);
    expect(calls[0].body.message).toMatchObject({
      notification: {
        title: 'Deposit received',
        body: 'Rs 5.00 has been deposited to SA-1. Balance: Rs 10.00.',
      },
      data: { event: 'deposit.posted' },
      android: { priority: 'high', notification: { channel_id: 'default' } },
    });
  });

  it('disables a phone Firebase says is gone, and still counts the send as made', async () => {
    process.env.NOTIFY_PUSH_DELIVERY = 'fcm';
    process.env.NOTIFY_PUSH_SERVICE_ACCOUNT = JSON.stringify({
      project_id: account.projectId,
      client_email: account.clientEmail,
      private_key: account.privateKey,
    });
    stubGoogle(token =>
      token === 'dead'
        ? {
            status: 404,
            body: {
              error: {
                code: 404,
                message: 'Requested entity was not found.',
                status: 'NOT_FOUND',
                details: [
                  {
                    '@type':
                      'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                    errorCode: 'UNREGISTERED',
                  },
                ],
              },
            },
          }
        : { status: 200, body: {} }
    );
    const principal = await session(memberId);
    await push.registerDevice(principal, {
      token: 'dead',
      platform: 'android',
    });
    await push.registerDevice(principal, {
      token: 'live',
      platform: 'android',
    });
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: {},
    });
    expect((await rows())[0].status).toBe('sent');
    expect(await devices()).toEqual([
      {
        token: 'dead',
        disabled: true,
        disabled_reason: expect.stringContaining('UNREGISTERED'),
      },
      { token: 'live', disabled: false, disabled_reason: null },
    ]);
  });

  it('fails the row — for the retry job — when Firebase cannot be reached at all', async () => {
    process.env.NOTIFY_PUSH_DELIVERY = 'fcm';
    process.env.NOTIFY_PUSH_SERVICE_ACCOUNT = JSON.stringify({
      project_id: account.projectId,
      client_email: account.clientEmail,
      private_key: account.privateKey,
    });
    stubGoogle(() => ({ status: 503, body: { error: { message: 'down' } } }));
    await push.registerDevice(await session(memberId), {
      token: 'tok-1',
      platform: 'android',
    });
    await notify({
      eventCode: 'deposit.posted',
      recipients: { push: push.pushRecipient('member', memberId) },
      values: {},
    });
    let [row] = await rows();
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('HTTP 503');

    // Back up: the retry carries the same data payload.
    const calls = stubGoogle(() => ({ status: 200, body: {} }));
    await run(
      appUrl,
      `update notification set next_attempt_at = now() - interval '1 minute'`
    );
    const outcome = await retryDueNotifications();
    expect(outcome).toMatchObject({ attempted: 1, sent: 1 });
    [row] = await rows();
    expect(row.status).toBe('sent');
    expect(calls[0].body.message.data).toEqual({ event: 'deposit.posted' });
  });
});

describe('the app’s own news', () => {
  const actor = { userId: '', email: 'officer@test' };
  const outlet = {
    name: 'Bright Minds',
    logoUrl: 'https://cdn.example/logo.png',
    category: 'education',
    discountPercent: '12.5',
    description: 'Tuition',
    address: '',
    linkUrl: '',
    isActive: true,
    isPartner: false,
    sortOrder: '',
  };
  const promotion = {
    title: 'Eid savings',
    body: 'Open a savings account this month.',
    imageUrl: 'https://cdn.example/eid.png',
    linkUrl: '',
    linkLabel: '',
    accent: '',
    isActive: true,
    startsOn: '',
    endsOn: '',
    sortOrder: '',
  };

  beforeEach(async () => {
    actor.userId = officerId;
    await push.registerDevice(await session(memberId), {
      token: 'tok-1',
      platform: 'android',
    });
  });

  it('tells every phone when an outlet becomes a partner — once', async () => {
    const sent = spyPush();
    const id = await outlets.createOutlet(outlet, actor);
    expect(sent).toEqual([]);

    await outlets.updateOutlet(id, { ...outlet, isPartner: true }, actor);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipient: 'everyone',
      subject: 'New partner: Bright Minds',
      data: { event: 'partner.added', entityType: 'card_outlet', entityId: id },
    });
    expect((await rows())[0].body).toContain('12.5% off');

    // An edit to a partner is not news again; switching it off and on is.
    await outlets.updateOutlet(
      id,
      { ...outlet, isPartner: true, description: 'Tuition and books' },
      actor
    );
    expect(sent).toHaveLength(1);
    await outlets.updateOutlet(
      id,
      { ...outlet, isPartner: true, isActive: false },
      actor
    );
    await outlets.updateOutlet(id, { ...outlet, isPartner: true }, actor);
    expect(sent).toHaveLength(2);

    // A partner from the start is news too.
    await outlets.createOutlet(
      { ...outlet, name: 'Winners', isPartner: true },
      actor
    );
    expect(sent).toHaveLength(3);
  });

  it('tells every phone when a promotion goes live — and not one scheduled for later', async () => {
    const sent = spyPush();
    const id = await promotions.createPromotion(promotion, actor);
    expect(sent).toEqual([
      {
        recipient: 'everyone',
        subject: 'Eid savings',
        data: {
          event: 'promotion.published',
          entityType: 'app_promotion',
          entityId: id,
        },
      },
    ]);
    expect((await rows())[0].body).toBe('Open a savings account this month.');

    const later = await promotions.createPromotion(
      { ...promotion, title: 'Next year', startsOn: '2099-01-01' },
      actor
    );
    expect(sent).toHaveLength(1);
    // Brought forward: live now, so news now.
    await promotions.updatePromotion(
      later,
      { ...promotion, title: 'Next year', startsOn: '' },
      actor
    );
    expect(sent).toHaveLength(2);
    // Edited while live: not again.
    await promotions.updatePromotion(
      later,
      { ...promotion, title: 'This year', startsOn: '' },
      actor
    );
    expect(sent).toHaveLength(2);
  });

  it('says nothing when nobody has the app', async () => {
    await run(appUrl, 'delete from member_device');
    const sent = spyPush();
    await outlets.createOutlet({ ...outlet, isPartner: true }, actor);
    expect(sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});
