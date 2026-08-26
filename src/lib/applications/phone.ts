// Storing telephone numbers in full international form (S-301).
//
// The story is explicit about why this cannot wait: the WhatsApp notifications
// in M9 need E.164, and a column holding a mix of "5789 1234", "57891234" and
// "+230 5789 1234" cannot be converted afterwards with confidence — by then
// nobody remembers which entries were Mauritian and which were a relative
// abroad. So the conversion happens once, at capture, and anything ambiguous
// is refused rather than guessed.
//
// Mauritius is +230. Local numbers are 8 digits for mobiles (leading 5) and
// 7 or 8 for fixed lines.
const MAURITIUS = '+230';

export class PhoneFormatError extends Error {
  constructor(
    readonly input: string,
    message: string
  ) {
    super(message);
    this.name = 'PhoneFormatError';
  }
}

/**
 * Convert a number as typed into E.164, or refuse.
 *
 * Refusing is the point. A number this cannot place is one a human has to
 * look at, and that is cheap now and impossible later.
 */
export function toInternational(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new PhoneFormatError(input, 'A number is required.');

  // Separators people actually type. Everything else is significant.
  const cleaned = raw.replace(/[\s\-().]/g, '');

  // 00 is the international prefix dialled from Mauritius; + is the same thing
  // written down.
  const withPlus = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;

  if (withPlus.startsWith('+')) {
    const digits = withPlus.slice(1);
    if (!/^\d{8,15}$/.test(digits)) {
      throw new PhoneFormatError(
        input,
        'An international number must be 8 to 15 digits after the country code.'
      );
    }
    return `+${digits}`;
  }

  if (!/^\d+$/.test(withPlus)) {
    throw new PhoneFormatError(
      input,
      'A number may contain only digits, spaces, brackets, dots and hyphens.'
    );
  }

  // 230 followed by a full local number: written without the plus.
  if (withPlus.startsWith('230') && withPlus.length === 11) {
    return `${MAURITIUS}${withPlus.slice(3)}`;
  }

  // A local number. 7 and 8 digits are the lengths in use; anything else is
  // more likely a typo or a foreign number missing its country code, and
  // assuming Mauritius would bake that mistake in permanently.
  if (withPlus.length === 7 || withPlus.length === 8) {
    return `${MAURITIUS}${withPlus}`;
  }

  throw new PhoneFormatError(
    input,
    `${raw} is not a number this can place. Enter a Mauritian number as 8 ` +
      'digits, or any other number in full international form starting with +.'
  );
}

// Display form: the stored value is canonical, but +23057891234 is not what
// anyone wants to read off a screen.
export function forDisplay(e164: string): string {
  if (e164.startsWith(`${MAURITIUS}`) && e164.length === 12) {
    const local = e164.slice(4);
    return `${MAURITIUS} ${local.slice(0, 4)} ${local.slice(4)}`;
  }
  return e164;
}
