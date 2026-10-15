// Every transaction, saved beside "Export members with balances" by the
// nightly backup (officer request, 15 October 2026), so that after a
// restore the history can come back as well as the balances.
//
// The members file already restores each account's balance. This one keeps
// how each balance came to be, laid out to be read back in:
//
//   Entries       the ledger itself — one row per account_entry, in posting
//                 order. An account's entries add up to its balance; that is
//                 the check a restore makes before it puts them back.
//   Transactions  every transaction whatever became of it (a request still
//                 waiting is here, though it moved no money), with all a
//                 restore needs to put it back: codes, receipt state, claimant.
//   Approvals     every step each one went through, who and when.
//   Accounts      each account's balance and entry count, to check against.
//
// An account is named the way the balances upload names it: its own number
// (HSA0001, INV0001) where it has one, otherwise the holder's AB number and
// the account type (Shares, MSA). Times are Mauritius time, as text, so a
// spreadsheet never shifts them. history.ts reads the file back: a column
// renamed here must be renamed there.
import ExcelJS from 'exceljs';
import { query } from '../db/pool';

const LOCAL = `'Indian/Mauritius'`;
const stamp = (column: string) =>
  `coalesce(to_char(${column} at time zone ${LOCAL}, 'YYYY-MM-DD HH24:MI:SS'), '')`;

// Holder and account, as both the members file and the balances upload
// name them.
const HOLDER_JOINS = `
  join account a on a.id = t_account_id
  join account_type at on at.id = a.account_type_id
  left join member m on m.id = a.member_id
  left join customer c on c.id = a.customer_id
  left join application_party hp
    on hp.application_id = coalesce(m.application_id, c.application_id)
   and hp.subject = 'applicant' and hp.ordinal = 1`;
const HOLDER_COLUMNS = `
  case when m.id is not null then 'Member' else 'Non-member' end as holder_kind,
  coalesce(m.member_no, c.legacy_code, '') as holder,
  trim(coalesce(hp.values->>'surname', '') || ' ' ||
       coalesce(hp.values->>'name', '')) as holder_name,
  coalesce(a.account_no, m.member_no, c.legacy_code, '') as account_number,
  at.name as account_type`;

// The kinds as the files name them. The restore reads them back
// (history.ts), so a label changed here is changed for both.
export const KIND_LABELS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};
const KIND = `case t.kind ${Object.entries(KIND_LABELS)
  .map(([code, label]) => `when '${code}' then '${label}'`)
  .join(' ')} else t.kind end`;

type Row = Record<string, string | number>;

function sheet(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: { header: string; key: string; width: number }[],
  rows: Row[]
): void {
  const ws = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
}

export interface TransactionsExport {
  buffer: Buffer;
  transactions: number;
  entries: number;
  accounts: number;
}

