// What has moved through one account, credit and debit (Members page
// feedback), oldest first — the ledger's own entries (S-1309) in the shape
// the Members list's dialogue has read since before there was a ledger.
// /history is the fuller read: newest first, paginated, with the running
// balance and the receipt.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { transactionsForAccount } from '@lib/payments/payments';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/transactions',
    summary: "Read one account's credits and debits",
    description:
      'Every posted entry on this account, oldest first, as a credit or a ' +
      'debit with a one-line description. For the running balance, the ' +
      'receipt and paging, use /accounts/{id}/history.',
    tag: 'Accounts',
    permission: 'account.view',
    responseSchema: {
      type: 'object',
      required: ['transactions'],
      properties: {
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'type',
              'amount',
              'currency',
              'occurredAt',
              'description',
            ],
            properties: {
              type: { type: 'string', enum: ['credit', 'debit'] },
              amount: { type: 'string' },
              currency: { type: 'string' },
              occurredAt: { type: 'string', format: 'date-time' },
              description: { type: 'string' },
            },
          },
        },
      },
    },
  },
  async ({ context, correlationId }) => {
    const id = context.params.id;
    if (!id) {
      throw new ApiError('not_found');
    }
    const transactions = await transactionsForAccount(id);
    return apiSuccess({ transactions }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
