// The chevron a transaction shows (S-1405): its chain as configured now,
// between Recorded and Posted. Pure — what is under test is the mapping from
// recorded state to what the officer is told.
import { describe, expect, it } from 'vitest';
import { transactionTimeline, type TimelineStep } from './timeline';

const CHAIN = [
  { code: 'secretary_review', name: 'Secretary review', roleName: 'Secretary' },
  {
    code: 'president_decision',
    name: 'President decision',
    roleName: 'President',
  },
];

const base = {
  chain: CHAIN,
  currentStepCode: null,
  passedStepCodes: [],
  rejectedAtStepCode: null,
  returnedBy: null,
  receiptNo: null,
};

const states = (steps: TimelineStep[]) =>
  Object.fromEntries(steps.map(s => [s.key, s.state]));
const current = (steps: TimelineStep[]) =>
  steps.filter(s => s.state === 'current').map(s => s.key);

describe('a transaction without a chain', () => {
  it('has no approval stage at all', () => {
    const steps = transactionTimeline({
      ...base,
      chain: [],
      status: 'posted',
      receiptNo: 'RCT-000001',
    });
    expect(steps.map(s => s.key)).toEqual(['capture', 'posted']);
    expect(states(steps)).toEqual({ capture: 'done', posted: 'done' });
    expect(steps[1].detail).toBe('RCT-000001');
  });
});

describe('a transaction on a chain', () => {
  it('shows each enabled step, current where it stands', () => {
    const steps = transactionTimeline({
      ...base,
      status: 'submitted',
      currentStepCode: 'secretary_review',
    });
    expect(steps.map(s => s.key)).toEqual([
      'capture',
      'secretary_review',
      'president_decision',
      'posted',
    ]);
    expect(steps.map(s => s.label)).toEqual([
      'Recorded',
      'Secretary review',
      'President decision',
      'Posted',
    ]);
    expect(current(steps)).toEqual(['secretary_review']);
    expect(steps[1].detail).toBe('Secretary');
    expect(states(steps).president_decision).toBe('todo');
  });

  it('marks the steps it has passed done', () => {
    const steps = transactionTimeline({
      ...base,
      status: 'under_review',
      currentStepCode: 'president_decision',
      passedStepCodes: ['secretary_review'],
    });
    expect(states(steps)).toEqual({
      capture: 'done',
      secretary_review: 'done',
      president_decision: 'current',
      posted: 'todo',
    });
  });

  it('omits a step that is disabled now, whatever the trail says', () => {
    const steps = transactionTimeline({
      ...base,
      chain: [CHAIN[1]],
      status: 'under_review',
      currentStepCode: 'president_decision',
      passedStepCodes: ['secretary_review'],
    });
    expect(steps.map(s => s.key)).toEqual([
      'capture',
      'president_decision',
      'posted',
    ]);
  });

  it('reads approved as every step done and posting next', () => {
    const steps = transactionTimeline({
      ...base,
      status: 'approved',
      passedStepCodes: ['secretary_review', 'president_decision'],
    });
    expect(current(steps)).toEqual(['posted']);
    expect(steps[3].detail).toBe('Approved, to post');
  });

  it('sends a returned transaction back to Recorded, as a problem, keeping the steps it passed', () => {
    const steps = transactionTimeline({
      ...base,
      status: 'returned',
      currentStepCode: 'president_decision',
      passedStepCodes: ['secretary_review'],
      returnedBy: 'President',
    });
    expect(current(steps)).toEqual(['capture']);
    expect(steps[0]).toMatchObject({
      problem: true,
      detail: 'Returned by President',
    });
    expect(states(steps).secretary_review).toBe('done');
    expect(states(steps).president_decision).toBe('todo');
  });

  it('marks the step that rejected it, and nothing after', () => {
    const steps = transactionTimeline({
      ...base,
      status: 'rejected',
      passedStepCodes: ['secretary_review'],
      rejectedAtStepCode: 'president_decision',
    });
    expect(states(steps)).toEqual({
      capture: 'done',
      secretary_review: 'done',
      president_decision: 'current',
      posted: 'todo',
    });
    expect(steps[2]).toMatchObject({ problem: true, detail: 'Rejected' });
  });

  it('puts a rejection on Recorded when the rejecting step is gone', () => {
    const steps = transactionTimeline({
      ...base,
      chain: [CHAIN[1]],
      status: 'rejected',
      rejectedAtStepCode: 'secretary_review',
    });
    expect(current(steps)).toEqual(['capture']);
    expect(steps[0]).toMatchObject({ problem: true, detail: 'Rejected' });
  });
});
