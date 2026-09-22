// One account's statement over a period (S-1604): the balance it opened
// and closed the period at, every entry between, and the totals — as JSON,
// or as the spreadsheet the officer downloads from the statement page.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { accountStatement } from '@lib/ledger/ledger';
import {
  statementFileName,
  statementPeriod,
  statementToWorkbook,
} from '@lib/ledger/statement';
import { XLSX_CONTENT_TYPE } from '@lib/reports/export';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/statement',
    summary: "Read one account's statement for a period",
    description:
      'The balance the account opened the period at, every entry posted ' +
      'in it with the balance after each, the totals in and out, and the ' +
      'closing balance — all read from the entries themselves. Dates are ' +
      'calendar days, inclusive; with neither given the period is the ' +
      'current month to date. `format=xlsx` returns the same as a ' +
      'spreadsheet.',
    tag: 'Transactions',
    permission: 'account.view',
    query: [
      {
        name: 'from',
        description: 'First day of the period, YYYY-MM-DD.',
        schema: { type: 'string', format: 'date' },
      },
      {
        name: 'to',
        description: 'Last day of the period, YYYY-MM-DD.',
        schema: { type: 'string', format: 'date' },
      },
      {
        name: 'format',
        description: '`xlsx` for a spreadsheet; JSON otherwise.',
        schema: { type: 'string', enum: ['json', 'xlsx'] },
      },
    ],
    responseSchema: {
      type: 'object',
      required: [
        'accountId',
        'accountNo',
        'accountTypeName',
        'holderName',
        'from',
        'to',
        'openingBalance',
        'closingBalance',
        'totalCredits',
        'totalDebits',
        'lines',
      ],
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        accountNo: { type: 'string' },
        accountTypeName: { type: 'string' },
        holderId: { type: 'string', format: 'uuid' },
        holderKind: { type: 'string', enum: ['member', 'customer'] },
        holderName: { type: 'string' },
        memberNo: { type: 'string', nullable: true },
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        openingBalance: { type: 'string' },
        closingBalance: { type: 'string' },
        totalCredits: { type: 'string' },
        totalDebits: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'sequenceNo',
              'transactionId',
              'reference',
              'postedAt',
              'description',
              'debit',
              'credit',
              'balance',
            ],
            properties: {
              sequenceNo: { type: 'integer' },
              transactionId: { type: 'string', format: 'uuid' },
              reference: { type: 'string' },
              postedAt: { type: 'string', format: 'date-time' },
              description: { type: 'string' },
              debit: { type: 'string', nullable: true },
              credit: { type: 'string', nullable: true },
              balance: { type: 'string' },
              receiptNo: { type: 'string', nullable: true },
              methodName: { type: 'string' },
              methodReference: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
  async ({ context, principal, correlationId }) => {
    const url = new URL(context.request.url);
    const period = statementPeriod({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    if (!period) {
      throw new ApiError('validation_failed', undefined, {
        period: [
          'from and to must be dates (YYYY-MM-DD), from no later than to',
        ],
      });
    }

    const statement = context.params.id
      ? await accountStatement(context.params.id, period.from, period.to)
      : null;
    if (!statement) throw new ApiError('not_found');

    if (url.searchParams.get('format') === 'xlsx') {
      const buffer = await statementToWorkbook(statement, {
        generatedAt: new Date(),
        generatedBy: principal.email,
      });
      return new Response(new Uint8Array(buffer), {
        headers: {
          'content-type': XLSX_CONTENT_TYPE,
          'content-disposition': `attachment; filename="${statementFileName(statement)}"`,
          'cache-control': 'private, no-store',
        },
      });
    }

    return apiSuccess(
      {
        ...statement,
        lines: statement.lines.map(line => ({
          ...line,
          postedAt: line.postedAt.toISOString(),
        })),
      },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
