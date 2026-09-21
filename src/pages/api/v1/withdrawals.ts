// Record a withdrawal (S-1501, S-1308) — the API face of
// ledger/withdrawals.ts. Below the matrix band it is paid out and posted at
// once; above it, it is submitted to its chain and paid out once approved.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  WithdrawalError,
  recordWithdrawal,
  PERMISSION_CAPTURE,
} from '@lib/ledger/withdrawals';

const CODE_FOR: Record<WithdrawalError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

export const transactionSchema = {
  type: 'object',
  required: [
    'id',
    'reference',
    'kind',
    'status',
    'accountId',
    'accountNo',
    'accountTypeName',
    'amount',
    'currency',
    'method',
    'methodName',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    reference: { type: 'string', description: 'TX-000001-style.' },
    kind: { type: 'string' },
    status: { type: 'string' },
    accountId: { type: 'string', format: 'uuid' },
    accountNo: { type: 'string' },
    accountTypeId: { type: 'string', format: 'uuid' },
    accountTypeName: { type: 'string' },
    holderId: { type: 'string', format: 'uuid' },
    holderKind: { type: 'string', enum: ['member', 'customer'] },
    holderName: { type: 'string' },
    memberNo: { type: 'string', nullable: true },
    amount: { type: 'string' },
    currency: { type: 'string' },
    method: { type: 'string' },
    methodName: { type: 'string' },
    methodReference: { type: 'string' },
    reason: { type: 'string' },
    receiptNo: { type: 'string', nullable: true },
    balanceAfter: {
      type: 'string',
      nullable: true,
      description: 'What the account stood at once this posted.',
    },
    capturedById: { type: 'string', format: 'uuid' },
    capturedByName: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    submittedAt: { type: 'string', format: 'date-time', nullable: true },
    postedAt: { type: 'string', format: 'date-time', nullable: true },
    workflowDefinitionId: { type: 'string', format: 'uuid', nullable: true },
    workflowCode: { type: 'string', nullable: true },
    workflowName: {
      type: 'string',
      nullable: true,
      description: 'The approval chain it was routed to, if any.',
    },
    currentStepCode: { type: 'string', nullable: true },
    currentStepName: { type: 'string', nullable: true },
    currentStepRole: { type: 'string', nullable: true },
    approvalRuleId: { type: 'string', format: 'uuid', nullable: true },
    sourceOfFundFormConfirmed: { type: 'boolean' },
    transferId: { type: 'string', format: 'uuid', nullable: true },
    transferReference: { type: 'string', nullable: true },
    legDirection: {
      type: 'string',
      enum: ['credit', 'debit'],
      nullable: true,
    },
    payeeName: { type: 'string', nullable: true },
    counterpartAccountId: { type: 'string', format: 'uuid', nullable: true },
    counterpartAccountNo: { type: 'string', nullable: true },
    counterpartAccountTypeName: { type: 'string', nullable: true },
    counterpartHolderId: { type: 'string', format: 'uuid', nullable: true },
    counterpartHolderName: { type: 'string', nullable: true },
  },
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/withdrawals',
    summary: 'Record a withdrawal from an account',
    description:
      'Checks, in order, and refuses naming the first failure: the account ' +
      'is active and its type allows withdrawals; the holder is active; the ' +
      'available balance (balance less what is already on its way out) ' +
      'covers it; the balance after would not fall below the type’s floor; ' +
      'the amount is within the type’s per-transaction maximum. Then the ' +
      'approval matrix decides: below its band the withdrawal is paid out ' +
      'and posted at once, with a receipt, and the method’s reference is ' +
      'required now; above it, it is submitted to its chain (status ' +
      '"submitted", the step it waits at) and paid out once approved. ' +
      'Idempotent by the Idempotency-Key header.',
    tag: 'Transactions',
    permission: PERMISSION_CAPTURE,
    idempotent: true,
    requestSchema: {
      type: 'object',
      required: ['accountId', 'amount', 'method'],
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        amount: {
          type: 'string',
          description: 'Rupees with at most two decimals, e.g. "500.00".',
        },
        method: {
          type: 'string',
          description:
            'How it is paid out: a payment_method code from ' +
            '/api/v1/config/reference.',
        },
        methodReference: {
          type: 'string',
          description:
            'Required where the method says so, when it is paid out at once.',
        },
        reason: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['withdrawal'],
      properties: { withdrawal: transactionSchema },
    },
  },
  async ({ principal, correlationId, body, idempotencyKey }) => {
    const input = await body<{
      accountId?: unknown;
      amount?: unknown;
      method?: unknown;
      methodReference?: unknown;
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    try {
      const withdrawal = await recordWithdrawal(
        {
          accountId: text(input.accountId),
          amount: text(input.amount),
          method: text(input.method),
          methodReference: text(input.methodReference),
          reason: text(input.reason),
          idempotencyKey: idempotencyKey ?? undefined,
        },
        principal
      );
      return apiSuccess({ withdrawal }, correlationId);
    } catch (err) {
      if (err instanceof WithdrawalError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptors = [create.descriptor];
export const POST: APIRoute = create.handler;
