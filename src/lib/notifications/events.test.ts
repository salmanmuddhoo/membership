// Who hears about an application, and what they are called (S-902).
//
// Two things here are easy to get wrong and expensive to get wrong:
//
//   A minor captures no contact details of their own — migration 0010 puts
//   the mobile on the guardian for that type — so reading only the applicant
//   means a minor's family is never told anything at all.
//
//   A membership application and an account application are different news.
//   Welcoming an existing member to Al Barakah, or telling a non-member their
//   membership has been approved, are both wrong in a way the member notices.
import { describe, expect, it } from 'vitest';
import { contactFor, eventCodeFor } from './events';
import type {
  Application,
  MembershipApplication,
  PartyValues,
} from '../applications/capture';

function membershipApplication(
  parties: PartyValues[],
  overrides: Partial<MembershipApplication> = {}
): MembershipApplication {
  return {
    applicationKind: 'membership',
    id: '11111111-1111-1111-1111-111111111111',
    reference: 'APP-000123',
    status: 'submitted',
    capturedBy: '22222222-2222-2222-2222-222222222222',
    capturedByName: 'Officer',
    capturedByEmail: 'officer@albarakah.mu',
    submittedAt: null,
    decidedAt: null,
    updatedAt: new Date(),
    parties,
    membershipTypeId: '33333333-3333-3333-3333-333333333333',
    membershipTypeCode: 'individual',
    membershipTypeName: 'Individual',
    sourceCustomerId: null,
    ...overrides,
  };
}

function applicant(values: Record<string, string>): PartyValues {
  return { subject: 'applicant', ordinal: 1, values };
}

function guardian(values: Record<string, string>): PartyValues {
  return { subject: 'guardian', ordinal: 1, values };
}

describe('who an application is about, and where to write to them', () => {
  it('reads the applicant’s own name and addresses', async () => {
    const contact = await contactFor(
      membershipApplication([
        applicant({
          name: 'Fatimah',
          surname: 'Joomun',
          email: 'fatimah@example.mu',
          mobile: '+23057891234',
        }),
      ])
    );

    expect(contact).toEqual({
      name: 'Fatimah Joomun',
      email: 'fatimah@example.mu',
      mobile: '+23057891234',
    });
  });

  // The applicant here is a child with no phone and no inbox. Without the
  // fallback, nobody is told their application was approved.
  it('writes to the guardian when the applicant has no address', async () => {
    const contact = await contactFor(
      membershipApplication([
        applicant({ name: 'Yusuf', surname: 'Joomun' }),
        guardian({
          name: 'Fatimah',
          surname: 'Joomun',
          email: 'fatimah@example.mu',
          mobile: '+23057891234',
        }),
      ])
    );

    // The guardian's address, but the minor's name: the guardian is reading
    // about the child, not about themselves.
    expect(contact).toEqual({
      name: 'Yusuf Joomun',
      email: 'fatimah@example.mu',
      mobile: '+23057891234',
    });
  });

  it('prefers the applicant’s own address over the guardian’s', async () => {
    const contact = await contactFor(
      membershipApplication([
        applicant({ name: 'Yusuf', email: 'yusuf@example.mu' }),
        guardian({ name: 'Fatimah', email: 'fatimah@example.mu' }),
      ])
    );

    expect(contact?.email).toBe('yusuf@example.mu');
  });

  // A field left blank is stored as an empty string, not as an absent key, so
  // "has an email" has to mean more than "the key is there".
  it('treats a blank field as no address at all', async () => {
    const contact = await contactFor(
      membershipApplication([
        applicant({ name: 'Yusuf', email: '   ', mobile: '' }),
        guardian({ email: 'fatimah@example.mu', mobile: '+23057891234' }),
      ])
    );

    expect(contact).toMatchObject({
      email: 'fatimah@example.mu',
      mobile: '+23057891234',
    });
  });

  // Nothing to send to is not a failure. notify() skips a channel with no
  // address, so this ends as silence rather than as an error on screen.
  it('reports no address rather than inventing one', async () => {
    const contact = await contactFor(
      membershipApplication([applicant({ name: 'Yusuf', surname: 'Joomun' })])
    );

    expect(contact).toEqual({
      name: 'Yusuf Joomun',
      email: null,
      mobile: null,
    });
  });

  // A draft whose applicant has not been filled in yet. The name is blank
  // rather than "undefined undefined" reaching a member's inbox.
  it('leaves the name empty when there is no applicant captured', async () => {
    const contact = await contactFor(membershipApplication([]));

    expect(contact?.name).toBe('');
  });

  // S-613: no applicant is captured, and no legacy M7 member has an
  // application to read one from. Silence is the honest answer.
  it('has nobody to write to for a holder with no application', async () => {
    const application: Application = {
      applicationKind: 'additional_account',
      id: '44444444-4444-4444-4444-444444444444',
      reference: 'APP-000124',
      status: 'submitted',
      capturedBy: '22222222-2222-2222-2222-222222222222',
      capturedByName: 'Officer',
      capturedByEmail: 'officer@albarakah.mu',
      submittedAt: null,
      decidedAt: null,
      updatedAt: new Date(),
      parties: [],
      existingMemberId: '55555555-5555-5555-5555-555555555555',
      existingCustomerId: null,
      existingHolderId: '55555555-5555-5555-5555-555555555555',
      existingHolderLabel: 'AB1001',
      existingHolderApplicationId: null,
      selectedAccountTypes: [],
    };

    expect(await contactFor(application)).toBeNull();
  });
});

describe('which event a happening is', () => {
  it('tells a membership application from an account one', () => {
    const membership = membershipApplication([]);
    const account = { ...membership, applicationKind: 'customer_account' };

    expect(eventCodeFor(membership, 'approved')).toBe('application.approved');
    expect(eventCodeFor(account as Application, 'approved')).toBe(
      'account.approved'
    );
  });

  it('uses the account wording for an additional account too', () => {
    const account = {
      ...membershipApplication([]),
      applicationKind: 'additional_account',
    };

    expect(eventCodeFor(account as Application, 'submitted')).toBe(
      'account.submitted'
    );
  });
});
