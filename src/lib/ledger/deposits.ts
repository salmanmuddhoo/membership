// Recording a deposit (S-1305, S-1306, S-1308). Schema: migrations/0064,
// 0065, 0067, 0068; docs/ledger.md.
//
// The first transaction an officer records, and the shape every later kind
// follows: decide whether it may happen (the account, its holder, its type's
// rules, the method, the cash controls), write the transaction row, post it
// through the engine, issue the receipt — one database transaction, so a
// deposit is either wholly on the ledger with its receipt or not there at
// all. A deposit below the escalation threshold has no approval chain (FRD
// 6.2); M14 puts the threshold in front of this.
import { createHash } from 'node:crypto';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import {
  applyCashPaymentRules,
  offeredMethod,
  PaymentError,
  requireReference,
} from '../payments/payments';
import { fromCents, MoneyError, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { LedgerError, postTransaction } from './ledger';

export class DepositError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'invalid' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'DepositError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';

export interface DepositInput {
  accountId: string;
  amount: string;
  method: string;
  methodReference?: string;
  reason?: string;
  // The same key from the same officer is the same deposit (S-1308). The
  // form issues one when it renders; the API demands one in a header.
  idempotencyKey?: string;
  // The officer's confirmation that the Source of Fund form was completed —
  // required only for cash above payment.cash_source_of_fund_threshold, the
  // rule a payment already follows (S-1306).
  sourceOfFundFormConfirmed?: boolean;
}

export interface Deposit {
  id: string;
  reference: string;
  kind: string;
  status: string;
  accountId: string;
  accountNo: string;
  accountTypeName: string;
  memberId: string | null;
  customerId: string | null;
  amount: string;
  currency: string;
  method: string;
  methodName: string;
  methodReference: string;
  reason: string;
  receiptNo: string | null;
  // What the account stood at once this posted, from the posting itself.
  balanceAfter: string | null;
  capturedById: string;
  capturedByName: string;
  createdAt: Date;
  postedAt: Date | null;
}

// What the key is checked against. Amount in cents so "5000" and "5000.00"
// are the same request; everything else as the caller sent it.
function fingerprint(input: DepositInput, amountCents: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        amountCents,
        method: input.method,
        methodReference: (input.methodReference ?? '').trim(),
        reason: (input.reason ?? '').trim(),
      })
    )
    .digest('hex');
}

const DEPOSIT_SELECT = `
  select t.id, t.reference, t.kind, t.status, t.account_id,
         coalesce(a.account_no, m.member_no) as account_no,
         at.name as account_type_name,
         t.member_id, t.customer_id, t.amount, t.currency,
         t.method, pm.name as method_name,
         coalesce(t.method_reference, '') as method_reference,
         coalesce(t.reason, '') as reason,
         rn.receipt_no,
         fe.payload->>'balance_after' as balance_after,
         t.captured_by, u.display_name as captured_by_name,
         t.created_at, t.posted_at
    from transaction t
    join account a on a.id = t.account_id
    join account_type at on at.id = a.account_type_id
    join payment_method pm on pm.code = t.method
    join app_user u on u.id = t.captured_by
    left join member m on m.id = t.member_id
    left join receipt_number rn on rn.id = t.receipt_number_id
    left join financial_event fe
      on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
`;

interface DepositRow {
  id: string;
  reference: string;
  kind: string;
  status: string;
  account_id: string;
  account_no: string;
  account_type_name: string;
  member_id: string | null;
  customer_id: string | null;
  amount: string;
  currency: string;
  method: string;
  method_name: string;
  method_reference: string;
  reason: string;
  receipt_no: string | null;
  balance_after: string | null;
  captured_by: string;
  captured_by_name: string;
  created_at: Date;
  posted_at: Date | null;
}

function assemble(r: DepositRow): Deposit {
  return {
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    status: r.status,
    accountId: r.account_id,
    accountNo: r.account_no,
    accountTypeName: r.account_type_name,
    memberId: r.member_id,
    customerId: r.customer_id,
    amount: r.amount,
    currency: r.currency,
    method: r.method,
    methodName: r.method_name,
    methodReference: r.method_reference,
    reason: r.reason,
    receiptNo: r.receipt_no,
    balanceAfter: r.balance_after,
    capturedById: r.captured_by,
    capturedByName: r.captured_by_name,
    createdAt: r.created_at,
    postedAt: r.posted_at,
  };
}

export async function loadDeposit(id: string): Promise<Deposit | null> {
  const result = await query<DepositRow>(`${DEPOSIT_SELECT} where t.id = $1`, [
    id,
  ]);
  return result.rows[0] ? assemble(result.rows[0]) : null;
}

// The account as the rules see it: its status, its holder's, and the type's
// switches and cap (S-1304).
interface Destination {
  id: string;
  status: string;
  memberId: string | null;
  customerId: string | null;
  holderStatus: string;
  typeName: string;
  allowsDeposit: boolean;
  maximumTransactionAmount: string | null;
}

