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
      'submit',
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
    expect(currentKeys(steps)).toEqual(['submit']);
  });
});

describe('once it has left the officer', () => {
  // Submission and Secretary review read as one step, "Submit" — an officer
  // has exactly one thing left to do at this point, and everything after
  // that is the Secretary's.
  it('shows the Secretary holding it', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'submitted_for_review',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
    });

    expect(stateOf(steps, 'submit')).toBe('current');
    expect(steps.find(s => s.key === 'submit')!.detail).toBe(
      'With the Secretary'
    );
    expect(stateOf(steps, 'decision')).toBe('todo');
  });

  // S-611 follow-up: Regional oversight, where enabled, is a second stage
  // folded into this same "Submit" step — reviewStageLabel (workflow.ts)
  // says which one actually holds it, and this is the one place that label
  // reaches the screen.
  it('shows the Regional Manager holding it, once workflow.ts says so', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'new',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
      paymentRecorded: true,
      reviewStageLabel: 'With the Regional Manager',
    });

    expect(steps.find(s => s.key === 'submit')!.detail).toBe(
      'With the Regional Manager'
    );
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

    expect(stateOf(steps, 'submit')).toBe('done');
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

  // A submitted status does not mean complete. An application can read
  // 'new' while a required document was never filed, and the officer needs
  // to see that rather than assuming there is nothing left to do.
  it('still shows a document outstanding after submission', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'new',
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 2,
    });

    expect(stateOf(steps, 'documents')).toBe('current');
    expect(steps.find(s => s.key === 'documents')!.detail).toBe(
      '2 outstanding'
    );
    // Submit is blocked behind the still-outstanding documents, not done.
    expect(stateOf(steps, 'submit')).toBe('todo');
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
    expect(stateOf(steps, 'submit')).toBe('todo');
  });
});

describe('marking a step as a problem, not merely current', () => {
  // "current" is true of any step waiting its turn, including one nothing is
  // wrong with — being next in line to record a payment is not a problem.
  // `problem` is specifically for a step whose own detail says something is
  // missing, so the screen can put it in red without reading every detail
  // string to guess.
  it('is a problem while a mandatory field is empty', () => {
    const steps = applicationTimeline(FRESH);
    expect(steps.find(s => s.key === 'capture')!.problem).toBe(true);
  });

  it('is a problem when returned for correction, even with nothing empty', () => {
    const steps = applicationTimeline({
      ...FRESH,
      status: 'returned',
      mandatoryFieldsOutstanding: 0,
    });
    expect(steps.find(s => s.key === 'capture')!.problem).toBe(true);
  });

  it('is a problem while a required document is outstanding, once reached', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
    });
    expect(steps.find(s => s.key === 'documents')!.problem).toBe(true);
  });

  // The point of gating on state: a step's own data can look "wrong" purely
  // because the officer has not gotten there yet — no documents filed, no
  // payment taken — and that is not the same as something being missing
  // that should already be there. Only current or done, never a step still
  // ahead in the chain.
  it('is never a problem on a step still ahead in the chain', () => {
    const steps = applicationTimeline(FRESH);

    // Capture is current with a real problem; documents and payment are
    // both untouched and both would look "incomplete" read in isolation —
    // outstanding documents, no payment — but neither has been reached yet.
    expect(stateOf(steps, 'documents')).toBe('todo');
    expect(steps.find(s => s.key === 'documents')!.problem).toBeUndefined();
    expect(stateOf(steps, 'payment')).toBe('todo');
    expect(steps.find(s => s.key === 'payment')!.problem).toBeUndefined();
  });

  it('is not a problem once complete, nor for a step nothing is wrong with', () => {
    const steps = applicationTimeline({
      ...FRESH,
      mandatoryFieldsOutstanding: 0,
      signedFormFiled: true,
      requiredDocumentsOutstanding: 0,
    });
    expect(steps.find(s => s.key === 'capture')!.problem).toBeUndefined();
    expect(steps.find(s => s.key === 'documents')!.problem).toBeUndefined();
    // Current, waiting on a payment — not a problem.
    expect(steps.find(s => s.key === 'payment')!.problem).toBeUndefined();
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

    expect(stateOf(steps, 'submit')).toBe('current');
    expect(stateOf(steps, 'decision')).toBe('todo');
  });
});
