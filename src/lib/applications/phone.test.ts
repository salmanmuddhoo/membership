import { describe, expect, it } from 'vitest';
import { forDisplay, PhoneFormatError, toInternational } from './phone';

describe('storing a telephone number in full international form (S-301)', () => {
  it('places a Mauritian mobile however it was typed', () => {
    for (const input of [
      '57891234',
      '5789 1234',
      '5789-1234',
      '(5789) 1234',
      ' 57891234 ',
    ]) {
      expect(toInternational(input), input).toBe('+23057891234');
    }
  });

  it('accepts a 7-digit fixed line', () => {
    expect(toInternational('4661234')).toBe('+2304661234');
  });

  it('recognises the country code written with or without a plus', () => {
    expect(toInternational('+230 5789 1234')).toBe('+23057891234');
    expect(toInternational('23057891234')).toBe('+23057891234');
    expect(toInternational('00230 5789 1234')).toBe('+23057891234');
  });

  it('leaves a foreign number alone', () => {
    // A nominee living abroad. Assuming Mauritius here would be silent and
    // permanent.
    expect(toInternational('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(toInternational('0044 20 7123 4567')).toBe('+442071234567');
  });

  it('is idempotent, so re-saving a draft does not corrupt it', () => {
    const once = toInternational('5789 1234');
    expect(toInternational(once)).toBe(once);
    expect(toInternational(toInternational(once))).toBe(once);
  });

  it('refuses a length it cannot place rather than guessing', () => {
    // Nine local digits is not a Mauritian number. Prefixing +230 would
    // produce something that looks right and can never be dialled.
    expect(() => toInternational('123456789')).toThrowError(PhoneFormatError);
    expect(() => toInternational('12345')).toThrowError(PhoneFormatError);
  });

  it('refuses letters and empty input', () => {
    expect(() => toInternational('call me')).toThrowError(PhoneFormatError);
    expect(() => toInternational('5789EXT2')).toThrowError(PhoneFormatError);
    expect(() => toInternational('   ')).toThrowError(/required/);
  });

  it('does not treat a local number beginning 230 as a country code', () => {
    // 2301234 is a real 7-digit fixed line. Stripping the leading 230 would
    // turn it into +2301234, a different number entirely — the length check
    // is what keeps them apart.
    expect(toInternational('2301234')).toBe('+2302301234');
  });

  it('reads back in a form a person can check', () => {
    expect(forDisplay('+23057891234')).toBe('+230 5789 1234');
    // Anything not Mauritian is shown as stored rather than mis-grouped.
    expect(forDisplay('+33612345678')).toBe('+33612345678');
  });
});
