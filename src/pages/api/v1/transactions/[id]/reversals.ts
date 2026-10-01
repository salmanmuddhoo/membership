// Reverse a posted transaction (S-1505, decision 12) — the API face of
// ledger/reversals.ts. The correction is a new transaction, never an edit.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  PERMISSION_REVERSE,
  ReversalError,
  reverseTransaction,
} from '@lib/ledger/reversals';
import { transactionSchema } from '../../withdrawals';

const CODE_FOR: Record<ReversalError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const endpoint = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/transactions/{id}/reversals',
    summary: 'Reverse a posted transaction',
    description:
      'Posts a reversing transaction that names this one: the opposite ' +
      'entry on the same account for the same amount, through the ledger, ' +
      'with its own receipt. The original stands. A transfer is reversed ' +
      'whole — both legs, or neither. Refused unless this transaction is ' +
      'posted and not already reversed, and refused to the officer who ' +
      'captured it. The reason is required.',
    tag: 'Transactions',
    permission: PERMISSION_REVERSE,
    requestSchema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
    },
    responseSchema: {
      type: 'object',
      required: ['reversals'],
      properties: {
        reversals: {
          type: 'array',
          description:
            'One for the transaction named; two for a transfer, its other ' +
            'leg second.',
          items: transactionSchema,
        },
      },
    },
  },
  async ({ context, principal, correlationId, body }) => {
    const id = context.params.id;
    if (!id) throw new ApiError('not_found');
    const input = await body<{ reason?: unknown }>();
    try {
      const result = await reverseTransaction(
        id,
        { reason: typeof input.reason === 'string' ? input.reason : '' },
        principal
      );
      return apiSuccess(result, correlationId);
    } catch (err) {
      if (err instanceof ReversalError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
