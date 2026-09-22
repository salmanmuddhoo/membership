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
import { recordAudit } from '../access/audit';
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
import { LedgerError } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';

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
// Posting directly, below the escalation threshold (FRD 6.3). A deposit the
// matrix routes nowhere (S-1401) is captured and posted in one act, and
// needs both permissions; one the matrix sends to a chain is only captured,
// and posting is the chain's last act (S-1403). So a Clerk can record a
// large deposit for review, and is told to fetch an Account Officer for a
// small one that would post at once.
export const PERMISSION_POST = 'transaction.post';

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
  // Where it waits on its chain (S-1401), null once posted or when the
  // matrix routed it nowhere.
  workflowDefinitionId: string | null;
  workflowName: string | null;
  currentStepCode: string | null;
  currentStepName: string | null;
  currentStepRole: string | null;
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
         t.created_at, t.posted_at,
         t.workflow_definition_id, wd.name as workflow_name, t.current_step_code,
         ws.name as current_step_name, wr.name as current_step_role
    from transaction t
    join account a on a.id = t.account_id
    join account_type at on at.id = a.account_type_id
    join payment_method pm on pm.code = t.method
    join app_user u on u.id = t.captured_by
    left join member m on m.id = t.member_id
    left join receipt_number rn on rn.id = t.receipt_number_id
    left join financial_event fe
      on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
    left join workflow_definition wd on wd.id = t.workflow_definition_id
    left join workflow_step ws
      on ws.definition_id = wd.id and ws.code = t.current_step_code
    left join role wr on wr.id = ws.role_id
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
  workflow_definition_id: string | null;
  workflow_name: string | null;
  current_step_code: string | null;
  current_step_name: string | null;
  current_step_role: string | null;
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
    workflowDefinitionId: r.workflow_definition_id,
    workflowName: r.workflow_name,
    currentStepCode: r.current_step_code,
    currentStepName: r.current_step_name,
    currentStepRole: r.current_step_role,
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
  accountTypeId: string;
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
    account_type_id: string;
    status: string;
    member_id: string | null;
    customer_id: string | null;
    holder_status: string;
    type_name: string;
    allows_deposit: boolean;
    maximum_transaction_amount: string | null;
  }>(
    `select a.id, a.account_type_id, a.status, a.member_id, a.customer_id,
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
    accountTypeId: r.account_type_id,
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

function parseAmount(amount: string): number {
  let amountCents: number;
  try {
    amountCents = toCents(amount);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new DepositError('Enter the amount in rupees, e.g. 500.00.');
    }
    throw err;
  }
  if (amountCents <= 0) {
    throw new DepositError('The amount must be more than zero.');
  }
  return amountCents;
}

// The method and the cash controls (S-1306, S-1307), refused in the
// deposit's own words.
async function checkedMethod(input: DepositInput, amountCents: number) {
  try {
    const method = await offeredMethod(input.method);
    requireReference(method, input.methodReference);
    await applyCashPaymentRules(
      method,
      amountCents,
      input.sourceOfFundFormConfirmed ?? false
    );
    return method;
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new DepositError(err.message, err.reason);
    }
    throw err;
  }
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
  const amountCents = parseAmount(input.amount);

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

  const method = await checkedMethod(input, amountCents);

  const to = await destination(input.accountId);
  refuseUnlessDepositable(to, amountCents);

  // The matrix decides before anything is written (S-1401): post at once,
  // or wait at the first step of a chain.
  const route = await resolveRoute({
    kind: 'deposit',
    accountTypeId: to.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new DepositError(
      'You may record a deposit but not post it. Ask an Account Officer to ' +
        'record it.',
      'forbidden'
    );
  }

  // A receipt is issued when the money posts. Allocated on its own, before
  // the deposit's transaction, so a number that never became a receipt is
  // visible in the sequence rather than silently reused (S-502,
  // docs/payments.md). A deposit going to a chain takes none yet.
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    const id = await withTransaction(async client => {
      let inserted;
      try {
        inserted = await client.query<{ id: string; reference: string }>(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              method_reference, reason, status, receipt_number_id,
              idempotency_key, idempotency_fingerprint, captured_by,
              source_of_fund_form_confirmed)
           values ('deposit', $1, $2, $3, $4, $5, $6, $7, 'submitted', $8,
                   $9, $10, $11, $12)
           returning id, reference`,
          [
            to.memberId,
            to.customerId,
            to.id,
            fromCents(amountCents),
            method.code,
            (input.methodReference ?? '').trim() || null,
            (input.reason ?? '').trim() || null,
            receipt?.id ?? null,
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
      const { id, reference } = inserted.rows[0];
      // Who captured it, on the trail, before who posted it (S-1311): the
      // segregation rules key on this row when posting or voiding is a
      // separate act by someone else.
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.captured',
          entityType: 'transaction',
          entityId: reference,
          newValue: {
            kind: 'deposit',
            account_id: to.id,
            amount: fromCents(amountCents),
            method: method.code,
          },
        },
        client
      );
      const submission = await submitTransaction(
        client,
        { id, reference, kind: 'deposit' },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
      return id;
    });
    // The member is sent their receipt once it exists (S-1602); a send that
    // fails is on the delivery log, never a failed deposit.
    if (receipt) await notifyReceiptIssued(id);
    return (await loadDeposit(id))!;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof DepositError || err instanceof LedgerError
          ? err.message
          : 'The deposit failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new DepositError(err.message, 'conflict');
    }
    throw err;
  }
}

