import { describe, expect, it } from 'vitest';
import {
  canOpenAccount,
  canTransact,
  isNonMember,
  MEMBER_STATUSES,
  shownStatus,
  statusNotice,
} from './status';

// S-1701: the vocabulary, and the one rule it answers.
describe('member status (S-1701)', () => {
  it('lets an active member, and a resigned one as a non-member, transact', () => {
    expect(MEMBER_STATUSES.filter(s => canTransact(s))).toEqual([
      'active',
      'resigned',
    ]);
  });

  it('tags a resigned member a non-member while they hold an open account', () => {
    expect(isNonMember('resigned', [{ status: 'active' }])).toBe(true);
    expect(isNonMember('resigned', [{ status: 'closed' }])).toBe(false);
    expect(isNonMember('active', [{ status: 'active' }])).toBe(false);
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
      'Resigned since 3 September 2026.'
    );
    expect(statusNotice('dormant', null)).toBe(
      'Dormant. No transactions and no new accounts.'
    );
  });

  it('shows a resigned non-member as active, and a resigned member as resigned', () => {
    expect(shownStatus('resigned', true)).toBe('active');
    expect(shownStatus('resigned', false)).toBe('resigned');
  });

  it('leaves every other status as is, non-member or not', () => {
    for (const status of MEMBER_STATUSES.filter(s => s !== 'resigned')) {
      expect(shownStatus(status, true)).toBe(status);
      expect(shownStatus(status, false)).toBe(status);
    }
  });
});
