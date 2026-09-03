// What one account has actually received, and when (Members page feedback).
//
// A read-only stand-in for the transaction ledger this schema does not have
// yet ("later on we will have transaction where there will be deposit or
// withdrawal or transfer"): today the only money any account has ever
// received is its opening payment, so that is what this reports.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { depositForAccount } from '@lib/payments/payments';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/deposit',
    summary: "Read one account's opening deposit",
    description:
      'The amount and date of the payment that opened this account, if one ' +
      'has been recorded. Not a running balance — there is no transaction ' +
      'history behind this account yet, only the deposit that opened it.',
    tag: 'Payments',
    permission: 'payment.view',
    responseSchema: {
      type: 'object',
      properties: {
        deposit: {
          type: ['object', 'null'],
          required: ['amount', 'currency', 'depositedAt'],
          properties: {
            amount: { type: 'string' },
            currency: { type: 'string' },
            depositedAt: { type: 'string', format: 'date-time' },
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
    const deposit = await depositForAccount(id);
    return apiSuccess({ deposit }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
