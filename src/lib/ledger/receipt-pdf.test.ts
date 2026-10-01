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
    atTheCounter: null,
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

  it("names a Minor's guardian as collecting a withdrawal", () => {
    const rows = receiptFacts({
      ...receipt({ kind: 'withdrawal', holderName: 'Zara Test' }),
      atTheCounter: 'Irfan Test',
    });
    expect(rows[0]).toEqual({ label: 'Paid to', value: 'Irfan Test' });
    expect(rows[1]).toEqual({
      label: 'On behalf of',
      value: 'Zara Test · AB0001',
    });
  });

  it('lists every account a demised claim closed, and the Takaful benefit on its own line', () => {
    const claim = {
      ...receipt({
        kind: 'demise',
        amount: '50700.00',
        takafulBenefit: '15000.00',
        payeeName: 'Yusuf Nominee',
        reason: null,
        balanceAfter: '0.00',
      }),
      accountsClosed: [
        { id: 'a', accountNo: 'AB0001', typeName: 'Shares', amount: '5000.00' },
        {
          id: 'b',
          accountNo: 'HSA0007',
          typeName: 'Hajj Savings Account',
          amount: '30700.00',
        },
      ],
    };
    const rows = receiptFacts(claim);
    expect(rows.find(r => r.label === 'Accounts')?.value).toBe(
      'AB0001 · Shares · MUR 5,000.00\nHSA0007 · Hajj Savings Account · MUR 30,700.00'
    );
    const text = Buffer.from(renderReceiptPdf(claim)).toString('latin1');
    expect(text).toContain('Takaful benefit');
    expect(text).toContain('15,000.00');
    expect(text).toContain('35,700.00');
    expect(text).toContain('50,700.00');
    expect(text).not.toContain('Balance after');
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
