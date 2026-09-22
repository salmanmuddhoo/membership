// One account's posted entries, newest first, with a running balance
// (S-1309, S-1310) — the statement S-1601 later exports. The shape lives in
// @lib/ledger/api-payloads.ts, shared with the member app (S-2101).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { query } from '@lib/db/pool';
import {
  HISTORY_DESCRIPTION,
  HISTORY_QUERY,
  HISTORY_SCHEMA,
  historyPayload,
} from '@lib/ledger/api-payloads';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/history',
    summary: "Read one account's history",
    description: HISTORY_DESCRIPTION,
    tag: 'Transactions',
    permission: 'account.view',
    query: HISTORY_QUERY,
    responseSchema: HISTORY_SCHEMA,
  },
  async ({ context, correlationId }) => {
    const id = context.params.id;
    const exists = id
      ? await query('select 1 from account where id = $1', [id])
      : null;
    if (!exists?.rowCount) throw new ApiError('not_found');

    return apiSuccess(
      await historyPayload(id!, new URL(context.request.url).searchParams),
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
