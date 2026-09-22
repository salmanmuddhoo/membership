// Start a deceased member's claim (S-1704) — the API face of
// ledger/demises.ts. What comes back is a draft: the death certificate and
// the affidavit are filed against it and it is submitted from the claim
// page.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  DemiseError,
  startDemise,
  PERMISSION_CAPTURE,
} from '@lib/ledger/demises';
import { transactionSchema } from '../../withdrawals';

const CODE_FOR: Record<DemiseError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/members/{id}/demise',
    summary: "Start a deceased member's claim",
    description:
      'A draft claim (a transaction of kind "demise") covering every ' +
      'account the member holds, paid to the claimant: the nominee the ' +
      'member named on their application, or another person given in ' +
      'full. The amount is every account’s balance plus the configured ' +
      'Takaful benefit as it stands; both are read again at submission and ' +
      'the balances again at the payout. Refused for a member who is not ' +
      'active, while another claim is already on its way, and when an ' +
      'account is not active. The death certificate and the affidavit are ' +
      'filed against the transaction and the claim submitted from its page.',
    tag: 'Transactions',
    permission: PERMISSION_CAPTURE,
    requestSchema: {
      type: 'object',
      required: ['claimant', 'method'],
      properties: {
        claimant: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['nominee', 'other'] },
            name: { type: 'string' },
            nic: { type: 'string' },
            address: { type: 'string' },
            relation: { type: 'string' },
          },
        },
        method: {
          type: 'string',
          description:
            'How it is paid out: a payment_method code from ' +
            '/api/v1/config/reference.',
        },
        methodReference: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['claim'],
      properties: { claim: transactionSchema },
    },
  },
  async ({ context, principal, correlationId, body }) => {
    const input = await body<{
      claimant?: {
        kind?: unknown;
        name?: unknown;
        nic?: unknown;
        address?: unknown;
        relation?: unknown;
      };
      method?: unknown;
      methodReference?: unknown;
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    try {
      const claim = await startDemise(
        {
          memberId: context.params.id ?? '',
          claimant: {
            kind:
              text(input.claimant?.kind) === 'nominee' ? 'nominee' : 'other',
            name: text(input.claimant?.name),
            nic: text(input.claimant?.nic),
            address: text(input.claimant?.address),
            relation: text(input.claimant?.relation),
          },
          method: text(input.method),
          methodReference: text(input.methodReference),
          reason: text(input.reason),
        },
        principal
      );
      return apiSuccess({ claim }, correlationId);
    } catch (err) {
      if (err instanceof DemiseError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptor = create.descriptor;
export const POST: APIRoute = create.handler;
