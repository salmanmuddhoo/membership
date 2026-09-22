// One account's balance, from the ledger's cache (S-1309, S-1310). The
// shape lives in @lib/ledger/api-payloads.ts, shared with the member app
// (S-2101).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import {
  BALANCE_DESCRIPTION,
  BALANCE_SCHEMA,
  balancePayload,
} from '@lib/ledger/api-payloads';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/balance',
    summary: "Read one account's balance",
    description: BALANCE_DESCRIPTION,
    tag: 'Transactions',
    permission: 'account.view',
    responseSchema: BALANCE_SCHEMA,
  },
  async ({ context, correlationId }) => {
    const payload = context.params.id
      ? await balancePayload(context.params.id)
      : null;
    if (!payload) throw new ApiError('not_found');
    return apiSuccess(payload, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
