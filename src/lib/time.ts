// The Society's clock. Every time the system shows, and every "today" it
// works out, is Mauritius time — not the server's, which in production is
// UTC and four hours behind (an entry made at 02:30 on the 5th would
// otherwise read 22:30 on the 4th, and land in the 4th's report).
//
// Mauritius keeps no daylight saving, so the offset is fixed: a calendar day
// begins at 00:00+04:00 all year. The database does the same for its own
// date arithmetic (src/lib/db/pool.ts sets each connection's time zone).

export const TIME_ZONE = 'Indian/Mauritius';
const OFFSET = '+04:00';

/** An en-GB formatter that reads in Mauritius time. */
export function localFormat(
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: TIME_ZONE });
}

const isoDay = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TIME_ZONE,
});

/** The Mauritius calendar day an instant falls on, as YYYY-MM-DD. */
export function localDay(at: Date = new Date()): string {
  return isoDay.format(at);
}

/** The first instant of a Mauritius calendar day given as YYYY-MM-DD. */
export function startOfLocalDay(day: string): Date {
  return new Date(`${day}T00:00:00${OFFSET}`);
}

/** The last instant of a Mauritius calendar day given as YYYY-MM-DD. */
export function endOfLocalDay(day: string): Date {
  return new Date(`${day}T23:59:59.999${OFFSET}`);
}
