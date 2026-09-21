// Record a deposit (S-1305, S-1308) — the API face of ledger/deposits.ts,
// for the officer's own screen and, from Phase 4, the mobile application's
// staff surface. It posts immediately: a deposit below the escalation
// threshold has no chain (FRD 6.2).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  DepositError,
  recordDeposit,
  PERMISSION_CAPTURE,
} from '@lib/ledger/deposits';

const CODE_FOR: Record<DepositError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const depositSchema = {
  type: 'object',
  required: [
    'id',
    'reference',
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
    kind: { type: 'string', enum: ['deposit'] },
    status: { type: 'string' },
    accountId: { type: 'string', format: 'uuid' },
    accountNo: { type: 'string' },
    accountTypeName: { type: 'string' },
    memberId: { type: 'string', format: 'uuid', nullable: true },
    customerId: { type: 'string', format: 'uuid', nullable: true },
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
    postedAt: { type: 'string', format: 'date-time', nullable: true },
    workflowName: {
      type: 'string',
      nullable: true,
      description: 'The approval chain it was routed to, if any.',
    },
    currentStepCode: { type: 'string', nullable: true },
    currentStepName: { type: 'string', nullable: true },
    currentStepRole: { type: 'string', nullable: true },
  },
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/deposits',
    summary: 'Record a deposit into an account',
    description:
      'Posts a deposit to the account through the ledger and issues its ' +
      'receipt, in one step. Refused, naming the rule, when the account or ' +
      'its holder is not active, the account type does not accept ' +
      'deposits, the amount exceeds the type’s per-transaction ' +
      'maximum, the method is not offered or needs a reference that is ' +
      'missing, or a cash amount breaches the cash controls. A deposit the ' +
      'approval matrix routes to a chain is submitted, not posted: status ' +
      '"submitted", no receipt yet, and the step it waits at. Idempotent by ' +
      'the Idempotency-Key header.',
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
          description: 'A payment_method code from /api/v1/config/reference.',
        },
        methodReference: {
          type: 'string',
          description: 'Required where the method says so.',
        },
        reason: { type: 'string' },
        sourceOfFundFormConfirmed: {
          type: 'boolean',
          description:
            'Required true for a cash deposit above the Source of Fund ' +
            'threshold.',
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['deposit'],
      properties: { deposit: depositSchema },
    },
  },
  async ({ principal, correlationId, body, idempotencyKey }) => {
    const input = await body<{
      accountId?: unknown;
      amount?: unknown;
      method?: unknown;
      methodReference?: unknown;
      reason?: unknown;
      sourceOfFundFormConfirmed?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    try {
      const deposit = await recordDeposit(
        {
          accountId: text(input.accountId),
          amount: text(input.amount),
          method: text(input.method),
          methodReference: text(input.methodReference),
          reason: text(input.reason),
          sourceOfFundFormConfirmed: input.sourceOfFundFormConfirmed === true,
          idempotencyKey: idempotencyKey ?? undefined,
        },
        principal
      );
      return apiSuccess({ deposit }, correlationId);
    } catch (err) {
      if (err instanceof DepositError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptors = [create.descriptor];
export const POST: APIRoute = create.handler;
