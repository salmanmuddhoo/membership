// One account's posted entries, newest first, with a running balance
// (S-1309, S-1310) — the statement S-1601 later exports.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { accountEntries } from '@lib/ledger/ledger';
import { query } from '@lib/db/pool';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/history',
    summary: "Read one account's history",
    description:
      'Every posted entry on the account, newest first, each with the ' +
      'balance the account stood at once it had posted — computed from ' +
      'the entries themselves, so a statement built from this is exactly ' +
      'what the ledger says. Page backwards with `before`, the ' +
      '`sequenceNo` of the oldest entry on the page you have.',
    tag: 'Transactions',
    permission: 'payment.view',
    query: [
      {
        name: 'limit',
        description: 'Entries per page, 1 to 500. Default 50.',
        schema: { type: 'integer', minimum: 1, maximum: 500 },
      },
      {
        name: 'before',
        description: 'Return entries older than this sequence number.',
        schema: { type: 'integer' },
      },
    ],
    responseSchema: {
      type: 'object',
      required: ['entries', 'nextBefore'],
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'sequenceNo',
              'reference',
              'kind',
              'description',
              'direction',
              'amount',
              'currency',
              'runningBalance',
              'occurredAt',
              'postedAt',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              sequenceNo: { type: 'integer' },
              transactionId: { type: 'string', format: 'uuid' },
              reference: { type: 'string' },
              kind: { type: 'string' },
              description: { type: 'string' },
              direction: { type: 'string', enum: ['credit', 'debit'] },
              amount: { type: 'string' },
              currency: { type: 'string' },
              runningBalance: { type: 'string' },
              occurredAt: { type: 'string', format: 'date-time' },
              postedAt: { type: 'string', format: 'date-time' },
              methodName: { type: 'string' },
              methodReference: { type: 'string' },
              reason: { type: 'string' },
              receiptNo: { type: 'string', nullable: true },
              reversesReference: { type: 'string', nullable: true },
              capturedByName: { type: 'string' },
            },
          },
        },
        nextBefore: {
          type: 'integer',
          nullable: true,
          description:
            'Pass as `before` for the next page; null when this is the last.',
        },
      },
    },
  },
  async ({ context, correlationId }) => {
    const id = context.params.id;
    const exists = id
      ? await query('select 1 from account where id = $1', [id])
      : null;
    if (!exists?.rowCount) throw new ApiError('not_found');

    const url = new URL(context.request.url);
    const limitRaw = Number(url.searchParams.get('limit') ?? '50');
    const beforeRaw = url.searchParams.get('before');
    const limit = Number.isInteger(limitRaw) ? limitRaw : 50;
    const before =
      beforeRaw !== null && /^\d+$/.test(beforeRaw)
        ? Number(beforeRaw)
        : undefined;

    const entries = await accountEntries(id!, {
      limit,
      beforeSequenceNo: before,
    });
    const last = entries[entries.length - 1];
    return apiSuccess(
      {
        entries: entries.map(e => ({
          id: e.id,
          sequenceNo: e.sequenceNo,
          transactionId: e.transactionId,
          reference: e.transactionReference,
          kind: e.kind,
          description: e.description,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency,
          runningBalance: e.runningBalance,
          occurredAt: e.occurredAt.toISOString(),
          postedAt: e.postedAt.toISOString(),
          methodName: e.methodName,
          methodReference: e.methodReference,
          reason: e.reason,
          receiptNo: e.receiptNo,
          reversesReference: e.reversesReference,
          capturedByName: e.capturedByName,
        })),
        nextBefore: entries.length === limit && last ? last.sequenceNo : null,
      },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
