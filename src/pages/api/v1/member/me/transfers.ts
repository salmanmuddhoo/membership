// Move money from one of the caller's own accounts to an account here
// (S-2102) — the staff transfer endpoint's own transaction, captured by the
// member app in the Member role.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { recordMemberTransfer } from '@lib/member/transactions';

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
    path: '/api/v1/member/me/transfers',
    summary: "Move money from one of the caller's accounts to an account here",
    description:
      'Recorded as the staff transfer is and routed by the approval ' +
      'matrix with Member as the initiating role; it waits on a chain, ' +
      'never posts at once. Refused (403) until the Society switches ' +
      'transfers from the app on. The destination is an account on the ' +
      "system, the caller's own or another member's, by id. 404 unless " +
      "the source is the caller's own.",
    tag: 'Transactions',
    caller: 'member',
    idempotent: true,
    requestSchema: {
      type: 'object',
      required: ['sourceAccountId', 'destinationAccountId', 'amount'],
      properties: {
        sourceAccountId: { type: 'string', format: 'uuid' },
        destinationAccountId: { type: 'string', format: 'uuid' },
        amount: {
          type: 'string',
          description: 'Rupees with at most two decimals, e.g. "500.00".',
        },
        reason: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['transfer'],
      properties: {
        transfer: {
          type: 'object',
          required: ['id', 'reference', 'status', 'debitLeg'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string', description: 'TR-000001-style.' },
            status: { type: 'string' },
            reason: { type: 'string' },
            debitLeg: transactionSchema,
            creditLeg: { ...transactionSchema, nullable: true },
          },
        },
      },
    },
  },
  async ({ member, correlationId, body, idempotencyKey }) => {
    const input = await body<{
      sourceAccountId?: unknown;
      destinationAccountId?: unknown;
      amount?: unknown;
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const transfer = await recordMemberTransfer(member, {
      sourceAccountId: text(input.sourceAccountId),
      destinationAccountId: text(input.destinationAccountId),
      amount: text(input.amount),
      reason: text(input.reason),
      idempotencyKey: idempotencyKey ?? undefined,
    });
    return apiSuccess({ transfer }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
