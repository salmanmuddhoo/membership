// The account statement (S-1604, FRD 6.8): one account over a period, as a
// spreadsheet and as the period an officer asked for.
//
// The figures come from accountStatement() in ledger.ts, which reads them
// off the entries; this module only decides what a period means when half
// of it is missing, and how the rows go into a workbook. The printed
// statement is the page (/accounts/[id]/statement) through the browser's
// print, the same way a receipt is.
import { reportToWorkbook } from '../reports/export';
import type { Statement } from './ledger';

export interface StatementPeriod {
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: string | null): value is string {
  return value !== null && DAY.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The period a request asked for. Month to date when neither bound is
 * given, since that is what a member at the counter asks for; either bound
 * alone takes the other from it. Null when a bound is not a date, or the
 * period runs backwards.
 */
export function statementPeriod(
  params: { from: string | null; to: string | null },
  today = new Date()
): StatementPeriod | null {
  const day = today.toISOString().slice(0, 10);
  const from = params.from ?? '';
  const to = params.to ?? '';
  if ((from !== '' && !isDay(from)) || (to !== '' && !isDay(to))) return null;
  const period = {
    from:
      from !== ''
        ? from
        : to !== ''
          ? `${to.slice(0, 7)}-01`
          : `${day.slice(0, 7)}-01`,
    to: to !== '' ? to : from !== '' && from > day ? from : day,
  };
  return period.from <= period.to ? period : null;
}

export const STATEMENT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'reference', label: 'Reference' },
  { key: 'description', label: 'Description' },
  { key: 'method', label: 'Method' },
  { key: 'receipt', label: 'Receipt' },
  { key: 'debit', label: 'Out', numeric: true },
  { key: 'credit', label: 'In', numeric: true },
  { key: 'balance', label: 'Balance', numeric: true },
];

// Rows as the spreadsheet shows them: the opening balance first and the
// closing balance last, so the sheet reads as the printed one does and the
// figures reconcile without the reader adding anything up.
export function statementRows(
  statement: Statement
): Record<string, string | number | null>[] {
  const day = (at: Date) => at.toISOString().slice(0, 10);
  return [
    {
      date: statement.from,
      reference: null,
      description: 'Opening balance',
      method: null,
      receipt: null,
      debit: null,
      credit: null,
      balance: statement.openingBalance,
    },
    ...statement.lines.map(line => ({
      date: day(line.postedAt),
      reference: line.reference,
      description: line.reason
        ? `${line.description} · ${line.reason}`
        : line.description,
      method: line.methodReference
        ? `${line.methodName} · ${line.methodReference}`
        : line.methodName,
      receipt: line.receiptNo,
      debit: line.debit,
      credit: line.credit,
      balance: line.balance,
    })),
    {
      date: statement.to,
      reference: null,
      description: 'Closing balance',
      method: null,
      receipt: null,
      debit: statement.totalDebits,
      credit: statement.totalCredits,
      balance: statement.closingBalance,
    },
  ];
}

export async function statementToWorkbook(
  statement: Statement,
  context: { generatedAt: Date; generatedBy: string }
): Promise<Buffer> {
  const holder = [statement.holderName, statement.memberNo]
    .filter(Boolean)
    .join(' · ');
  return reportToWorkbook(
    `Statement ${statement.accountNo}`,
    {
      columns: STATEMENT_COLUMNS,
      rows: statementRows(statement),
      summary: `${holder} · ${statement.accountNo} · ${statement.accountTypeName}`,
    },
    {
      ...context,
      filters: `From ${statement.from} to ${statement.to}`,
    }
  );
}

export function statementFileName(statement: Statement): string {
  return `statement-${statement.accountNo}-${statement.from}-${statement.to}.xlsx`;
}
