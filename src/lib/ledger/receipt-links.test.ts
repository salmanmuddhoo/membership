import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The signed link a member opens their receipt from (S-1602): what it
// carries, how long it lasts, and everything it refuses.
const SECRET = 'receipt-link-test-secret-with-thirty-two-plus-characters';
const saved = { ...process.env };

async function load() {
  vi.resetModules();
  return import('./receipt-links');
}

beforeEach(() => {
  process.env.MEMBER_SESSION_SECRET = SECRET;
  process.env.PUBLIC_APP_URL = 'https://members.example.mu/';
  delete process.env.ENTRA_REDIRECT_URI;
});
afterEach(() => {
  process.env = { ...saved };
});

describe('a receipt link (S-1602)', () => {
  it('names the transaction it was signed for, and nothing else', async () => {
    const links = await load();
    const id = '11111111-2222-4333-8444-555555555555';
    const token = await links.signReceiptToken(id);
    expect(token).toBeTruthy();
    expect(await links.verifyReceiptToken(token!)).toBe(id);
    expect(
      await links.verifyReceiptToken(token!.slice(0, -2) + 'xx')
    ).toBeNull();
    expect(await links.verifyReceiptToken('')).toBeNull();
    expect(await links.verifyReceiptToken('not-a-token')).toBeNull();
  });

  it('opens on the app origin, and is nothing without one', async () => {
    let links = await load();
    const link = await links.receiptLink('abc');
    expect(link).toMatch(
      /^https:\/\/members\.example\.mu\/receipts\/shared\/[\w-]+\.[\w-]+\.[\w-]+$/
    );

    delete process.env.PUBLIC_APP_URL;
    process.env.ENTRA_REDIRECT_URI = 'https://staff.example.mu/auth/callback';
    links = await load();
    expect(await links.receiptLink('abc')).toMatch(
      /^https:\/\/staff\.example\.mu\/receipts\/shared\//
    );

    delete process.env.ENTRA_REDIRECT_URI;
    links = await load();
    expect(await links.receiptLink('abc')).toBeNull();
  });

  it('refuses a token that has expired, was signed for another purpose, or with another key', async () => {
    const links = await load();
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ purpose: 'receipt' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('abc')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    expect(await links.verifyReceiptToken(expired)).toBeNull();

    const otherPurpose = await new SignJWT({ purpose: 'member-session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('abc')
      .setExpirationTime('1h')
      .sign(key);
    expect(await links.verifyReceiptToken(otherPurpose)).toBeNull();

    const otherKey = await new SignJWT({ purpose: 'receipt' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('abc')
      .setExpirationTime('1h')
      .sign(
        new TextEncoder().encode('another-secret-of-thirty-two-characters!')
      );
    expect(await links.verifyReceiptToken(otherKey)).toBeNull();
  });

  it('signs nothing without the member-facing secret', async () => {
    process.env.MEMBER_SESSION_SECRET = 'short';
    const links = await load();
    expect(await links.signReceiptToken('abc')).toBeNull();
    expect(await links.verifyReceiptToken('anything')).toBeNull();
    expect(await links.receiptLink('abc')).toBeNull();
  });
});
