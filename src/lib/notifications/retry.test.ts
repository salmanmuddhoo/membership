// The retry policy (S-904).
//
// The backoff is the part that has no database in it, and the part that
// decides whether a member hears from the Society an hour late or not at all.
// Two properties matter: it grows, so a relay that is down is not hammered;
// and it stops, so a mistyped address does not generate a row retried nightly
// for a year, burying the failures worth acting on.
import { describe, expect, it } from 'vitest';
import { backoffMinutes, MAX_ATTEMPTS } from './retry';

describe('backoffMinutes', () => {
  it('waits minutes after the first failure, not hours', () => {
    // A relay that refused one message is usually busy for a moment. Making a
    // member wait six hours for that would be the wrong trade.
    expect(backoffMinutes(1)).toBe(5);
  });

  it('grows with each further attempt', () => {
    const waits = [1, 2, 3, 4, 5].map(backoffMinutes);
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBeGreaterThan(waits[i - 1]);
    }
  });

  it('reaches a day, so an overnight outage is ridden out', () => {
    expect(backoffMinutes(5)).toBe(24 * 60);
  });

  // The schedule is indexed by attempt number; a count past its end must
  // settle on the longest wait rather than reading off the end of the array.
  it('holds at the longest wait rather than becoming undefined', () => {
    expect(backoffMinutes(6)).toBe(24 * 60);
    expect(backoffMinutes(99)).toBe(24 * 60);
  });

  // markFailed calls this with attempts + 1, which is always at least 1, but
  // a zero or negative must still produce a usable wait rather than NaN.
  it('never returns a wait that is not a number of minutes', () => {
    expect(backoffMinutes(0)).toBe(5);
    expect(backoffMinutes(-1)).toBe(5);
  });
});

describe('the ceiling', () => {
  // The waits between attempts have to add up to more than a night, or a
  // relay that comes back the next morning finds every message given up on.
  it('spans more than a day before giving up', () => {
    let total = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      total += backoffMinutes(attempt);
    }
    expect(total).toBeGreaterThan(24 * 60);
  });
});