export type DepositEdit = Omit<DepositInput, 'idempotencyKey'>;

/**
 * S-1404 · Correct a returned deposit and send it back. Its captor alone,
 * and only while it is `returned`: amount, method, reference, reason and
 * the account (one of the same holder's) may change; who captured it, and
 * its reference, never do. The old and new values go on the audit trail so
 * both versions are readable next to the comment that prompted the change.
 * Where it goes next is routing's decision (resubmitTransaction): back to
 * the step that returned it, or — the amount having crossed a band — the
 * route a first submission would take now, including posting at once.
 */
export async function resubmitDeposit(
  id: string,
  input: DepositEdit,
  principal: Principal
): Promise<Deposit> {
  const deposit = await loadDeposit(id);
  if (!deposit) {
    throw new DepositError('That deposit no longer exists.', 'not_found');
  }
  if (deposit.status !== 'returned') {
    throw new DepositError(
      `${deposit.reference} is ${deposit.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (deposit.capturedById !== principal.userId) {
    throw new DepositError(
      'Only the officer who recorded this deposit can change it.',
      'forbidden'
    );
  }
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new DepositError(
      'You do not have permission to record deposits.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);
  const method = await checkedMethod(input, amountCents);
  const to = await destination(input.accountId);
  if (
    to.memberId !== deposit.memberId ||
    to.customerId !== deposit.customerId
  ) {
    throw new DepositError('Choose one of this person’s accounts.');
  }
  refuseUnlessDepositable(to, amountCents);

  const route = await resolveRoute({
    kind: 'deposit',
    accountTypeId: to.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new DepositError(
      'At this amount the deposit would post at once, which you may not do. ' +
        'Ask an Account Officer to record it.',
      'forbidden'
    );
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set account_id = $2, amount = $3, method = $4,
                method_reference = $5, reason = $6,
                source_of_fund_form_confirmed = $7, receipt_number_id = $8
          where id = $1`,
        [
          deposit.id,
          to.id,
          fromCents(amountCents),
          method.code,
          (input.methodReference ?? '').trim() || null,
          (input.reason ?? '').trim() || null,
          input.sourceOfFundFormConfirmed ?? false,
          receipt?.id ?? null,
        ]
      );
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.resubmitted',
          entityType: 'transaction',
          entityId: deposit.reference,
          previousValue: {
            account_id: deposit.accountId,
            amount: deposit.amount,
            method: deposit.method,
            method_reference: deposit.methodReference || null,
            reason: deposit.reason || null,
          },
          newValue: {
            account_id: to.id,
            amount: fromCents(amountCents),
            method: method.code,
            method_reference: (input.methodReference ?? '').trim() || null,
            reason: (input.reason ?? '').trim() || null,
          },
        },
        client
      );
      const submission = await resubmitTransaction(
        client,
        {
          id: deposit.id,
          reference: deposit.reference,
          kind: 'deposit',
          workflowDefinitionId: deposit.workflowDefinitionId,
          currentStepCode: deposit.currentStepCode,
        },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(id);
    return (await loadDeposit(id))!;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof DepositError || err instanceof LedgerError
          ? err.message
          : 'The deposit failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new DepositError(err.message, 'conflict');
    }
    throw err;
  }
}
