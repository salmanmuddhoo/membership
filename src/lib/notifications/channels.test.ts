// What actually leaves the system, and what happens when nothing can (S-902,
// S-903).
//
// The behaviour worth pinning down here is not the shape of a Graph request.
// It is that a channel nobody has configured REFUSES. A channel that quietly
// succeeded would put 'sent' against a notification no member ever received,
// and the delivery log — the whole point of S-904 — would show a system
// working perfectly while telling nobody anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOTIFY_VARS = [
  'NOTIFY_EMAIL_DELIVERY',
  'NOTIFY_EMAIL_FROM',
  'NOTIFY_EMAIL_WEBHOOK_URL',
  'NOTIFY_EMAIL_WEBHOOK_TOKEN',
  'NOTIFY_WHATSAPP_DELIVERY',
  'NOTIFY_WHATSAPP_WEBHOOK_URL',
  'NOTIFY_WHATSAPP_WEBHOOK_TOKEN',
  'NOTIFY_WHATSAPP_PHONE_NUMBER_ID',
  'NOTIFY_WHATSAPP_TOKEN',
  'NOTIFY_WHATSAPP_BASE_URL',
  'NOTIFY_EMAIL_PHONE_NUMBER_ID',
  'NOTIFY_EMAIL_TOKEN',
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'PUBLIC_APP_ENV',
] as const;

const saved = { ...process.env };

beforeEach(() => {
  for (const name of NOTIFY_VARS) delete process.env[name];
  // Non-production unless a test says otherwise: 'log' is only available here.
  process.env.PUBLIC_APP_ENV = 'test';
});

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return {
    ...(await import('./channels')),
    ...(await import('../config')),
  };
}

const EMAIL = {
  channel: 'email' as const,
  recipient: 'fatimah@example.mu',
  subject: 'Welcome to Al Barakah',
  body: 'Assalamoualaikoum Fatimah,',
};

// Typed so the recorded call is a [url, init] tuple TypeScript can read
// back; an untyped vi.fn() infers no arguments at all.
function fetchReturning(status: number, body = '') {
  return vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(body, { status })
  );
}

const WHATSAPP = {
  channel: 'whatsapp' as const,
  recipient: '+23057891234',
  subject: null,
  body: 'Your membership has been approved.',
};

describe('a channel with no provider configured', () => {
  it('refuses, rather than reporting a send that never happened', async () => {
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });

  it('names the setting an administrator has to add', async () => {
    const { configuredChannels } = await load();

    await expect(
      configuredChannels().get('whatsapp')!.send(WHATSAPP)
    ).rejects.toThrowError(/NOTIFY_WHATSAPP_DELIVERY/);
  });

  // Half-configured is where an operator most often lands: the delivery kind
  // set, the setting it needs forgotten. It must read as not configured at
  // all rather than posting to `undefined`.
  it('treats http with no gateway URL as not configured', async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'http';
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });

  it('treats graph with no mailbox to send as as not configured', async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'graph';
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });
});

describe('the log channel', () => {
  it('writes what a member would have been sent', async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'log';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { configuredChannels } = await load();

    await configuredChannels().get('email')!.send(EMAIL);

    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(info.mock.calls[0][0] as string)).toMatchObject({
      kind: 'notification',
      channel: 'email',
      to: 'fatimah@example.mu',
      body: 'Assalamoualaikoum Fatimah,',
    });
  });

  // It reports success while telling the member nothing, which in front of
  // real members is the worst failure there is. Refusing makes it visible in
  // the delivery log instead.
  it('is not available in production', async () => {
    process.env.PUBLIC_APP_ENV = 'production';
    process.env.NOTIFY_EMAIL_DELIVERY = 'log';
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });
});

describe('the gateway channel', () => {
  beforeEach(() => {
    process.env.NOTIFY_WHATSAPP_DELIVERY = 'http';
    process.env.NOTIFY_WHATSAPP_WEBHOOK_URL = 'https://gateway.example/send';
  });

  it('posts the same { to, message } the one-time codes already post', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(WHATSAPP);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/send');
    expect(JSON.parse(init!.body as string)).toEqual({
      channel: 'whatsapp',
      to: '+23057891234',
      message: 'Your membership has been approved.',
    });
  });

  // A channel with no subject line of its own must not invent one: a gateway
  // reading `subject` would put an empty heading on a WhatsApp message.
  it('omits the subject on a channel that has none', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(WHATSAPP);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty('subject');
  });

  it('carries the subject on a channel that has one', async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'http';
    process.env.NOTIFY_EMAIL_WEBHOOK_URL = 'https://gateway.example/send';
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('email')!.send(EMAIL);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.subject).toBe('Welcome to Al Barakah');
  });

  it('authenticates when the gateway needs a token', async () => {
    process.env.NOTIFY_WHATSAPP_WEBHOOK_TOKEN = 'gateway-token';
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(WHATSAPP);

    const headers = fetchMock.mock.calls[0][1]!.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe('Bearer gateway-token');
  });

  it('treats a refusal as a failure, with the status in the reason', async () => {
    vi.stubGlobal('fetch', fetchReturning(502, 'nope'));
    const { configuredChannels, NotificationSendError } = await load();

    const send = configuredChannels().get('whatsapp')!.send(WHATSAPP);
    await expect(send).rejects.toBeInstanceOf(NotificationSendError);
    await expect(send).rejects.toThrowError(/502/);
  });

  // An unreachable gateway is a failure to record, not an exception shape
  // callers have to know about.
  it('treats an unreachable gateway as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => {
        throw new Error('ECONNREFUSED');
      })
    );
    const { configuredChannels, NotificationSendError } = await load();

    await expect(
      configuredChannels().get('whatsapp')!.send(WHATSAPP)
    ).rejects.toBeInstanceOf(NotificationSendError);
  });
});

