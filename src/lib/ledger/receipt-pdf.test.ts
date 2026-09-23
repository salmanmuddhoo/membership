import { describe, expect, it } from 'vitest';
import {
  receiptFacts,
  receiptPdfFileName,
  renderReceiptPdf,
} from './receipt-pdf';
import type { TransactionReceipt } from './receipts';

// The receipt as a file (S-1602): what the member keeps says what the sheet
// says. No database — the sheet is drawn from a loaded receipt, and the
// reading of the transaction is the part worth pinning.
function receipt(overrides: Record<string, unknown> = {}): TransactionReceipt {
  return {
    receiptNumberId: 'rn',
    receiptNo: 'RCT-000123',
    state: 'issued',
    voidReason: null,
    voidedAt: null,
    capturedByRole: 'Account Officer',
    postedByName: 'Zainab Officer',
    depositorName: null,
    accountsClosed: [],
    transaction: {
      id: 'tx',
      reference: 'DEP-2026-000045',
      kind: 'deposit',
      status: 'posted',
      amount: '7000.00',
      currency: 'MUR',
      method: 'cash',
      methodName: 'Cash',
      methodReference: '',
      reason: 'Top up',
      accountNo: 'MSA-0001',
      accountTypeName: 'Member Savings Account',
      holderKind: 'member',
      holderName: 'Amina Test',
      memberNo: 'AB0001',
      capturedByName: 'Zainab Officer',
      createdAt: new Date('2026-09-22T08:00:00Z'),
      postedAt: new Date('2026-09-22T08:05:00Z'),
      balanceAfter: '12000.00',
      transferReference: null,
      displayReference: 'DEP-2026-000045',
      legDirection: null,
      payeeName: null,
      counterpartAccountNo: null,
      counterpartAccountTypeName: null,
      counterpartHolderName: null,
      ...overrides,
    },
  } as unknown as TransactionReceipt;
}

describe('the receipt as a PDF', () => {
  it('is a PDF that says what the sheet says', () => {
    const bytes = renderReceiptPdf(receipt());
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    for (const expected of [
      'Al Barakah MCSL',
      'RCT-000123',
      'Deposit receipt',
      'Amina Test',
      'AB0001',
      'MSA-0001',
      'DEP-2026-000045',
      'Top up',
      '7,000.00',
      '12,000.00',
    ]) {
      expect(text).toContain(expected);
    }
    expect(receiptPdfFileName(receipt())).toBe('Receipt RCT-000123.pdf');
  });

  it('reads a transfer leg and a payee the way the sheet does', () => {
    const rows = receiptFacts(
      receipt({
        kind: 'transfer_leg',
        method: 'internal_transfer',
        legDirection: 'debit',
        transferReference: 'TRF-2026-000009',
        displayReference: 'TRF-2026-000009',
        counterpartHolderName: 'Yusuf Test',
        counterpartAccountNo: 'MSA-0002',
        counterpartAccountTypeName: 'Member Savings Account',
      })
    );
    expect(rows.map(r => r.label)).toEqual([
      'Paid to',
      'Account',
      'To',
      'Transaction',
      'Recorded by',
    ]);
    expect(rows[2].value).toBe(
      'Yusuf Test · MSA-0002 · Member Savings Account'
    );
    // A transfer by its own reference alone (QA-11).
    expect(rows[3].value).toBe('TRF-2026-000009');

    const paid = receiptFacts(
      receipt({ kind: 'withdrawal', payeeName: 'Ismail Nominee' })
    );
    expect(paid[0]).toEqual({ label: 'Paid to', value: 'Ismail Nominee' });
    expect(paid[2]).toEqual({
      label: 'On behalf of',
      value: 'Amina Test · AB0001',
    });
  });

  it('marks a voided receipt as void', () => {
    const text = Buffer.from(
      renderReceiptPdf(
        receipt() && {
          ...receipt(),
          state: 'void',
          voidReason: 'Printed twice',
          voidedAt: new Date('2026-09-23T09:00:00Z'),
        }
      )
    ).toString('latin1');
    expect(text).toContain('VOID');
    expect(text).toContain('Printed twice');
  });
});
