// Where an application has got to (M3/M4, the officer's view of the process).
//
// Pure, so no database: what is under test is the mapping from recorded state
// to what the officer is told to do next.
import { describe, expect, it } from 'vitest';
import { applicationTimeline, type TimelineStep } from './timeline';

const FRESH = {
  status: 'draft',
  mandatoryFieldsOutstanding: 4,
  signedFormFiled: false,
  requiredDocumentsOutstanding: 5,
  paymentRecorded: false,
} as const;

const stateOf = (steps: TimelineStep[], key: string) =>
  steps.find(s => s.key === key)!.state;

const currentKeys = (steps: TimelineStep[]) =>
  steps.filter(s => s.state === 'current').map(s => s.key);

describe('the order of the process', () => {
  // The point of the whole thing: the form is captured, printed and signed
  // before there is any signed form to scan. Filing KYC first would mean
  // asking for a document nobody has signed yet.
  it('puts signing before the documents that prove it', () => {
    const keys = applicationTimeline(FRESH).map(s => s.key);

    expect(keys).toEqual([
      'capture',
      'sign',
      'documents',
      'payment',
      'submitted',
      'secretary',
      'decision',
    ]);
    expect(keys.indexOf('sign')).toBeLessThan(keys.indexOf('documents'));
  });
});

describe('what the officer is told to do next', () => {
  it('names exactly one step, whatever the state', () => {
    const states = [
      FRESH,
      { ...FRESH, mandatoryFieldsOutstanding: 0 },
      { ...FRESH, mandatoryFieldsOutstanding: 0, signedFormFiled: true },
      {
        ...FRESH,
        mandatoryFieldsOutstanding: 0,
        signedFormFiled: true,
        requiredDocumentsOutstanding: 0,
      },
      {
        ...FRESH,
        mandatoryFieldsOutstanding: 0,
        signedFormFiled: true,
        requiredDocumentsOutstanding: 0,
        paymentRecorded: true,
      },
      { ...FRESH, status: 'new', mandatoryFieldsOutstanding: 0 },
      { ...FRESH, status: 'approved', mandatoryFieldsOutstanding: 0 },
    ];

    for (const input of states) {
      expect(currentKeys(applicationTimeline(input))).toHaveLength(1);
    }
  });

  it('starts at capture while a mandatory field is empty', () => {
    const steps = applicationTimeline(FRESH);

    expect(currentKeys(steps)).toEqual(['capture']);
    expect(steps[0].detail).toBe('4 required fields empty');
    expect(stateOf(steps, 'sign')).toBe('todo');
  });

  it('moves to signing once the form is complete', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
    });

    expect(stateOf(steps, 'capture')).toBe('done');
    expect(currentKeys(steps)).toEqual(['sign']);
  });

  it('moves to the documents once the signed form is back', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
    });

    expect(stateOf(steps, 'sign')).toBe('done');
    expect(currentKeys(steps)).toEqual(['documents']);
    expect(steps.find(s => s.key === 'documents')!.detail).toBe(
      '5 outstanding'
    );
  });
});

describe('the payment step', () => {
  it('is what the officer is told to do once the documents are in', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
    });

    expect(currentKeys(steps)).toEqual(['payment']);
  });

  it('shows the receipt number once there is one', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
      paymentReceiptNo: 'RCT-000042',
    });

    expect(stateOf(steps, 'payment')).toBe('done');
    expect(steps.find(s => s.key === 'payment')!.detail).toBe('RCT-000042');
    expect(currentKeys(steps)).toEqual(['submitted']);
  });
});

describe('once it has left the officer', () => {
  it('shows the Secretary holding it', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'submitted_for_review',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(stateOf(steps, 'submitted')).toBe('done');
    expect(stateOf(steps, 'secretary')).toBe('current');
    expect(steps.find(s => s.key === 'secretary')!.detail).toBe(
      'With the Secretary'
    );
    expect(stateOf(steps, 'decision')).toBe('todo');
  });

  it('shows the President holding it once the Secretary has forwarded it', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'submitted_for_approval',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(stateOf(steps, 'secretary')).toBe('done');
    expect(steps.find(s => s.key === 'decision')!.detail).toBe(
      'With the President'
    );
  });

  it.each([
    ['approved', 'Approved'],
    ['rejected', 'Declined'],
  ])('records the decision when it is %s', (status, detail) => {
    const steps = applicationTimeline({
      ...FRESH,
      status,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(stateOf(steps, 'decision')).toBe('done');
    expect(steps.find(s => s.key === 'decision')!.detail).toBe(detail);
  });

  // Submitted does not mean complete. An application can be with the Secretary
  // while a required document was never filed, and the officer needs to see
  // that rather than reading "New" and assuming there is nothing to do.
  it('still shows a document outstanding after submission', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'new',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 2,
    });

    expect(stateOf(steps, 'submitted')).toBe('done');
    expect(stateOf(steps, 'documents')).toBe('current');
    expect(steps.find(s => s.key === 'documents')!.detail).toBe(
      '2 outstanding'
    );
  });
});

describe('when it comes back for correction', () => {
  it('says so on the capture step and reopens submission', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'returned',
      mandatoryFieldsOutstanding: 1,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(steps[0].detail).toBe('Returned for correction');
    expect(stateOf(steps, 'capture')).toBe('current');
    // Back with the officer, so submission is ahead of them again.
    expect(stateOf(steps, 'submitted')).toBe('todo');
  });
});

describe('a status nothing recognises', () => {
  // A status added in configuration that this code has never heard of must
  // read as "with the officer" rather than crashing or claiming completion.
  it('is treated as not yet submitted rather than failing', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'something_new',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(stateOf(steps, 'submitted')).toBe('current');
    expect(stateOf(steps, 'decision')).toBe('todo');
  });
});
