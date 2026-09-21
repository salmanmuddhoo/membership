// What has moved through one account, credit and debit (Members page
// feedback).
//
// A read-only stand-in for the transaction ledger this schema does not have
// yet ("later on we will have transaction where there will be deposit or
// withdrawal or transfer"): today the only things that can have happened to
// an account are the payment that opened it and, if the application was
// later refunded, the money paid back — so that is what this reports.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { transactionsForAccount } from '@lib/payments/payments';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/transactions',
    summary: "Read one account's credits and debits",
    description:
      'Every credit and debit recorded against this account, oldest ' +
      'first — not a running balance, and not a transaction history in ' +
      'the fuller sense: there is no ledger behind this account yet, only ' +
      'the payment that opened it and any refund paid back against it.',
    tag: 'Payments',
    permission: 'payment.view',
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
