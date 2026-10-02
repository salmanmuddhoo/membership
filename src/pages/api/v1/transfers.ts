// Record a transfer (S-1504, S-1308) — the API face of ledger/transfers.ts.
// One call, one idempotency key, for both legs.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import type { ErrorCode } from '@lib/api/envelope';
import {
  TransferError,
  recordTransfer,
  PERMISSION_CAPTURE,
  type TransferDestination,
} from '@lib/ledger/transfers';
import { transactionSchema } from './withdrawals';

const CODE_FOR: Record<TransferError['reason'], ErrorCode> = {
  invalid: 'validation_failed',
  not_found: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
};

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/transfers',
    summary: 'Record a transfer out of an account',
    description:
      'A transfer is to an account on the system, the holder’s own or ' +
      'another holder’s. Two legs under one id: a debit leg on the source, ' +
      'which meets every check a withdrawal does plus the type’s ' +
      'allows_transfer, and a credit leg on the destination, checked as a ' +
      'deposit is. Both post or neither. Money for someone with no account ' +
      'here is not a transfer: record a withdrawal and name who is paid ' +
      '(payeeName on POST /api/v1/withdrawals). The approval matrix reads ' +
      'every transfer under its own kind, whoever holds the destination. ' +
      'Below the band it posts at once, with a receipt; above it, it is ' +
      'submitted to its chain. Idempotent by the Idempotency-Key header.',
    tag: 'Transactions',
    permission: PERMISSION_CAPTURE,
    idempotent: true,
    requestSchema: {
      type: 'object',
      required: ['sourceAccountId', 'amount', 'destination'],
      properties: {
        sourceAccountId: { type: 'string', format: 'uuid' },
        amount: {
          type: 'string',
          description: 'Rupees with at most two decimals, e.g. "500.00".',
        },
        destination: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['account'] },
            accountId: {
              type: 'string',
              format: 'uuid',
              description: 'The destination account.',
            },
          },
        },
        reason: { type: 'string' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['transfer'],
      properties: {
        transfer: {
          type: 'object',
          required: ['id', 'reference', 'status', 'debitLeg'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string', description: 'TR-000001-style.' },
            status: { type: 'string' },
            reason: { type: 'string' },
            debitLeg: transactionSchema,
            creditLeg: { ...transactionSchema, nullable: true },
          },
        },
      },
    },
  },
  async ({ principal, correlationId, body, idempotencyKey }) => {
    const input = await body<{
      sourceAccountId?: unknown;
      amount?: unknown;
      destination?: {
        accountId?: unknown;
      };
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const raw = input.destination ?? {};
    const destination: TransferDestination = {
      kind: 'account',
      accountId: text(raw.accountId),
    };
    try {
      const transfer = await recordTransfer(
        {
          sourceAccountId: text(input.sourceAccountId),
          amount: text(input.amount),
          destination,
          reason: text(input.reason),
          idempotencyKey: idempotencyKey ?? undefined,
        },
        principal
      );
      return apiSuccess({ transfer }, correlationId);
    } catch (err) {
      if (err instanceof TransferError) {
        throw new ApiError(CODE_FOR[err.reason], err.message);
      }
      throw err;
    }
  }
);

export const descriptors = [create.descriptor];
export const POST: APIRoute = create.handler;
