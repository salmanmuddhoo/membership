import { describe, expect, it } from 'vitest';
import { finalStepLabel, transactionStatusLabel } from './labels';

// What a finished transaction is called, on its chevron and as its status
// (officer direction): a deposit or a transfer is recorded, money paid out
// is disbursed.
describe('transaction labels', () => {
  it('records a deposit and a transfer, and disburses everything else', () => {
    const cases: [string, string, string][] = [
      ['deposit', 'Deposit recorded', 'Deposit recorded'],
      ['transfer_leg', 'Transfer recorded', 'Transfer recorded'],
      ['withdrawal', 'Disbursement', 'Disbursed'],
      ['closure', 'Disbursement', 'Disbursed'],
      ['resignation', 'Disbursement', 'Disbursed'],
      ['demise', 'Disbursement', 'Disbursed'],
    ];
    for (const [kind, step, status] of cases) {
      expect(finalStepLabel({ kind })).toBe(step);
      expect(transactionStatusLabel({ kind, status: 'posted' })).toBe(status);
    }
  });

  it('names a transaction still on its way by its status, whatever the kind', () => {
    expect(
      transactionStatusLabel({ kind: 'deposit', status: 'approved' })
    ).toBe('Approved');
    expect(
      transactionStatusLabel({ kind: 'transfer_leg', status: 'under_review' })
    ).toBe('Under review');
  });
});
