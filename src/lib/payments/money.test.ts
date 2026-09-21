// Money arithmetic (M5).
//
// Pure and fast, and worth its own file: every variance decision on a receipt
// rests on these three functions being exact.
import { describe, expect, it } from 'vitest';
import { formatMoney, fromCents, MoneyError, sumCents, toCents } from './money';

describe('reading an amount', () => {
  it.each([
    ['0', 0],
    ['1500', 150_000],
    ['1500.00', 150_000],
    ['0.05', 5],
    ['0.5', 50],
    ['-12.34', -1234],
  ])('reads %s as %i cents', (input, cents) => {
    expect(toCents(input)).toBe(cents);
  });

  it.each(['', ' ', 'abc', '1.234', '1,500', '1e3', '1.', '.5'])(
    'refuses %s rather than guessing',
    input => {
      expect(() => toCents(input)).toThrow(MoneyError);
    }
  );
});

describe('writing an amount back', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [150_000, '1500.00'],
    [-1234, '-12.34'],
  ])('writes %i cents as %s', (cents, text) => {
    expect(fromCents(cents)).toBe(text);
  });

  it('survives a round trip', () => {
    for (const amount of ['0.00', '0.01', '8500.00', '99999999.99']) {
      expect(fromCents(toCents(amount))).toBe(amount);
    }
  });
});

describe('adding up a receipt', () => {
  // The reason this module exists. In floating point 0.1 + 0.2 is not 0.3,
  // and a receipt that decides a variance that way would refuse a payment
  // that is exactly right.
  it('adds without drifting', () => {
    expect(fromCents(sumCents(['0.10', '0.20']))).toBe('0.30');
    expect(
      fromCents(sumCents(['1500.00', '2000.00', '5000.00', '5000.00']))
    ).toBe('13500.00');
  });

  it('reports a difference of one cent', () => {
    const due = sumCents(['1500.00', '2000.00']);
    const paid = sumCents(['1500.00', '1999.99']);
    expect(fromCents(paid - due)).toBe('-0.01');
  });
});

describe('putting an amount on the screen', () => {
  it('groups thousands and always shows both decimals', () => {
    expect(formatMoney('13500.00')).toBe('MUR 13,500.00');
    expect(formatMoney('8.5')).toBe('MUR 8.50');
    expect(formatMoney('-1234567.89')).toBe('-MUR 1,234,567.89');
  });
});
