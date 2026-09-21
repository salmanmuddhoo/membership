// Money, as whole cents.
//
// Amounts arrive from PostgreSQL as strings, because numeric(14,2) in a
// JavaScript number is a rounding error waiting for a large enough figure.
// They must go back the same way. Everything in between is integer cents, so
// the arithmetic that decides whether a payment matches the fee schedule is
// exact — 0.1 + 0.2 deciding a variance is not a defect anyone would enjoy
// finding in a receipt.

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// Optional sign, digits, and at most two decimal places. Anything else is
// refused rather than rounded: a third decimal in a money field is a mistake,
// and silently dropping it changes what the officer thought they typed.
const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

export function toCents(amount: string): number {
  const trimmed = amount.trim();
  if (!AMOUNT.test(trimmed)) {
    throw new MoneyError(`${amount || 'An amount'} is not an amount.`);
  }

  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`${amount} is too large to record.`);
  }
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError('That amount cannot be represented exactly.');
  }
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function sumCents(amounts: readonly string[]): number {
  return amounts.reduce((total, amount) => total + toCents(amount), 0);
}

// For the screen and the printed receipt. Grouped and always two decimals,
// which is what a figure on a receipt has to look like.
//
// Built from the integer parts rather than from cents/100: dividing to get a
// number to format puts a float back into the one path that exists to keep
// floats out.
export function formatMoney(amount: string, currency = 'MUR'): string {
  const cents = toCents(amount);
  const absolute = Math.abs(cents);
  const rupees = new Intl.NumberFormat('en-GB').format(
    Math.trunc(absolute / 100)
  );
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${currency} ${rupees}.${remainder}`;
}
