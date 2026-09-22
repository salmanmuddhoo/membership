// One of the caller's own accounts: its statement for a period (S-2101).
// The shape is the staff endpoint's, from @lib/ledger/api-payloads.ts, so
// the app and the branch read one ledger the same way.
import type { APIRoute } from 'astro';
import {
  defineMemberEndpoint,
  apiSuccess,
  ApiError,
} from '@lib/member/endpoint';
import { ownedAccountId } from '@lib/member/profile';
import { accountStatement } from '@lib/ledger/ledger';
import {
  STATEMENT_DESCRIPTION,
  STATEMENT_QUERY,
  STATEMENT_SCHEMA,
  statementDownload,
  statementPayload,
  statementPeriodOrFail,
} from '@lib/ledger/api-payloads';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/accounts/{id}/statement',
    summary: "One of the caller's accounts: its statement for a period",
    description:
      STATEMENT_DESCRIPTION + " 404 unless the account is the caller's own.",
    tag: 'Member app',
    caller: 'member',
    query: STATEMENT_QUERY,
    responseSchema: STATEMENT_SCHEMA,
  },
  async ({ member, context, correlationId }) => {
    const params = new URL(context.request.url).searchParams;
    const period = statementPeriodOrFail(params);
    const id = await ownedAccountId(member, String(context.params.id ?? ''));
    const statement = await accountStatement(id, period.from, period.to);
    if (!statement) throw new ApiError('not_found');

    if (params.get('format') === 'xlsx') {
      return statementDownload(statement, member.mobile);
    }

    return apiSuccess(statementPayload(statement), correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
