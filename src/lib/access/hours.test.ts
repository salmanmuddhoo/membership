// Staff access hours (access/hours.ts): when the system is closed, and to whom.
import { describe, expect, it } from 'vitest';
import type { Principal } from './principal';
import { heldToHours, isClosedAt, localMinutes, OPEN_ALL_DAY } from './hours';

// Mauritius is UTC+4 all year.
const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00+04:00`);

const officer = (overrides: Partial<Principal> = {}): Principal => ({
  userId: 'u1',
  entraSubject: 's1',
  email: 'officer@albarakah.mu',
  displayName: 'Officer',
  roles: ['account_officer'],
  roleNames: ['Account Officer'],
  permissions: new Set(),
  ...overrides,
});

describe('closed hours', () => {
  it('reads the clock in Mauritius time', () => {
    expect(localMinutes(new Date('2026-11-26T13:30:00Z'))).toBe(17 * 60 + 30);
  });

  it('closes from the evening through the night when the window runs past midnight', () => {
    const hours = { from: '17:00', until: '07:00' };
    expect(isClosedAt(hours, at('16:59'))).toBe(false);
    expect(isClosedAt(hours, at('17:00'))).toBe(true);
    expect(isClosedAt(hours, at('23:30'))).toBe(true);
    expect(isClosedAt(hours, at('00:15'))).toBe(true);
    expect(isClosedAt(hours, at('06:59'))).toBe(true);
    expect(isClosedAt(hours, at('07:00'))).toBe(false);
    expect(isClosedAt(hours, at('12:00'))).toBe(false);
  });

  it('closes between the two times when the window sits inside one day', () => {
    const hours = { from: '12:00', until: '13:00' };
    expect(isClosedAt(hours, at('11:59'))).toBe(false);
    expect(isClosedAt(hours, at('12:30'))).toBe(true);
    expect(isClosedAt(hours, at('13:00'))).toBe(false);
  });

  it('stays open all day when the times are blank, malformed or equal', () => {
    expect(isClosedAt(OPEN_ALL_DAY, at('23:00'))).toBe(false);
    expect(isClosedAt({ from: '5pm', until: '7am' }, at('23:00'))).toBe(false);
    expect(isClosedAt({ from: '17:00', until: '17:00' }, at('17:00'))).toBe(
      false
    );
  });

  it('holds officers to the hours, but not a System Administrator or an account allowed out of hours', () => {
    expect(heldToHours(officer())).toBe(true);
    expect(heldToHours(officer({ outOfHoursAccess: false }))).toBe(true);
    expect(heldToHours(officer({ outOfHoursAccess: true }))).toBe(false);
    expect(heldToHours(officer({ roles: ['system_administrator'] }))).toBe(
      false
    );
  });
});
