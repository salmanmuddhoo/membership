// One of the caller's own accounts: its history (S-2101). The shape is the
// staff endpoint's, from @lib/ledger/api-payloads.ts, so the app and the
// branch read one ledger the same way.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { ownedAccountId } from '@lib/member/profile';
import {
  HISTORY_DESCRIPTION,
  HISTORY_QUERY,
  HISTORY_SCHEMA,
  historyPayload,
} from '@lib/ledger/api-payloads';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/accounts/{id}/history',
    summary: "One of the caller's accounts: its history, newest first, paged",
    description:
      HISTORY_DESCRIPTION + " 404 unless the account is the caller's own.",
    tag: 'Accounts',
    caller: 'member',
    query: HISTORY_QUERY,
    responseSchema: HISTORY_SCHEMA,
  },
  async ({ member, context, correlationId }) => {
    const id = await ownedAccountId(member, String(context.params.id ?? ''));
    return apiSuccess(
      await historyPayload(id, new URL(context.request.url).searchParams),
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
