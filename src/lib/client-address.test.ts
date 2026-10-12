import { describe, expect, it } from 'vitest';
import { clientAddress, normaliseAddress } from './client-address';

describe('the client address', () => {
  it('drops the port Azure writes onto it, so inet takes it', () => {
    expect(normaliseAddress('196.20.185.85:10007')).toBe('196.20.185.85');
    expect(normaliseAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normaliseAddress('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('keeps a bare address as it is', () => {
    expect(normaliseAddress('196.20.185.85')).toBe('196.20.185.85');
    expect(normaliseAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normaliseAddress('::1')).toBe('::1');
  });

  it('is null for anything that is not an address', () => {
    for (const value of [
      null,
      undefined,
      '',
      'unknown',
      '300.1.1.1',
      '1.2.3',
      'a.b.c.d:80',
      'not:an:address',
      `${'1'.repeat(70)}`,
    ]) {
      expect(normaliseAddress(value)).toBeNull();
    }
  });

  it('reads the first x-forwarded-for entry — the original client', () => {
    const headers = new Headers({
      'x-forwarded-for': '196.20.185.85:10007, 10.0.0.4',
    });
    expect(clientAddress(headers)).toBe('196.20.185.85');
    expect(clientAddress(new Headers())).toBeNull();
  });
});
