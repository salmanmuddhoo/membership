// Start a closure request on an account (S-1702) — the API face of
// ledger/closures.ts. What comes back is a draft: the signed request is
// filed against it and it is submitted from the closure page, since the
// signature is the member's own act at the counter.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  ClosureError,
  startClosure,
  PERMISSION_CAPTURE,
} from '@lib/ledger/closures';
import { transactionSchema } from '../../withdrawals';

const CODE_FOR: Record<ClosureError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/accounts/{id}/closure',
    summary: 'Start a closure request on an account',
    description:
      'A draft closure request (a transaction of kind "closure") naming ' +
      'the reason and how the balance goes back to the holder. Refused for ' +
      'a membership account — Shares and the MSA go together, and taking ' +
      'them away is a resignation — for an account that is not active, for ' +
      'a holder who is not active, and while another request is already ' +
      'on its way for the account. The amount is the balance as it stands; ' +
      'it is read again at submission and at the payout. The signed ' +
      'request is filed against the transaction and the request submitted ' +
      'from the closure page.',
    tag: 'Transactions',
    permission: PERMISSION_CAPTURE,
    requestSchema: {
      type: 'object',
      required: ['reason', 'method'],
      properties: {
        reason: { type: 'string', description: 'Why the account is closing.' },
        method: {
          type: 'string',
          description:
            'How the balance is paid out: a payment_method code from ' +
            '/api/v1/config/reference.',
        },
        methodReference: { type: 'string' },
        bankAccountId: {
          type: 'string',
          format: 'uuid',
          description:
            "One of the Society's bank accounts. Required where the method " +
            'touches a bank, when it posts at once; otherwise given at ' +
            'disbursement.',
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['closure'],
      properties: { closure: transactionSchema },
    },
  },
  async ({ context, principal, correlationId, body }) => {
    const input = await body<{
      reason?: unknown;
      method?: unknown;
      methodReference?: unknown;
      bankAccountId?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    try {
      const closure = await startClosure(
        {
          accountId: context.params.id ?? '',
          reason: text(input.reason),
          method: text(input.method),
          methodReference: text(input.methodReference),
          bankAccountId: text(input.bankAccountId),
        },
        principal
      );
      return apiSuccess({ closure }, correlationId);
    } catch (err) {
      if (err instanceof ClosureError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptor = create.descriptor;
export const POST: APIRoute = create.handler;
