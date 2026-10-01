// What an account's balance, history and statement look like on the wire
// (S-1310, S-1604, S-2101).
//
// The staff endpoints under /api/v1/accounts/{id} and the member's own under
// /api/v1/member/me/accounts/{id} return the same thing: a member reading
// their balance in the app and an officer reading it at the branch are
// looking at one ledger, and two shapes for it would drift the day one was
// touched. So the schema and the mapping live here once, and each endpoint
// decides only who may ask — the staff one by permission, the member one by
// ownership — before calling in.
import type { QueryParameter } from '../api/endpoint';
import { ApiError } from '../api/envelope';
import { query } from '../db/pool';
import {
  accountBalance,
  accountEntries,
  availableBalance,
  type Statement,
} from './ledger';
import {
  statementFileName,
  statementPeriod,
  statementToWorkbook,
  type StatementPeriod,
} from './statement';
import { XLSX_CONTENT_TYPE } from '../reports/export';

// --- Balance -----------------------------------------------------------------

export const BALANCE_DESCRIPTION =
  'The balance the ledger holds for the account: the sum of every ' +
  'posted entry, maintained by the engine as each one posts ' +
  '(docs/ledger.md). An account nothing has ever posted to reads as ' +
  '"0.00" with no entries. "available" is the balance less every ' +
  'withdrawal already submitted, under review or approved but not yet ' +
  'paid out — what a further withdrawal can draw on.';

export const BALANCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'accountId',
    'accountNo',
    'balance',
    'available',
    'currency',
    'entryCount',
  ],
  properties: {
    accountId: { type: 'string', format: 'uuid' },
    accountNo: { type: 'string' },
    accountTypeName: { type: 'string' },
    status: { type: 'string' },
    balance: { type: 'string' },
    pendingDebits: {
      type: 'string',
      description: 'Withdrawals on their way out, not yet posted.',
    },
    available: { type: 'string' },
    currency: { type: 'string' },
    entryCount: { type: 'integer' },
    asOfSequenceNo: { type: 'integer', nullable: true },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export interface BalancePayload {
  accountId: string;
  accountNo: string;
  accountTypeName: string;
  status: string;
  balance: string;
  pendingDebits: string;
  available: string;
  currency: string;
  entryCount: number;
  asOfSequenceNo: number | null;
  updatedAt: string | null;
}

/** The account's balance as the API says it, or null for no such account. */
export async function balancePayload(
  accountId: string
): Promise<BalancePayload | null> {
  const account = await query<{
    account_no: string;
    type_name: string;
    status: string;
  }>(
    `select coalesce(a.account_no, m.member_no) as account_no,
            t.name as type_name, a.status
       from account a
       join account_type t on t.id = a.account_type_id
       left join member m on m.id = a.member_id
      where a.id = $1`,
    [accountId]
  );
  if (!account.rows[0]) return null;
  const [balance, available] = await Promise.all([
    accountBalance(accountId),
    availableBalance(accountId),
  ]);
  return {
    accountId,
    accountNo: account.rows[0].account_no,
    accountTypeName: account.rows[0].type_name,
    status: account.rows[0].status,
    balance: balance?.balance ?? '0.00',
    pendingDebits: available.pendingDebits,
    available: available.available,
    currency: 'MUR',
    entryCount: balance?.entryCount ?? 0,
    asOfSequenceNo: balance?.asOfSequenceNo ?? null,
    updatedAt: balance?.updatedAt.toISOString() ?? null,
  };
}

// --- History -----------------------------------------------------------------

export const HISTORY_DESCRIPTION =
  'Every posted entry on the account, newest first, each with the ' +
  'balance the account stood at once it had posted — computed from ' +
  'the entries themselves, so a statement built from this is exactly ' +
  'what the ledger says. Page backwards with `before`, the ' +
  '`sequenceNo` of the oldest entry on the page you have.';

export const HISTORY_QUERY: QueryParameter[] = [
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
];

export const HISTORY_SCHEMA: Record<string, unknown> = {
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
};

export interface HistoryPayload {
  entries: {
    id: string;
    sequenceNo: number;
    transactionId: string;
    reference: string;
    kind: string;
    description: string;
    direction: 'credit' | 'debit';
    amount: string;
    currency: string;
    runningBalance: string;
    occurredAt: string;
    postedAt: string;
    methodName: string;
    methodReference: string;
    reason: string;
    receiptNo: string | null;
    reversesReference: string | null;
    capturedByName: string;
  }[];
  nextBefore: number | null;
}

/**
 * One page of the account's history, newest first, as the API says it.
 * The caller has already established the account exists and may be read.
 */
export async function historyPayload(
  accountId: string,
  params: URLSearchParams
): Promise<HistoryPayload> {
  const limitRaw = Number(params.get('limit') ?? '50');
  const beforeRaw = params.get('before');
  const limit = Number.isInteger(limitRaw) ? limitRaw : 50;
  const before =
    beforeRaw !== null && /^\d+$/.test(beforeRaw)
      ? Number(beforeRaw)
      : undefined;

  const entries = await accountEntries(accountId, {
    limit,
    beforeSequenceNo: before,
  });
  const last = entries[entries.length - 1];
  return {
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
  };
}

// --- Statement ---------------------------------------------------------------

export const STATEMENT_DESCRIPTION =
  'The balance the account opened the period at, every entry posted ' +
  'in it with the balance after each, the totals in and out, and the ' +
  'closing balance — all read from the entries themselves. Dates are ' +
  'calendar days, inclusive; with neither given the period is the ' +
  'current month to date. `format=xlsx` returns the same as a ' +
  'spreadsheet.';

export const STATEMENT_QUERY: QueryParameter[] = [
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
];

export const STATEMENT_SCHEMA: Record<string, unknown> = {
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
};

/** The period asked for, or the refusal the API gives for a bad one. */
export function statementPeriodOrFail(
  params: URLSearchParams
): StatementPeriod {
  const period = statementPeriod({
    from: params.get('from'),
    to: params.get('to'),
  });
  if (!period) {
    throw new ApiError('validation_failed', undefined, {
      period: ['from and to must be dates (YYYY-MM-DD), from no later than to'],
    });
  }
  return period;
}

export type StatementPayload = Omit<Statement, 'lines'> & {
  lines: (Omit<Statement['lines'][number], 'postedAt'> & {
    postedAt: string;
  })[];
};

export function statementPayload(statement: Statement): StatementPayload {
  return {
    ...statement,
    lines: statement.lines.map(line => ({
      ...line,
      postedAt: line.postedAt.toISOString(),
    })),
  };
}

/** The statement as a spreadsheet download, for `format=xlsx`. */
export async function statementDownload(
  statement: Statement,
  generatedBy: string
): Promise<Response> {
  const buffer = await statementToWorkbook(statement, {
    generatedAt: new Date(),
    generatedBy,
  });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': XLSX_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${statementFileName(statement)}"`,
      'cache-control': 'private, no-store',
    },
  });
}
