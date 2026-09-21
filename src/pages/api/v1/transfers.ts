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
      'Two legs under one id: a debit leg on the source, which meets every ' +
      'check a withdrawal does plus the type’s allows_transfer, and — when ' +
      'the destination is an account on the system — a credit leg on it, ' +
      'checked as a deposit is. Both post or neither. A destination with no ' +
      'account here (a payee) has no credit leg: the debit leg names the ' +
      'payee and how it is paid out, and is disbursed once approved. The ' +
      'approval matrix reads a transfer between the same holder’s accounts ' +
      'under its own kind and any other under a withdrawal’s. Below the ' +
      'band it posts at once, with a receipt; above it, it is submitted to ' +
      'its chain. Idempotent by the Idempotency-Key header.',
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
            kind: { type: 'string', enum: ['account', 'payee'] },
            accountId: {
              type: 'string',
              format: 'uuid',
              description: 'With kind "account".',
            },
            payeeName: { type: 'string', description: 'With kind "payee".' },
            method: {
              type: 'string',
              description:
                'With kind "payee": how it is paid out, a payment_method ' +
                'code from /api/v1/config/reference.',
            },
            methodReference: {
              type: 'string',
              description:
                'Required where the method says so, when it posts at once.',
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
        kind?: unknown;
        accountId?: unknown;
        payeeName?: unknown;
        method?: unknown;
        methodReference?: unknown;
      };
      reason?: unknown;
    }>();
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const raw = input.destination ?? {};
    const destination: TransferDestination =
      raw.kind === 'payee'
        ? {
            kind: 'payee',
            payeeName: text(raw.payeeName),
            method: text(raw.method),
            methodReference: text(raw.methodReference),
          }
        : { kind: 'account', accountId: text(raw.accountId) };
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
