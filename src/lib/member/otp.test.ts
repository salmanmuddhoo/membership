// One-time codes by WhatsApp: what Meta is sent, and when it is chosen.
//
// WhatsApp accepts a code from a business only as an approved
// Authentication template, with the code as the body's one variable and
// again as the copy-code button's. A message without the button parameter
// is refused, and a member who is refused gets no code at all, so the
// shape of the request is the behaviour worth pinning down here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VARS = [
  'MEMBER_SESSION_SECRET',
  'MEMBER_OTP_DELIVERY',
  'MEMBER_OTP_WEBHOOK_URL',
  'MEMBER_OTP_WEBHOOK_TOKEN',
  'MEMBER_OTP_FIXED_CODE',
  'MEMBER_OTP_WHATSAPP_TEMPLATE',
  'MEMBER_OTP_WHATSAPP_LANGUAGE',
  'NOTIFY_WHATSAPP_PHONE_NUMBER_ID',
  'NOTIFY_WHATSAPP_TOKEN',
  'NOTIFY_WHATSAPP_BASE_URL',
  'NOTIFY_WHATSAPP_API_VERSION',
  'NOTIFY_EMAIL_DELIVERY',
  'NOTIFY_EMAIL_FROM',
  'NOTIFY_EMAIL_WEBHOOK_URL',
  'NOTIFY_EMAIL_WEBHOOK_TOKEN',
  'PUBLIC_APP_ENV',
] as const;

const saved = { ...process.env };

beforeEach(() => {
  for (const name of VARS) delete process.env[name];
  process.env.MEMBER_SESSION_SECRET = 'x'.repeat(40);
  // Production: WhatsApp is how codes leave the members' site.
  process.env.PUBLIC_APP_ENV = 'production';
  process.env.MEMBER_OTP_DELIVERY = 'whatsapp';
  process.env.MEMBER_OTP_WHATSAPP_TEMPLATE = 'albarakah_code';
  process.env.NOTIFY_WHATSAPP_PHONE_NUMBER_ID = '109876543210';
  process.env.NOTIFY_WHATSAPP_TOKEN = 'system-user-token';
});

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return {
    ...(await import('./otp')),
    ...(await import('../config')),
  };
}

function fetchReturning(status: number, body = '{}') {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status })
  );
}

describe('choosing WhatsApp', () => {
  it('is chosen in production with a template, a number and a token', async () => {
    const { getMemberConfig, phoneChannel } = await load();
    const config = getMemberConfig();
    expect(config.otpDelivery).toBe('whatsapp');
    expect(config.otpWhatsapp?.language).toBe('en');
    expect(phoneChannel(config)).toBe('whatsapp');
  });

  it.each([
    'MEMBER_OTP_WHATSAPP_TEMPLATE',
    'NOTIFY_WHATSAPP_PHONE_NUMBER_ID',
    'NOTIFY_WHATSAPP_TOKEN',
  ])('is not configured without %s, and says so', async name => {
    delete process.env[name];
    const { getMemberConfig, codeDelivery, MemberConfigError } = await load();
    const config = getMemberConfig();
    expect(config.otpDelivery).toBe('unconfigured');
    expect(() => codeDelivery(config)).toThrow(MemberConfigError);
  });

  it('tells the app to look for an SMS when a gateway sends the codes', async () => {
    process.env.MEMBER_OTP_DELIVERY = 'http';
    process.env.MEMBER_OTP_WEBHOOK_URL = 'https://gateway.example/send';
    const { getMemberConfig, phoneChannel } = await load();
    expect(phoneChannel(getMemberConfig())).toBe('sms');
  });
});

describe('sending a code by WhatsApp', () => {
  it('fills the approved template with the code, body and button', async () => {
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { codeDelivery, codeMessage } = await load();

    await codeDelivery().send('+23057891234', codeMessage('482913'), '482913');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/109876543210/messages');
    expect(new Headers(init!.headers).get('authorization')).toBe(
      'Bearer system-user-token'
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '23057891234',
      type: 'template',
      template: {
        name: 'albarakah_code',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '482913' }],
          },
        ],
      },
    });
  });

  it('uses the language the template was approved in', async () => {
    process.env.MEMBER_OTP_WHATSAPP_LANGUAGE = 'en_GB';
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { codeDelivery } = await load();

    await codeDelivery().send('+23057891234', 'unused', '482913');

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.template.language).toEqual({ code: 'en_GB' });
  });

  it('fails the send when Meta refuses it, naming nothing to the caller', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        400,
        '{"error":{"message":"Template name does not exist"}}'
      )
    );
    const { codeDelivery, CodeDeliveryError } = await load();

    await expect(
      codeDelivery().send('+23057891234', 'unused', '482913')
    ).rejects.toBeInstanceOf(CodeDeliveryError);
  });

  it('fails the send when Meta cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const { codeDelivery, CodeDeliveryError } = await load();

    await expect(
      codeDelivery().send('+23057891234', 'unused', '482913')
    ).rejects.toBeInstanceOf(CodeDeliveryError);
  });
});

describe('what the person is shown', () => {
  it('masks a Mauritian mobile as +230 5*** *428', async () => {
    const { maskMobile } = await load();
    expect(maskMobile('+23057891428')).toBe('+230 5*** *428');
  });

  it('masks a number from elsewhere to its first four and last three', async () => {
    const { maskMobile } = await load();
    expect(maskMobile('+447700900123')).toBe('+447 ******123');
  });

  it('masks an email to its first and last letters and the domain', async () => {
    const { maskEmail } = await load();
    expect(maskEmail('salmanmuddhoo@gmail.com')).toBe('s***o@gmail.com');
    expect(maskEmail('ab@example.mu')).toBe('a***@example.mu');
  });
});

describe('sending a code by email', () => {
  it("goes out as the Society's other email does, the code in the body", async () => {
    process.env.NOTIFY_EMAIL_DELIVERY = 'http';
    process.env.NOTIFY_EMAIL_WEBHOOK_URL = 'https://gateway.example/send';
    const fetchMock = fetchReturning(200);
    vi.stubGlobal('fetch', fetchMock);
    const { emailCodeDelivery, codeMessage, EMAIL_SUBJECT } = await load();

    await emailCodeDelivery().send(
      'fatimah@example.mu',
      codeMessage('482913'),
      '482913'
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/send');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      channel: 'email',
      to: 'fatimah@example.mu',
      subject: EMAIL_SUBJECT,
    });
    expect(body.message).toContain('482913 is your Al Barakah code');
  });

  it('says the code could not be sent by email when the site sends none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { emailCodeDelivery, CodeDeliveryError } = await load();

    const sending = emailCodeDelivery().send('fatimah@example.mu', 'x', '1');
    await expect(sending).rejects.toBeInstanceOf(CodeDeliveryError);
    await expect(
      emailCodeDelivery().send('fatimah@example.mu', 'x', '1')
    ).rejects.toThrow(/Choose WhatsApp/);
  });
});
