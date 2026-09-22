// One account's statement over a period (S-1604): the balance it opened
// and closed the period at, every entry between, and the totals — as JSON,
// or as the spreadsheet the officer downloads from the statement page. The
// shape lives in @lib/ledger/api-payloads.ts, shared with the member app
// (S-2101).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { accountStatement } from '@lib/ledger/ledger';
import {
  STATEMENT_DESCRIPTION,
  STATEMENT_QUERY,
  STATEMENT_SCHEMA,
  statementDownload,
  statementPayload,
  statementPeriodOrFail,
} from '@lib/ledger/api-payloads';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/statement',
    summary: "Read one account's statement for a period",
    description: STATEMENT_DESCRIPTION,
    tag: 'Transactions',
    permission: 'account.view',
    query: STATEMENT_QUERY,
    responseSchema: STATEMENT_SCHEMA,
  },
  async ({ context, principal, correlationId }) => {
    const params = new URL(context.request.url).searchParams;
    const period = statementPeriodOrFail(params);

    const statement = context.params.id
      ? await accountStatement(context.params.id, period.from, period.to)
      : null;
    if (!statement) throw new ApiError('not_found');

    if (params.get('format') === 'xlsx') {
      return statementDownload(statement, principal.email);
    }

    return apiSuccess(statementPayload(statement), correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
