// One of the caller's own accounts: its balance (S-2101). The shape is the
// staff endpoint's, from @lib/ledger/api-payloads.ts, so the app and the
// branch read one ledger the same way.
import type { APIRoute } from 'astro';
import {
  defineMemberEndpoint,
  apiSuccess,
  ApiError,
} from '@lib/member/endpoint';
import { ownedAccountId } from '@lib/member/profile';
import {
  BALANCE_DESCRIPTION,
  BALANCE_SCHEMA,
  balancePayload,
} from '@lib/ledger/api-payloads';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/accounts/{id}/balance',
    summary: "One of the caller's accounts: its balance",
    description:
      BALANCE_DESCRIPTION + " 404 unless the account is the caller's own.",
    tag: 'Accounts',
    caller: 'member',
    responseSchema: BALANCE_SCHEMA,
  },
  async ({ member, context, correlationId }) => {
    const id = await ownedAccountId(member, String(context.params.id ?? ''));
    const payload = await balancePayload(id);
    if (!payload) throw new ApiError('not_found');
    return apiSuccess(payload, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
