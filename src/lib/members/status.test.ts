import { describe, expect, it } from 'vitest';
import {
  canOpenAccount,
  canTransact,
  MEMBER_STATUSES,
  statusNotice,
} from './status';

// S-1701: the vocabulary, and the one rule it answers.
describe('member status (S-1701)', () => {
  it('lets only an active member transact', () => {
    expect(canTransact('active')).toBe(true);
    for (const status of MEMBER_STATUSES.filter(s => s !== 'active')) {
      expect(canTransact(status)).toBe(false);
    }
  });

  it('lets an active or a resigned member open a further account', () => {
    expect(MEMBER_STATUSES.filter(s => canOpenAccount(s))).toEqual([
      'active',
      'resigned',
    ]);
  });

  it('says what a member who cannot transact is, and since when', () => {
    expect(statusNotice('active', new Date())).toBeNull();
    expect(statusNotice('resigned', new Date('2026-09-03T08:00:00Z'))).toBe(
      'Resigned since 3 September 2026. No transactions.'
    );
    expect(statusNotice('dormant', null)).toBe(
      'Dormant. No transactions and no new accounts.'
    );
  });
});
