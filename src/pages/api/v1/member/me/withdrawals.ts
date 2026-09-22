// Ask for money out of one of the caller's own accounts (S-2102) — the
// staff withdrawal endpoint's own transaction, captured by the member app
// in the Member role.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { recordMemberWithdrawal } from '@lib/member/transactions';

const transactionSchema = {
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
    bankAccountId: { type: 'string', format: 'uuid', nullable: true },
    bankAccountName: { type: 'string', nullable: true },
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
    claimantKind: {
      type: 'string',
      enum: ['nominee', 'other'],
      nullable: true,
      description: 'A demised claim’s claimant (S-1704).',
    },
    claimant: {
      type: 'object',
      nullable: true,
      properties: {
        name: { type: 'string' },
        nic: { type: 'string' },
        address: { type: 'string' },
        relation: { type: 'string' },
      },
    },
    takafulBenefit: {
      type: 'string',
      description:
        'The Takaful benefit a demised claim pays beside the balances; ' +
        '"0.00" on every other kind.',
    },
  },
};

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/me/withdrawals',
    summary: "Ask for money out of one of the caller's accounts",
    description:
      'Recorded as the staff withdrawal is and routed by the approval ' +
      'matrix with Member as the initiating role; it waits on a chain, ' +
      'never posts at once. Refused (403) until the Society switches ' +
      'withdrawals from the app on. The method is how it will be paid ' +
      'out, with its reference where the method requires one. 404 unless ' +
      "the account is the caller's own.",
    tag: 'Transactions',
    caller: 'member',
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
          description: 'How it is paid out: a payment_method code.',
        },
        methodReference: {
          type: 'string',
          description: 'Required where the method says so.',
        },
        bankAccountId: {
          type: 'string',
          format: 'uuid',
          description:
            "One of the Society's bank accounts from " +
            '/api/v1/member/reference. Required with the reference where ' +
            'the method touches a bank.',
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
  async ({ member, correlationId, body, idempotencyKey }) => {
    const input = await body<{
      accountId?: unknown;
      amount?: unknown;
      method?: unknown;
      methodReference?: unknown;
      bankAccountId?: unknown;
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const withdrawal = await recordMemberWithdrawal(member, {
      accountId: text(input.accountId),
      amount: text(input.amount),
      method: text(input.method),
      methodReference: text(input.methodReference),
      bankAccountId: text(input.bankAccountId),
      reason: text(input.reason),
      idempotencyKey: idempotencyKey ?? undefined,
    });
    return apiSuccess({ withdrawal }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
