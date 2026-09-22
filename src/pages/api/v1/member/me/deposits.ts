// Pay into one of the caller's own accounts (S-2102) — the staff deposit
// endpoint's own transaction, captured by the member app in the Member role.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { recordMemberDeposit } from '@lib/member/transactions';

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
    postedAt: { type: 'string', format: 'date-time', nullable: true },
    workflowDefinitionId: { type: 'string', format: 'uuid', nullable: true },
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

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/me/deposits',
    summary: "Pay into one of the caller's accounts",
    description:
      'Recorded as the staff deposit is and routed by the approval matrix ' +
      'with Member as the initiating role; it waits on a chain, never ' +
      'posts at once. Refused (403) until the Society switches deposits ' +
      'from the app on. Cash is refused: choose a bank or mobile money ' +
      "method, with its reference and the Society's bank account from " +
      "/api/v1/member/reference. 404 unless the account is the caller's " +
      'own.',
    tag: 'Member app',
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
          description: 'A payment_method code.',
        },
        methodReference: { type: 'string' },
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
      required: ['deposit'],
      properties: { deposit: depositSchema },
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
    const deposit = await recordMemberDeposit(member, {
      accountId: text(input.accountId),
      amount: text(input.amount),
      method: text(input.method),
      methodReference: text(input.methodReference),
      bankAccountId: text(input.bankAccountId),
      reason: text(input.reason),
      idempotencyKey: idempotencyKey ?? undefined,
    });
    return apiSuccess({ deposit }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