async function destination(accountId: string): Promise<Destination> {
  const result = await query<{
    id: string;
    status: string;
    member_id: string | null;
    customer_id: string | null;
    holder_status: string;
    type_name: string;
    allows_deposit: boolean;
    maximum_transaction_amount: string | null;
  }>(
    `select a.id, a.status, a.member_id, a.customer_id,
            coalesce(m.status, c.status) as holder_status,
            at.name as type_name, at.allows_deposit,
            at.maximum_transaction_amount
       from account a
       join account_type at on at.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
      where a.id = $1`,
    [accountId]
  );
  const r = result.rows[0];
  if (!r) throw new DepositError('That account no longer exists.', 'not_found');
  return {
    id: r.id,
    status: r.status,
    memberId: r.member_id,
    customerId: r.customer_id,
    holderStatus: r.holder_status,
    typeName: r.type_name,
    allowsDeposit: r.allows_deposit,
    maximumTransactionAmount: r.maximum_transaction_amount,
  };
}

// Refused before anything is written, naming which rule (S-1305).
function refuseUnlessDepositable(to: Destination, amountCents: number): void {
  if (to.holderStatus !== 'active') {
    throw new DepositError(
      `This ${to.memberId ? 'member' : 'customer'} is ${to.holderStatus}, ` +
        'so no deposit can be taken.'
    );
  }
  if (to.status !== 'active') {
    throw new DepositError(
      `This account is ${to.status}, so no deposit can be taken on it.`
    );
  }
  if (!to.allowsDeposit) {
    throw new DepositError(`${to.typeName} does not accept deposits.`);
  }
  if (
    to.maximumTransactionAmount !== null &&
    amountCents > toCents(to.maximumTransactionAmount)
  ) {
    throw new DepositError(
      `A ${to.typeName} transaction cannot exceed ` +
        `${fromCents(toCents(to.maximumTransactionAmount))}.`
    );
  }
}

async function existingForKey(
  userId: string,
  key: string
): Promise<{ id: string; fingerprint: string } | null> {
  const result = await query<{ id: string; idempotency_fingerprint: string }>(
    `select id, idempotency_fingerprint from transaction
      where captured_by = $1 and idempotency_key = $2`,
    [userId, key]
  );
  const row = result.rows[0];
  return row ? { id: row.id, fingerprint: row.idempotency_fingerprint } : null;
}

export async function recordDeposit(
  input: DepositInput,
  principal: Principal
): Promise<Deposit> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new DepositError(
      'You do not have permission to record deposits.',
      'forbidden'
    );
  }

  let amountCents: number;
  try {
    amountCents = toCents(input.amount);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new DepositError('Enter the amount in rupees, e.g. 500.00.');
    }
    throw err;
  }
  if (amountCents <= 0) {
    throw new DepositError('The amount must be more than zero.');
  }

  // A retry is answered before it is judged: the original either posted or
  // it did not, and nothing about it is re-decided.
  const key = input.idempotencyKey?.trim() || null;
  const print = fingerprint(input, amountCents);
  if (key) {
    const existing = await existingForKey(principal.userId, key);
    if (existing) {
      if (existing.fingerprint !== print) {
        throw new DepositError(
          'A different deposit was already submitted with this key.',
          'conflict'
        );
      }
      return (await loadDeposit(existing.id))!;
    }
  }

  let method;
  try {
    method = await offeredMethod(input.method);
    requireReference(method, input.methodReference);
    await applyCashPaymentRules(
      method,
      amountCents,
      input.sourceOfFundFormConfirmed ?? false
    );
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new DepositError(err.message, err.reason);
    }
    throw err;
  }

  const to = await destination(input.accountId);
  refuseUnlessDepositable(to, amountCents);

  // Committed on its own, before the deposit's transaction, so a number
  // that never became a receipt is visible in the sequence rather than
  // silently reused (S-502, docs/payments.md).
  const receipt = await allocateReceiptNumber(principal.userId);
  const actor = { userId: principal.userId, description: principal.email };

  try {
    const id = await withTransaction(async client => {
      let inserted;
      try {
        inserted = await client.query<{ id: string }>(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              method_reference, reason, status, receipt_number_id,
              idempotency_key, idempotency_fingerprint, captured_by,
              source_of_fund_form_confirmed)
           values ('deposit', $1, $2, $3, $4, $5, $6, $7, 'submitted', $8,
                   $9, $10, $11, $12)
           returning id`,
          [
            to.memberId,
            to.customerId,
            to.id,
            fromCents(amountCents),
            method.code,
            (input.methodReference ?? '').trim() || null,
            (input.reason ?? '').trim() || null,
            receipt.id,
            key,
            key ? print : null,
            principal.userId,
            input.sourceOfFundFormConfirmed ?? false,
          ]
        );
      } catch (err) {
        // Two submissions of the same key at once: the index decides, and
        // the loser is told the same thing a later retry would be.
        if (
          (err as { code?: string }).code === '23505' &&
          (err as { constraint?: string }).constraint ===
            'transaction_idempotency_idx'
        ) {
          throw new DepositError('This deposit is being recorded.', 'conflict');
        }
        throw err;
      }
      const id = inserted.rows[0].id;
      await postTransaction(id, actor, client);
      await markReceiptIssued(receipt.id, client);
      return id;
    });
    return (await loadDeposit(id))!;
  } catch (err) {
    await abandonReceiptNumber(
      receipt.id,
      err instanceof DepositError || err instanceof LedgerError
        ? err.message
        : 'The deposit failed while being recorded.'
    );
    if (err instanceof LedgerError) {
      throw new DepositError(err.message, 'conflict');
    }
    throw err;
  }
}