describe('WhatsApp through the Cloud API', () => {
  beforeEach(() => {
    process.env.NOTIFY_WHATSAPP_DELIVERY = 'cloud_api';
    process.env.NOTIFY_WHATSAPP_PHONE_NUMBER_ID = '1234567890';
    process.env.NOTIFY_WHATSAPP_TOKEN = 'meta-token';
    process.env.NOTIFY_WHATSAPP_BASE_URL = 'https://graph.test';
  });

  const APPROVED = {
    ...WHATSAPP,
    providerTemplateName: 'membership_approved',
    providerTemplateLanguage: 'en',
    parameters: ['Fatimah Joomun', 'AB1001'],
  };

  // The whole point of S-903's rework: a business-initiated WhatsApp message
  // may only be an approved template with positional values, never the
  // finished sentence. Sending text here is rejected by Meta, not delivered.
  it('sends the approved template and its values, not the finished text', async () => {
    const fetchMock = fetchReturning(200, '{"messages":[{"id":"wamid.x"}]}');
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(APPROVED);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.test/v21.0/1234567890/messages');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: 'membership_approved',
        language: { code: 'en' },
      },
    });
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Fatimah Joomun' },
      { type: 'text', text: 'AB1001' },
    ]);
    // The rendered sentence is the outbox's record, not what goes on the wire.
    expect(init!.body as string).not.toContain(WHATSAPP.body);
  });

  // Meta wants international form without the plus; M3 stores it with one.
  it('strips the leading plus from the number', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(APPROVED);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.to).toBe('23057891234');
  });

  it('authenticates with the token', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('whatsapp')!.send(APPROVED);

    const headers = fetchMock.mock.calls[0][1]!.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe('Bearer meta-token');
  });

  // Meta rejects an empty parameter list rather than reading it as none.
  it('omits components for a template with no variables', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels()
      .get('whatsapp')!
      .send({ ...APPROVED, parameters: [] });

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.template).not.toHaveProperty('components');
  });

  // Without a template name there is nothing to send that WhatsApp would
  // accept, and saying so is more use than a 400 from Meta.
  it('refuses a message with no provider template name', async () => {
    vi.stubGlobal('fetch', fetchReturning(200));
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('whatsapp')!.send(WHATSAPP)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });

  // An unapproved template and an expired token both come back as a 4xx, and
  // only Meta's body tells them apart — so it reaches the delivery log.
  it('carries Meta’s own reason into the failure', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        400,
        '{"error":{"message":"template name does not exist"}}'
      )
    );
    const { configuredChannels, NotificationSendError } = await load();

    const send = configuredChannels().get('whatsapp')!.send(APPROVED);
    await expect(send).rejects.toBeInstanceOf(NotificationSendError);
    await expect(send).rejects.toThrowError(/template name does not exist/);
  });

  // Half-configured reads as not configured, the same as every other channel.
  it('treats a missing phone number id as not configured', async () => {
    delete process.env.NOTIFY_WHATSAPP_PHONE_NUMBER_ID;
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('whatsapp')!.send(APPROVED)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });

  // Microsoft 365 sends mail, not WhatsApp; the reverse is equally true.
  it('is not available on the email channel', async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'cloud_api';
    process.env.NOTIFY_EMAIL_PHONE_NUMBER_ID = '1234567890';
    process.env.NOTIFY_EMAIL_TOKEN = 'meta-token';
    const { configuredChannels, NotificationConfigError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationConfigError);
  });
});

describe('the Microsoft 365 mailbox', () => {
  beforeEach(() => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'graph';
    process.env.NOTIFY_EMAIL_FROM = 'noreply@albarakah.mu';
    process.env.GRAPH_TENANT_ID = 'tenant';
    process.env.GRAPH_CLIENT_ID = 'client';
    process.env.GRAPH_CLIENT_SECRET = 'secret';
  });

  function graphFetch(sendStatus = 202) {
    return vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('/oauth2/')
        ? Response.json({ access_token: 'token', expires_in: 3600 })
        : new Response('', { status: sendStatus })
    );
  }

  // GRAPH_DRIVE_ID is the document library's setting. Mail has no drive, and
  // requiring one would make an environment that only sends email impossible
  // to configure.
  it('sends without a document library being configured', async () => {
    const fetchMock = graphFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('email')!.send(EMAIL);

    const sendCall = fetchMock.mock.calls.find(call =>
      call[0].includes('sendMail')
    )!;
    expect(sendCall[0]).toBe(
      'https://graph.microsoft.com/v1.0/users/noreply%40albarakah.mu/sendMail'
    );
  });

  // Plain text, never HTML: the body came from a template an administrator
  // typed, and treating it as markup would make the template editor a way to
  // put markup into a member's inbox.
  it('sends the body as text, not as markup', async () => {
    const fetchMock = graphFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { configuredChannels } = await load();

    await configuredChannels().get('email')!.send(EMAIL);

    const sendCall = fetchMock.mock.calls.find(call =>
      call[0].includes('sendMail')
    )!;
    const body = JSON.parse(sendCall[1]!.body as string);
    expect(body.message.body).toEqual({
      contentType: 'Text',
      content: 'Assalamoualaikoum Fatimah,',
    });
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { address: 'fatimah@example.mu' } },
    ]);
    expect(body.saveToSentItems).toBe(false);
  });

  it('treats a refusal from Graph as a failure', async () => {
    vi.stubGlobal('fetch', graphFetch(403));
    const { configuredChannels, NotificationSendError } = await load();

    await expect(
      configuredChannels().get('email')!.send(EMAIL)
    ).rejects.toBeInstanceOf(NotificationSendError);
  });
});
