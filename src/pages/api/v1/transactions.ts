// A person's transactions across every account, or the Society's own list
// (S-1506) — the API face of ledger/history.ts.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { listTransactions } from '@lib/ledger/history';
import type { TransactionRowKind } from '@lib/config/reference';
import { transactionSchema } from './withdrawals';

const KINDS: TransactionRowKind[] = [
  'deposit',
  'withdrawal',
  'transfer_leg',
  'reversal',
  'closure',
];
const STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'posted',
  'returned',
  'rejected',
  'cancelled',
];

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/transactions',
    summary: 'List transactions',
    description:
      'Every transaction, newest first, paged. Filter by member or customer ' +
      '(across all their accounts), account, kind, status, and the dates it ' +
      'was recorded between (from, to; YYYY-MM-DD, inclusive). A transfer ' +
      'shows once: its credit leg is left out wherever its debit leg is in ' +
      'the same list, and shows on its own only for the person who received ' +
      'it. Query: member, customer, account, kind, status, from, to, page, ' +
      'pageSize (max 200).',
    tag: 'Transactions',
    permission: 'transaction.view',
    responseSchema: {
      type: 'object',
      required: ['transactions', 'total', 'page', 'pageSize'],
      properties: {
        transactions: { type: 'array', items: transactionSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
      },
    },
  },
  async ({ context, correlationId }) => {
    const params = context.url.searchParams;
    const text = (name: string) => params.get(name)?.trim() || undefined;
    const uuid = (name: string) => {
      const value = text(name);
      if (value && !/^[0-9a-f-]{36}$/i.test(value)) {
        throw new ApiError('validation_failed', undefined, {
          [name]: ['must be an id'],
        });
      }
      return value;
    };
    const date = (name: string, endOfDay: boolean) => {
      const value = text(name);
      if (!value) return undefined;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ApiError('validation_failed', undefined, {
          [name]: ['must be a date, YYYY-MM-DD'],
        });
      }
      return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
    };
    const kind = text('kind');
    if (kind && !KINDS.includes(kind as TransactionRowKind)) {
      throw new ApiError('validation_failed', undefined, {
        kind: [`must be one of ${KINDS.join(', ')}`],
      });
    }
    const status = text('status');
    if (status && !STATUSES.includes(status)) {
      throw new ApiError('validation_failed', undefined, {
        status: [`must be one of ${STATUSES.join(', ')}`],
      });
    }
    const page = Number(text('page') ?? '1');
    const pageSize = Number(text('pageSize') ?? '25');
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError('validation_failed', undefined, {
        page: ['must be a positive integer'],
      });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new ApiError('validation_failed', undefined, {
        pageSize: ['must be between 1 and 200'],
      });
    }
    const result = await listTransactions({
      memberId: uuid('member'),
      customerId: uuid('customer'),
      accountId: uuid('account'),
      kind: kind as TransactionRowKind | undefined,
      status,
      from: date('from', false),
      to: date('to', true),
      page,
      pageSize,
    });
    return apiSuccess(result, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
