import { describe, expect, it } from 'vitest';
import { statementPeriod, statementRows } from './statement';
import type { Statement } from './ledger';

// What a statement's period means when the officer gives half of it, and
// how its rows go into a spreadsheet (S-1604).
const today = new Date('2026-09-22T10:00:00Z');

describe('the statement period (S-1604)', () => {
  it('is month to date when nothing is asked', () => {
    expect(statementPeriod({ from: null, to: null }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-22',
    });
  });

  it('takes the missing bound from the one given', () => {
    expect(statementPeriod({ from: '2026-08-10', to: null }, today)).toEqual({
      from: '2026-08-10',
      to: '2026-09-22',
    });
    expect(statementPeriod({ from: null, to: '2026-07-15' }, today)).toEqual({
      from: '2026-07-01',
      to: '2026-07-15',
    });
    expect(statementPeriod({ from: '2026-12-01', to: null }, today)).toEqual({
      from: '2026-12-01',
      to: '2026-12-01',
    });
  });

  it('refuses a period that is not two dates in order', () => {
    expect(
      statementPeriod({ from: '2026-09-10', to: '2026-09-01' }, today)
    ).toBeNull();
    expect(statementPeriod({ from: 'yesterday', to: null }, today)).toBeNull();
    expect(statementPeriod({ from: null, to: '2026-13-01' }, today)).toBeNull();
    expect(
      statementPeriod({ from: '2026-09-01', to: '2026-09-01' }, today)
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
  });
});

describe('the statement as rows (S-1604)', () => {
  it('opens and closes with the balances, and totals the period', () => {
    const statement: Statement = {
      accountId: 'a',
      accountNo: 'MSA-000001',
      accountTypeName: 'Multiplier Savings Account',
      holderId: 'h',
      holderKind: 'member',
      holderName: 'Amina Test',
      memberNo: 'M-000001',
      from: '2026-09-01',
      to: '2026-09-22',
      openingBalance: '100.00',
      closingBalance: '1050.00',
      totalCredits: '1000.00',
      totalDebits: '50.00',
      lines: [
        {
          sequenceNo: 1,
          transactionId: 't1',
          reference: 'TXN-1',
          postedAt: new Date('2026-09-03T08:00:00Z'),
          description: 'Deposit',
          debit: null,
          credit: '1000.00',
          balance: '1100.00',
          receiptNo: 'RCT-000010',
          methodName: 'Cash',
          methodReference: '',
          reason: 'Top up',
        },
        {
          sequenceNo: 2,
          transactionId: 't2',
          reference: 'TXN-2',
          postedAt: new Date('2026-09-04T08:00:00Z'),
          description: 'Withdrawal',
          debit: '50.00',
          credit: null,
          balance: '1050.00',
          receiptNo: 'RCT-000011',
          methodName: 'Bank transfer',
          methodReference: 'MCB 123',
          reason: '',
        },
      ],
    };
    const rows = statementRows(statement);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      date: '2026-09-01',
      description: 'Opening balance',
      balance: '100.00',
    });
    expect(rows[1]).toMatchObject({
      date: '2026-09-03',
      description: 'Deposit · Top up',
      method: 'Cash',
      credit: '1000.00',
      debit: null,
      receipt: 'RCT-000010',
    });
    expect(rows[2]).toMatchObject({
      method: 'Bank transfer · MCB 123',
      debit: '50.00',
    });
    expect(rows[3]).toMatchObject({
      date: '2026-09-22',
      description: 'Closing balance',
      debit: '50.00',
      credit: '1000.00',
      balance: '1050.00',
    });
  });
});
