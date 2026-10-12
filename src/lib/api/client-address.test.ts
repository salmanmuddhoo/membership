// The caller's address as the audit trail and the rate limits read it.
import { describe, expect, it } from 'vitest';
import { addressOnly, clientAddress } from './client-address';

function headers(forwarded?: string): Headers {
  return new Headers(forwarded ? { 'x-forwarded-for': forwarded } : {});
}

describe('clientAddress', () => {
  it('takes the bare address Vercel sends', () => {
    expect(clientAddress(headers('203.0.113.7'))).toBe('203.0.113.7');
  });

  // Azure App Service: inet refuses "address:port", so every audit row that
  // carried one failed, and the rate limits saw a new address per request.
  it('drops the port Azure App Service adds', () => {
    expect(clientAddress(headers('31.14.252.4:57779'))).toBe('31.14.252.4');
    expect(clientAddress(headers('[2001:db8::1]:57779'))).toBe('2001:db8::1');
  });

  it('takes the first entry of a chain', () => {
    expect(clientAddress(headers('203.0.113.7:443, 10.0.0.1'))).toBe(
      '203.0.113.7'
    );
  });

  it('keeps an IPv6 address, whose colons are not a port', () => {
    expect(addressOnly('2001:db8::1')).toBe('2001:db8::1');
    expect(addressOnly('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('is no address when there is none, or it is not one', () => {
    expect(clientAddress(headers())).toBeNull();
    for (const junk of [
      '',
      'unknown',
      'example.com',
      '999.1.1.1',
      '1.2.3.4:x',
    ]) {
      expect(addressOnly(junk)).toBeNull();
    }
  });
});