export async function exportTransactions(): Promise<TransactionsExport> {
  const entries = await query<Row>(
    `select e.sequence_no::text as sequence,
            ${stamp('e.posted_at')} as posted_at,
            t.reference, coalesce(tr.reference, '') as transfer,
            ${KIND} as kind,
            case when t.payment_line_id is not null
                   or t.payment_account_line_id is not null
                 then 'Yes' else '' end as opening,
            ${HOLDER_COLUMNS},
            case e.direction when 'credit' then 'In' else 'Out' end as direction,
            e.amount::float8 as amount,
            coalesce(rn.receipt_no, '') as receipt_no,
            coalesce(pm.name, t.method) as method,
            coalesce(t.method_reference, '') as method_reference,
            coalesce(ba.code, '') as bank_account,
            coalesce(t.reason, '') as reason,
            coalesce(t.payee_name, '') as payee,
            coalesce(o.reference, '') as reverses,
            coalesce(t.takaful_benefit::text, '') as takaful_benefit,
            coalesce(cu.display_name, cu.email, '') as captured_by,
            coalesce(pu.display_name, pu.email, '') as posted_by
       from account_entry e
       join transaction t on t.id = e.transaction_id
       ${HOLDER_JOINS.replace('t_account_id', 'e.account_id')}
       left join transfer tr on tr.id = t.transfer_id
       left join receipt_number rn on rn.id = t.receipt_number_id
       left join payment_method pm on pm.code = t.method
       left join bank_account ba on ba.id = t.bank_account_id
       left join transaction o on o.id = t.reverses_id
       left join app_user cu on cu.id = t.captured_by
       left join app_user pu on pu.id = t.posted_by
      order by e.sequence_no`
  );

  // Everything a restore needs to put a transaction back as it was.
  const transactions = await query<Row>(
    `select t.reference, coalesce(tr.reference, '') as transfer,
            ${KIND} as kind, t.status,
            case when t.payment_line_id is not null
                   or t.payment_account_line_id is not null
                 then 'Yes' else '' end as opening,
            ${HOLDER_COLUMNS},
            t.amount::float8 as amount,
            coalesce(pm.name, t.method) as method,
            t.method as method_code,
            coalesce(t.method_reference, '') as method_reference,
            coalesce(ba.code, '') as bank_account,
            coalesce(rn.receipt_no, '') as receipt_no,
            coalesce(rn.state, '') as receipt_status,
            case when rn.state = 'void' then coalesce(rn.reason, '') else '' end
              as receipt_void_reason,
            case when rn.state = 'void' then ${stamp('rn.settled_at')} else '' end
              as receipt_voided_at,
            coalesce(t.reason, '') as reason,
            coalesce(t.payee_name, '') as payee,
            coalesce(o.reference, '') as reverses,
            coalesce(t.takaful_benefit::text, '') as takaful_benefit,
            coalesce(t.claimant_kind, '') as claimant_kind,
            coalesce(t.claimant::text, '') as claimant,
            ${stamp('t.created_at')} as created_at,
            ${stamp('t.submitted_at')} as submitted_at,
            ${stamp('t.posted_at')} as posted_at,
            coalesce(cu.display_name, cu.email, '') as captured_by,
            coalesce(pu.display_name, pu.email, '') as posted_by
       from transaction t
       ${HOLDER_JOINS.replace('t_account_id', 't.account_id')}
       left join transfer tr on tr.id = t.transfer_id
       left join receipt_number rn on rn.id = t.receipt_number_id
       left join payment_method pm on pm.code = t.method
       left join bank_account ba on ba.id = t.bank_account_id
       left join transaction o on o.id = t.reverses_id
       left join app_user cu on cu.id = t.captured_by
       left join app_user pu on pu.id = t.posted_by
      order by t.serial_no`
  );

  const approvals = await query<Row>(
    `select t.reference, coalesce(s.from_status, '') as from_status,
            s.to_status, coalesce(s.step_code, '') as step,
            coalesce(u.display_name, u.email, '') as by_name,
            coalesce(s.actor_role, '') as role,
            coalesce(s.comment, '') as comment,
            ${stamp('s.occurred_at')} as occurred_at
       from transaction_transition s
       join transaction t on t.id = s.transaction_id
       left join app_user u on u.id = s.actor_user_id
      order by t.serial_no, s.id`
  );

  const accounts = await query<Row>(
    `select ${HOLDER_COLUMNS}, a.status,
            coalesce(b.balance, 0)::float8 as balance,
            coalesce(b.entry_count, 0)::int as entries
       from account a2
       ${HOLDER_JOINS.replace('t_account_id', 'a2.id')}
       left join account_balance b on b.account_id = a.id
      order by coalesce(m.member_no, c.legacy_code), at.sort_order, a.account_no`
  );

  const holder = [
    { header: 'Holder', key: 'holder', width: 12 },
    { header: 'Holder kind', key: 'holder_kind', width: 12 },
    { header: 'Holder name', key: 'holder_name', width: 30 },
    { header: 'Account Number', key: 'account_number', width: 15 },
    { header: 'Account Type', key: 'account_type', width: 22 },
  ];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Al Barakah MCSL';
  sheet(
    workbook,
    'Entries',
    [
      { header: 'Sequence', key: 'sequence', width: 10 },
      { header: 'Posted at', key: 'posted_at', width: 20 },
      { header: 'Reference', key: 'reference', width: 12 },
      { header: 'Transfer', key: 'transfer', width: 12 },
      { header: 'Kind', key: 'kind', width: 16 },
      { header: 'Opening balance', key: 'opening', width: 10 },
      ...holder,
      { header: 'Direction', key: 'direction', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Receipt No', key: 'receipt_no', width: 14 },
      { header: 'Method', key: 'method', width: 18 },
      { header: 'Method reference', key: 'method_reference', width: 18 },
      { header: 'Bank account', key: 'bank_account', width: 14 },
      { header: 'Reason', key: 'reason', width: 30 },
      { header: 'Payee', key: 'payee', width: 24 },
      { header: 'Reverses', key: 'reverses', width: 12 },
      { header: 'Takaful benefit', key: 'takaful_benefit', width: 14 },
      { header: 'Captured by', key: 'captured_by', width: 24 },
      { header: 'Posted by', key: 'posted_by', width: 24 },
    ],
    entries.rows
  );
  sheet(
    workbook,
    'Transactions',
    [
      { header: 'Reference', key: 'reference', width: 12 },
      { header: 'Transfer', key: 'transfer', width: 12 },
      { header: 'Kind', key: 'kind', width: 16 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Opening balance', key: 'opening', width: 10 },
      ...holder,
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Method', key: 'method', width: 18 },
      { header: 'Method code', key: 'method_code', width: 16 },
      { header: 'Method reference', key: 'method_reference', width: 18 },
      { header: 'Bank account', key: 'bank_account', width: 14 },
      { header: 'Receipt No', key: 'receipt_no', width: 14 },
      { header: 'Receipt status', key: 'receipt_status', width: 12 },
      { header: 'Receipt void reason', key: 'receipt_void_reason', width: 30 },
      { header: 'Receipt voided at', key: 'receipt_voided_at', width: 20 },
      { header: 'Reason', key: 'reason', width: 30 },
      { header: 'Payee', key: 'payee', width: 24 },
      { header: 'Reverses', key: 'reverses', width: 12 },
      { header: 'Takaful benefit', key: 'takaful_benefit', width: 14 },
      { header: 'Claimant kind', key: 'claimant_kind', width: 12 },
      { header: 'Claimant', key: 'claimant', width: 40 },
      { header: 'Created at', key: 'created_at', width: 20 },
      { header: 'Submitted at', key: 'submitted_at', width: 20 },
      { header: 'Posted at', key: 'posted_at', width: 20 },
      { header: 'Captured by', key: 'captured_by', width: 24 },
      { header: 'Posted by', key: 'posted_by', width: 24 },
    ],
    transactions.rows
  );
  sheet(
    workbook,
    'Approvals',
    [
      { header: 'Reference', key: 'reference', width: 12 },
      { header: 'From', key: 'from_status', width: 14 },
      { header: 'To', key: 'to_status', width: 14 },
      { header: 'Step', key: 'step', width: 18 },
      { header: 'By', key: 'by_name', width: 24 },
      { header: 'Role', key: 'role', width: 18 },
      { header: 'Comment', key: 'comment', width: 40 },
      { header: 'At', key: 'occurred_at', width: 20 },
    ],
    approvals.rows
  );
  sheet(
    workbook,
    'Accounts',
    [
      ...holder,
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Balance', key: 'balance', width: 14 },
      { header: 'Entries', key: 'entries', width: 10 },
    ],
    accounts.rows
  );

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    transactions: transactions.rowCount ?? 0,
    entries: entries.rowCount ?? 0,
    accounts: accounts.rowCount ?? 0,
  };
}
