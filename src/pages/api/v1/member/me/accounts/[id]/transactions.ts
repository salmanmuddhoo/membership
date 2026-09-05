import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { accountTransactions } from '@lib/member/profile';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/accounts/{id}/transactions',
    summary: "One of the caller's accounts: credits and debits, oldest first",
    tag: 'Member app',
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
      await accountTransactions(member, String(context.params.id ?? '')),
      correlationId
    )
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
