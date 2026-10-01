// Start a member's resignation (S-1703) — the API face of
// ledger/resignations.ts. What comes back is a draft: the signed request is
// filed against it and it is submitted from the resignation page, since
// the signature is the member's own act at the counter.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  ResignationError,
  startResignation,
  PERMISSION_CAPTURE,
} from '@lib/ledger/resignations';
import { transactionSchema } from '../../withdrawals';

const CODE_FOR: Record<ResignationError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/members/{id}/resignation',
    summary: "Start a member's resignation",
    description:
      'A draft resignation request (a transaction of kind "resignation" on ' +
      'the Shares account) covering every account of a membership-default ' +
      'type — Shares and the MSA, as one unit — with the reason and how ' +
      'the combined balance goes back to the member. Any other account the ' +
      'member holds is untouched. Refused for a member who is not active, ' +
      'while another request is already on its way, and when a core ' +
      'account is not active. The pre-checks (a transaction still on its ' +
      'way, unpaid joining fees, outstanding financing — each a ' +
      'configuration switch) are applied at submission, from the ' +
      'resignation page.',
    tag: 'Transactions',
    permission: PERMISSION_CAPTURE,
    requestSchema: {
      type: 'object',
      required: ['reason', 'method'],
      properties: {
        reason: { type: 'string', description: 'Why the member is leaving.' },
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
      required: ['resignation'],
      properties: { resignation: transactionSchema },
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
      const resignation = await startResignation(
        {
          memberId: context.params.id ?? '',
          reason: text(input.reason),
          method: text(input.method),
          methodReference: text(input.methodReference),
          bankAccountId: text(input.bankAccountId),
        },
        principal
      );
      return apiSuccess({ resignation }, correlationId);
    } catch (err) {
      if (err instanceof ResignationError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptor = create.descriptor;
export const POST: APIRoute = create.handler;
