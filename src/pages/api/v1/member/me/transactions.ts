// What the caller has asked for from the app, and where each stands
// (officer direction, October 2026; docs/member-app.md).
//
// Every deposit, withdrawal and transfer a member starts from the phone is
// validated by officers before money moves (migration 0120). Until then
// the member sees it here as "Pending approval", with who has it; after,
// as approved, completed, or not approved with the officer's reason.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { memberRequests } from '@lib/member/transactions';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/transactions',
    summary: 'The requests the caller made from the app',
    description:
      'Deposits, withdrawals and transfers the caller started from the ' +
      'app, newest first (fifty at most): a transfer once, from the ' +
      "caller's own account or a minor's in their care. state is " +
      'pending until officers decide ' +
      '(statusLabel "Pending approval", stage naming who has it), then ' +
      'approved (waiting to be recorded or paid out), completed, ' +
      "declined (reason: the officer's words), returned or cancelled.",
    tag: 'Transactions',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'reference',
          'kind',
          'state',
          'statusLabel',
          'stage',
          'amount',
          'currency',
          'accountId',
          'accountNo',
          'accountTypeName',
          'counterpartAccountNo',
          'counterpartAccountTypeName',
          'methodName',
          'forMinor',
          'note',
          'reason',
          'createdAt',
          'completedAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference: { type: 'string' },
          kind: { type: 'string', enum: ['deposit', 'withdrawal', 'transfer'] },
          state: {
            type: 'string',
            enum: [
              'pending',
              'approved',
              'completed',
              'declined',
              'returned',
              'cancelled',
            ],
          },
          statusLabel: { type: 'string' },
          stage: { type: 'string', nullable: true },
          amount: { type: 'string' },
          currency: { type: 'string' },
          accountId: { type: 'string', format: 'uuid' },
          accountNo: { type: 'string' },
          accountTypeName: { type: 'string' },
          counterpartAccountNo: { type: 'string', nullable: true },
          counterpartAccountTypeName: { type: 'string', nullable: true },
          methodName: { type: 'string', nullable: true },
          forMinor: {
            type: 'string',
            nullable: true,
            description:
              "The minor's name when it is on the account of a minor in " +
              "the caller's care; null on the caller's own.",
          },
          note: { type: 'string' },
          reason: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await memberRequests(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
