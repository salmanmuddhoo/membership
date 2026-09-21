import { describe, expect, it } from 'vitest';
import { depositorFor } from './depositor';
import type { PartyValues } from './capture';

const party = (
  subject: string,
  values: Record<string, string>,
  ordinal = 1
): PartyValues => ({ subject, ordinal, values }) as PartyValues;

describe('who the money came from', () => {
  it('is the applicant themselves for an Individual', () => {
    expect(
      depositorFor('individual', [
        party('applicant', {
          name: 'Bilal',
          surname: 'Joomun',
          nic: 'J1201905123456',
        }),
      ])
    ).toEqual({ name: 'Bilal Joomun', nic: 'J1201905123456' });
  });

  // Officer feedback: the receipt and the Cash Deposit Form both named the
  // child, who had signed nothing and handed over nothing.
  it('is the guardian for a Minor, not the child', () => {
    expect(
      depositorFor('minor', [
        party('applicant', { name: 'Yusuf', surname: 'Joomun', nic: 'Y123' }),
        party('guardian', { name: 'Ahmed', surname: 'Joomun', nic: 'A456' }),
      ])
    ).toEqual({ name: 'Ahmed Joomun', nic: 'A456' });
  });

  // A registered entity is not a person and cannot stand at a counter.
  it('is the Contact Person for a Corporate entity', () => {
    expect(
      depositorFor('corporate', [
        party('applicant', {
          name: 'Al Barakah Trading Ltd',
          registration_no: 'C12345',
          contact_person: 'Rashid Peerbocus',
        }),
      ])
    ).toEqual({ name: 'Rashid Peerbocus', nic: '' });
  });

  // The Society's form asks for no NIC against a Contact Person, so the
  // paper one leaves a ruled blank and so does this.
  it('leaves a Corporate deposit with no NIC to print', () => {
    const { nic } = depositorFor('corporate', [
      party('applicant', { contact_person: 'Rashid Peerbocus', nic: 'C999' }),
    ]);
    expect(nic).toBe('');
  });

  it('reads the type code, not a label an administrator may rename', () => {
    // 'Minor Savings Account' as a NAME would not match; the code does.
    expect(
      depositorFor('minor', [
        party('applicant', { name: 'Yusuf', surname: 'Joomun' }),
        party('guardian', { name: 'Ahmed', surname: 'Joomun' }),
      ]).name
    ).toBe('Ahmed Joomun');
  });

  it('comes back empty rather than half-built when nothing was captured', () => {
    expect(
      depositorFor('minor', [party('applicant', { name: 'Yusuf' })])
    ).toEqual({ name: '', nic: '' });
  });

  it('skips a missing half of a name instead of leaving a gap', () => {
    expect(
      depositorFor('individual', [party('applicant', { surname: 'Joomun' })])
    ).toEqual({ name: 'Joomun', nic: '' });
  });
});
