import { describe, expect, it } from 'vitest';
import { normalise } from './capture';
import type { MembershipTypeField } from '../config/reference';

const gender: MembershipTypeField = {
  id: 'f',
  fieldKey: 'gender',
  label: 'Gender',
  dataType: 'choice',
  choices: ['Male', 'Female'],
  subject: 'applicant',
  isVisible: true,
  isMandatory: true,
  sortOrder: 1,
};

// QA-25: the member app sent "female"; stored as sent, the officer's form
// knew only "Female" and showed the field blank.
describe('normalise, a choice', () => {
  it('is stored as the choice is written, whatever case it came in', () => {
    const { values, errors } = normalise({ gender: 'female' }, [gender]);
    expect(values.gender).toBe('Female');
    expect(errors).toEqual([]);
  });

  it('refuses a value that is none of the choices', () => {
    const { values, errors } = normalise({ gender: 'other' }, [gender]);
    expect(values.gender).toBe('other');
    expect(errors.map(e => e.label)).toEqual([
      'Gender must be one of: Male, Female',
    ]);
  });
});
