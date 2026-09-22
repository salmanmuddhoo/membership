// A person's transactions across every account, and the Society's day
// (S-1506, FRD 6.9). One query, filterable, paginated; a transfer shows once
// — its credit leg is left out wherever its debit leg is already in the
// list, and only shows on its own for the person who received it.
import type { TransactionRowKind } from '../config/reference';
import { query } from '../db/pool';
import {
  assembleTransaction,
  TRANSACTION_SELECT,
  type TransactionRow,
  type TransactionSummary,
} from './review';

export interface HistoryFilter {
  memberId?: string;
  customerId?: string;
  accountId?: string;
  // Only what this officer recorded: the day's list for someone without
  // transaction.view_all.
  capturedBy?: string;
  kind?: TransactionRowKind;
  status?: string;
  // Inclusive dates, on when the transaction was recorded.
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface HistoryPage {
  transactions: TransactionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTransactions(
  filter: HistoryFilter = {}
): Promise<HistoryPage> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 200);
  const page = Math.max(filter.page ?? 1, 1);
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.memberId) where.push(`t.member_id = ${add(filter.memberId)}`);
  if (filter.customerId)
    where.push(`t.customer_id = ${add(filter.customerId)}`);
  if (filter.accountId) where.push(`t.account_id = ${add(filter.accountId)}`);
  if (filter.capturedBy)
    where.push(`t.captured_by = ${add(filter.capturedBy)}`);
  if (filter.kind) where.push(`t.kind = ${add(filter.kind)}`);
  if (filter.status) where.push(`t.status = ${add(filter.status)}`);
  if (filter.from) where.push(`t.created_at >= ${add(filter.from)}`);
  if (filter.to) where.push(`t.created_at <= ${add(filter.to)}`);
  // A transfer once: the credit leg is left out when its debit leg is in
  // the same list — the same holder, or no holder filter at all.
  where.push(
    filter.memberId || filter.customerId
      ? `not (t.leg_direction = 'credit' and exists (
            select 1 from transaction d
             where d.transfer_id = t.transfer_id and d.leg_direction = 'debit'
               and d.member_id is not distinct from t.member_id
               and d.customer_id is not distinct from t.customer_id))`
      : `t.leg_direction is distinct from 'credit'`
  );
  const clause = `where ${where.join(' and ')}`;

  const total = await query<{ n: string }>(
    `select count(*)::int as n from transaction t ${clause}`,
    params
  );
  const rows = await query<TransactionRow>(
    `${TRANSACTION_SELECT} ${clause}
      order by t.created_at desc, t.serial_no desc
      limit ${add(pageSize)} offset ${add((page - 1) * pageSize)}`,
    params
  );
  return {
    transactions: rows.rows.map(assembleTransaction),
    total: Number(total.rows[0]?.n ?? 0),
    page,
    pageSize,
  };
}
