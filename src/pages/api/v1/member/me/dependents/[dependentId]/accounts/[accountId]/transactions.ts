import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { dependentAccountTransactions } from '@lib/member/dependents';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/dependents/{dependentId}/accounts/{accountId}/transactions',
    summary: "A guarded minor's account: credits and debits, oldest first",
    description:
      "The entries behind a minor's balance, read-only. not_found unless the " +
      'caller guards the minor and the account is that minor’s.',
    tag: 'Accounts',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'occurredAt',
          'direction',
          'amount',
          'description',
          'receiptNo',
        ],
        properties: {
          id: { type: 'string' },
          occurredAt: { type: 'string', format: 'date-time' },
          direction: { type: 'string', enum: ['credit', 'debit'] },
          amount: { type: 'string' },
          description: { type: 'string' },
          receiptNo: { type: 'string', nullable: true },
        },
      },
    },
  },
  async ({ member, context, correlationId }) =>
    apiSuccess(
      await dependentAccountTransactions(
        member,
        String(context.params.dependentId ?? ''),
        String(context.params.accountId ?? '')
      ),
      correlationId
    )
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
