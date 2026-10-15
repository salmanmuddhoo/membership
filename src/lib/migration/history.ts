// Restoring transaction history from the nightly backup's transactions file
// (officer request, 15 October 2026; transactions-backup.ts writes it).
//
// The order of a restore: the members file through the members import,
// which brings every account back with one opening balance — its balance on
// the night of the backup — then this file, which puts the history behind
// that figure (restore_transaction_history, migration 0130). Original dates,
// TX/TR/RCT numbers and approval steps; balances end exactly where the
// import left them.
//
// Everything is checked here first and the whole file refused on one
// problem, as the members import does. Above all, each account's entries in
// the file must add up to what it holds now: that is what shows the two
// files are from the same night. Only posted transactions come back — a
// request still waiting, returned or turned down moved no money, and its
// approval chain cannot be picked up again.
//
// Staff are matched by name (or email). Someone not found here — a staff
// account the reset removed and nobody added back — is recorded as the
// migration service account, and named on the outcome.
import ExcelJS from 'exceljs';
import { query, withTransaction } from '../db/pool';
import { fromCents, toCents } from '../payments/money';
import { runningBatch } from './batches';
import { MigrationError, PERMISSION_MIGRATE, objectCellText } from './members';
import { KIND_LABELS } from './transactions-backup';

interface Actor {
  userId: string;
  email: string;
}

type Cells = Record<string, string>;
interface SheetRow {
  rowNumber: number;
  cells: Cells;
}

export interface HistoryFile {
  entries: SheetRow[];
  transactions: SheetRow[];
  approvals: SheetRow[];
}

export interface HistoryOutcome {
  transactions: number;
  entries: number;
  transfers: number;
  approvals: number;
  accounts: number;
  // In the file but never posted: not brought back.
  notPosted: number;
  // Names in the file with no staff account here.
  unknownStaff: string[];
}

const ENTRY_COLUMNS = [
  'reference',
  'posted at',
  'holder',
  'account number',
  'account type',
  'direction',
  'amount',
];
const TRANSACTION_COLUMNS = [
  'reference',
  'transfer',
  'kind',
  'status',
  'opening balance',
  'holder',
  'account number',
  'account type',
  'amount',
  'method code',
  'method reference',
  'bank account',
  'receipt no',
  'receipt status',
  'receipt void reason',
  'receipt voided at',
  'reason',
  'payee',
  'reverses',
  'takaful benefit',
  'claimant kind',
  'claimant',
  'created at',
  'submitted at',
  'posted at',
  'captured by',
  'posted by',
];

function readSheet(sheet: ExcelJS.Worksheet): SheetRow[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, n) => {
    headers[n] = objectCellText(cell.value).trim().toLowerCase();
  });
  const rows: SheetRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Cells = {};
    let any = false;
    headers.forEach((h, n) => {
      if (!h) return;
      const text = objectCellText(row.getCell(n).value);
      cells[h] = text;
      if (text !== '') any = true;
    });
    if (any) rows.push({ rowNumber, cells });
  });
  return rows;
}

function missingColumns(sheet: ExcelJS.Worksheet, wanted: string[]): string[] {
  const present = new Set<string>();
  sheet.getRow(1).eachCell(cell => {
    present.add(objectCellText(cell.value).trim().toLowerCase());
  });
  return wanted.filter(c => !present.has(c));
}

/** The three sheets of a transactions backup. */
export async function parseHistoryFile(buffer: Buffer): Promise<HistoryFile> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new MigrationError('That file is not an Excel workbook (.xlsx).');
  }
  const entries = workbook.getWorksheet('Entries');
  const transactions = workbook.getWorksheet('Transactions');
  if (!entries || !transactions) {
    throw new MigrationError(
      'That is not a transactions backup: it has no Entries and Transactions sheets.'
    );
  }
  const missing = [
    ...missingColumns(entries, ENTRY_COLUMNS),
    ...missingColumns(transactions, TRANSACTION_COLUMNS),
  ];
  if (missing.length > 0) {
    throw new MigrationError(
      `That backup is missing columns the restore needs (${[...new Set(missing)].join(', ')}). Use a newer backup.`
    );
  }
  const approvals = workbook.getWorksheet('Approvals');
  return {
    entries: readSheet(entries),
    transactions: readSheet(transactions),
    approvals: approvals ? readSheet(approvals) : [],
  };
}

// "TX-000123" -> 123.
function serialOf(text: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(text.trim());
  return match ? Number(match[1]) : null;
}

// The file's Mauritius time, as an instant.
function instantOf(text: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text.trim());
  return match ? `${match[1]}T${match[2]}+04:00` : null;
}

function cents(text: string): number | null {
  try {
    return toCents(text.trim() === '' ? '0' : text.trim());
  } catch {
    return null;
  }
}

interface AccountHere {
  id: string;
  account_no: string | null;
  holder: string | null;
  member_id: string | null;
  customer_id: string | null;
  type_name: string;
  balance: string;
  transactions: number;
  // The receipt of the import's opening balance, where there is one.
  opening_receipt_id: string | null;
}

function accountKey(cells: Cells): { key: string; label: string } {
  const number = cells['account number'].trim().toUpperCase();
  const holder = cells['holder'].trim().toUpperCase();
  const type = cells['account type'].trim();
  if (number !== '' && number !== holder) {
    return { key: `no:${number}`, label: number };
  }
  return {
    key: `holder:${holder}|${type.toLowerCase()}`,
    label: `${holder} ${type}`,
  };
}

interface Plan {
  problems: string[];
  payload: Record<string, unknown>;
  outcome: HistoryOutcome;
}

const KIND_CODES = new Map(
  Object.entries(KIND_LABELS).map(([code, label]) => [label, code])
);

/**
 * Everything checked, and what the database is to be given. Nothing is
 * written.
 */
export async function planHistory(file: HistoryFile): Promise<Plan> {
  const problems: string[] = [];

  const busy = await query<{ busy: boolean }>(
    `select exists (
              select 1
                from transaction t
                left join payment_line pl on pl.id = t.payment_line_id
                left join payment_account_line pal
                  on pal.id = t.payment_account_line_id
                left join payment p on p.id = coalesce(pl.payment_id, pal.payment_id)
               where p.id is null or p.method <> 'migration'
                  or p.voided_at is not null)
         or exists (select 1 from transfer)
         or exists (
              select 1 from receipt_number r
               where not exists (
                   select 1 from payment p
                    where p.receipt_number_id = r.id
                      and p.method = 'migration')) as busy`
  );
  if (busy.rows[0].busy) {
    throw new MigrationError(
      'Transactions have been recorded here since the members were imported, so history cannot be restored over them.'
    );
  }

  const accounts = await query<AccountHere>(
    `select a.id, a.account_no, coalesce(m.member_no, c.legacy_code) as holder,
            a.member_id, a.customer_id, ty.name as type_name,
            coalesce(b.balance, 0)::text as balance,
            (select count(*) from transaction t where t.account_id = a.id)::int
              as transactions,
            (select t.receipt_number_id from transaction t
              where t.account_id = a.id limit 1) as opening_receipt_id
       from account a
       join account_type ty on ty.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
       left join account_balance b on b.account_id = a.id`
  );
  const byKey = new Map<string, AccountHere>();
  for (const a of accounts.rows) {
    if (a.account_no) {
      byKey.set(`no:${a.account_no.toUpperCase()}`, a);
    } else if (a.holder) {
      byKey.set(
        `holder:${a.holder.toUpperCase()}|${a.type_name.toLowerCase()}`,
        a
      );
    }
  }
  const missingAccounts = new Set<string>();
  const resolve = (cells: Cells) => {
    const { key, label } = accountKey(cells);
    const account = byKey.get(key) ?? null;
    if (!account) missingAccounts.add(label);
    return { account, label };
  };

  const staff = await query<{
    id: string;
    display_name: string | null;
    email: string;
    entra_subject: string | null;
  }>(`select id, display_name, email, entra_subject from app_user`);
  const system = staff.rows.find(u => u.entra_subject === 'system:migration');
  if (!system) {
    throw new Error('The system:migration service account is missing.');
  }
  const named = new Map<string, string[]>();
  for (const u of staff.rows) {
    for (const name of [u.display_name, u.email]) {
      if (!name) continue;
      const key = name.trim().toLowerCase();
      named.set(key, [...new Set([...(named.get(key) ?? []), u.id])]);
    }
  }
  const unknownStaff = new Set<string>();
  const person = (name: string) => {
    const ids = named.get(name.trim().toLowerCase());
    if (ids?.length === 1) return ids[0];
    if (name.trim() !== '') unknownStaff.add(name.trim());
    return system.id;
  };

  const methods = new Set(
    (await query<{ code: string }>(`select code from payment_method`)).rows.map(
      r => r.code
    )
  );
  const banks = new Map(
    (
      await query<{ id: string; code: string }>(
        `select id, code from bank_account`
      )
    ).rows.map(r => [r.code.toUpperCase(), r.id])
  );

  // The transactions, by number; the highest of every number the file used.
  const max = { transaction: 0, receipt: 0, transfer: 0 };
  interface Tx {
    row: SheetRow;
    serial: number;
    opening: boolean;
    account: AccountHere | null;
    label: string;
  }
  const posted = new Map<number, Tx>();
  let notPosted = 0;
  for (const row of file.transactions) {
    const c = row.cells;
    const serial = serialOf(c['reference'], 'TX');
    if (serial === null) {
      problems.push(
        `Transactions row ${row.rowNumber}: ${c['reference'] || 'the reference'} is not a TX number.`
      );
      continue;
    }
    max.transaction = Math.max(max.transaction, serial);
    max.receipt = Math.max(max.receipt, serialOf(c['receipt no'], 'RCT') ?? 0);
    max.transfer = Math.max(max.transfer, serialOf(c['transfer'], 'TR') ?? 0);
    if (c['status'] !== 'posted') {
      notPosted += 1;
      continue;
    }
    const { account, label } = resolve(c);
    posted.set(serial, {
      row,
      serial,
      opening: c['opening balance'] === 'Yes',
      account,
      label,
    });
  }

  // The entries, account by account.
  interface Entry {
    serial: number;
    account: AccountHere;
    label: string;
    direction: 'credit' | 'debit';
    cents: number;
    postedAt: string;
  }
  const entries: Entry[] = [];
  const byAccount = new Map<string, Entry[]>();
  const labels = new Map<string, string>();
  for (const row of file.entries) {
    const c = row.cells;
    const at = `Entries row ${row.rowNumber}`;
    const serial = serialOf(c['reference'], 'TX');
    const tx = serial === null ? undefined : posted.get(serial);
    if (!tx) {
      problems.push(
        `${at}: ${c['reference'] || 'the reference'} is not a posted transaction in the Transactions sheet.`
      );
      continue;
    }
    const { account, label } = resolve(c);
    const amount = cents(c['amount']);
    const postedAt = instantOf(c['posted at']);
    const direction =
      c['direction'] === 'In'
        ? 'credit'
        : c['direction'] === 'Out'
          ? 'debit'
          : null;
    if (amount === null || amount <= 0) {
      problems.push(`${at}: ${c['amount'] || 'the amount'} is not an amount.`);
    }
    if (!postedAt) problems.push(`${at}: Posted at is not a date and time.`);
    if (!direction) problems.push(`${at}: Direction must be In or Out.`);
    if (!account || amount === null || amount <= 0 || !postedAt || !direction) {
      continue;
    }
    const entry = {
      serial: serial!,
      account,
      label,
      direction,
      cents: amount,
      postedAt,
    } as Entry;
    entries.push(entry);
    byAccount.set(account.id, [...(byAccount.get(account.id) ?? []), entry]);
    labels.set(account.id, label);
  }

  for (const label of [...missingAccounts].sort()) {
    problems.push(`${label} is not on file.`);
  }

  // Each account's entries add up to what it holds now — and an account
  // holding money has entries.
  const signed = (e: Entry) => (e.direction === 'credit' ? e.cents : -e.cents);
  const balances: { account_id: string; balance: string; label: string }[] = [];
  for (const a of accounts.rows) {
    const list = byAccount.get(a.id) ?? [];
    const here = toCents(a.balance);
    const label =
      labels.get(a.id) ?? a.account_no ?? `${a.holder} ${a.type_name}`;
    const inFile = list.reduce((sum, e) => sum + signed(e), 0);
    if (list.length === 0 && here === 0 && a.transactions === 0) continue;
    if (inFile !== here) {
      problems.push(
        list.length === 0
          ? `${label} holds ${fromCents(here)} here, and the file has no entries for it.`
          : `${label} holds ${fromCents(here)} here, but its entries in the file add up to ${fromCents(inFile)}.`
      );
    }
    if (a.transactions > 1) {
      problems.push(`${label} has more than one opening balance here.`);
    }
    balances.push({ account_id: a.id, balance: fromCents(here), label });
  }

  // Openings: where the import carried one, it becomes the account's
  // original opening, numbered and dated as the first one was; the
  // transactions it stands for are not inserted again. Where it carried
  // none, the opening transactions come back as they were.
  const folded = new Map<number, number>(); // opening TX -> the TX it became
  const openings: Record<string, unknown>[] = [];
  // The import's receipt -> the receipt numbers its openings first had.
  const originalReceipts = new Map<string, Set<number | null>>();
  for (const a of accounts.rows) {
    if (a.transactions !== 1) continue;
    const label =
      labels.get(a.id) ?? a.account_no ?? `${a.holder} ${a.type_name}`;
    const opening = (byAccount.get(a.id) ?? []).filter(
      e => posted.get(e.serial)!.opening
    );
    const net = opening.reduce((sum, e) => sum + signed(e), 0);
    if (net < 0) {
      problems.push(`${label} opens below zero in the file.`);
      continue;
    }
    if (net === 0) {
      openings.push({ account_id: a.id, amount: '0', label });
      continue;
    }
    const first = opening.find(e => e.direction === 'credit')!;
    for (const e of opening) folded.set(e.serial, first.serial);
    if (a.opening_receipt_id) {
      const wanted = originalReceipts.get(a.opening_receipt_id) ?? new Set();
      wanted.add(
        serialOf(posted.get(first.serial)!.row.cells['receipt no'], 'RCT')
      );
      originalReceipts.set(a.opening_receipt_id, wanted);
    }
    openings.push({
      account_id: a.id,
      amount: fromCents(net),
      serial: first.serial,
      at: first.postedAt,
      label,
    });
  }

  // What is inserted: every posted transaction not folded into an opening.
  const restored = [...posted.values()]
    .filter(t => !folded.has(t.serial))
    .sort((a, b) => a.serial - b.serial);
  const restoredSerials = new Set(restored.map(t => t.serial));
  const openingSerials = new Set(folded.values());
  const entriesOf = new Map<number, Entry[]>();
  for (const e of entries) {
    entriesOf.set(e.serial, [...(entriesOf.get(e.serial) ?? []), e]);
  }
  const transactions: Record<string, unknown>[] = [];
  const receipts = new Map<number, Record<string, unknown>>();
  const transfers = new Map<number, Record<string, unknown>>();
  const badMethods = new Set<string>();
  const badBanks = new Set<string>();

  for (const t of restored) {
    const c = t.row.cells;
    const at = `${c['reference']}`;
    if (!t.account) continue; // already named as not on file
    const kind = KIND_CODES.get(c['kind']);
    if (!kind) {
      problems.push(
        `${at}: ${c['kind'] || 'the kind'} is not a kind of transaction.`
      );
      continue;
    }
    const amount = cents(c['amount']);
    if (
      amount === null ||
      amount < 0 ||
      (amount === 0 && !['closure', 'resignation', 'demise'].includes(kind))
    ) {
      problems.push(`${at}: ${c['amount'] || 'the amount'} is not an amount.`);
      continue;
    }
    const method = c['method code'];
    if (!methods.has(method)) badMethods.add(method || '(blank)');
    let bankId: string | null = null;
    if (c['bank account'] !== '') {
      bankId = banks.get(c['bank account'].toUpperCase()) ?? null;
      if (!bankId) badBanks.add(c['bank account']);
    }
    const postedAt = instantOf(c['posted at']);
    if (!postedAt) {
      problems.push(`${at}: Posted at is not a date and time.`);
      continue;
    }

    let reverses: number | null = null;
    if (kind === 'reversal') {
      const original = serialOf(c['reverses'], 'TX');
      reverses = original === null ? null : (folded.get(original) ?? original);
      if (
        reverses === null ||
        !(restoredSerials.has(reverses) || openingSerials.has(reverses))
      ) {
        problems.push(
          `${at} reverses ${c['reverses'] || 'nothing named'}, which is not a posted transaction in the file.`
        );
        continue;
      }
    }

    const own = entriesOf.get(t.serial) ?? [];
    const direction =
      own.find(e => e.account.id === t.account!.id)?.direction ??
      own[0]?.direction ??
      'debit';

    // An opening's receipt was its fee payment's, which is not part of the
    // history; every other transaction keeps its own.
    const receiptSerial = t.opening ? null : serialOf(c['receipt no'], 'RCT');
    const capturedBy = person(c['captured by']);
    const createdAt = instantOf(c['created at']) ?? postedAt;
    if (receiptSerial !== null) {
      const voided = c['receipt status'] === 'void';
      receipts.set(receiptSerial, {
        serial: receiptSerial,
        state: voided ? 'void' : 'issued',
        reason: voided ? c['receipt void reason'] || null : null,
        allocated_by: capturedBy,
        allocated_at: createdAt,
        settled_at: voided
          ? (instantOf(c['receipt voided at']) ?? postedAt)
          : postedAt,
      });
    }

    const transferSerial =
      kind === 'transfer_leg' ? serialOf(c['transfer'], 'TR') : null;
    if (kind === 'transfer_leg' && transferSerial === null) {
      problems.push(`${at}: a transfer leg names no TR number.`);
      continue;
    }
    if (transferSerial !== null) {
      const existing = transfers.get(transferSerial);
      if (!existing || direction === 'debit') {
        transfers.set(transferSerial, {
          serial: transferSerial,
          member_id: t.account.member_id,
          customer_id: t.account.customer_id,
          reason: c['reason'] || null,
          captured_by: capturedBy,
          created_at: createdAt,
        });
      }
    }

    if ((c['claimant kind'] === '') !== (c['claimant'] === '')) {
      problems.push(`${at}: Claimant kind and Claimant go together.`);
      continue;
    }
    let claimant: unknown = null;
    if (c['claimant'] !== '') {
      try {
        claimant = JSON.parse(c['claimant']);
      } catch {
        problems.push(`${at}: Claimant is not readable.`);
        continue;
      }
    }

    transactions.push({
      serial: t.serial,
      kind,
      member_id: t.account.member_id,
      customer_id: t.account.customer_id,
      account_id: t.account.id,
      amount: fromCents(amount),
      method,
      method_reference: c['method reference'] || null,
      reason: c['reason'] || null,
      receipt_serial: receiptSerial,
      transfer_serial: transferSerial,
      leg_direction: kind === 'transfer_leg' ? direction : null,
      reverses_serial: reverses,
      payee_name: c['payee'] || null,
      claimant_kind: c['claimant kind'] || null,
      claimant,
      takaful_benefit: c['takaful benefit'] === '' ? '0' : c['takaful benefit'],
      bank_account_id: bankId,
      captured_by: capturedBy,
      posted_by: person(c['posted by']),
      created_at: createdAt,
      submitted_at: instantOf(c['submitted at']),
      posted_at: postedAt,
      direction,
    });
  }
  // The import's receipt takes the number its openings had, where they
  // agree on one that nothing else in the history uses.
  const receiptNumbers: { receipt_id: string; serial: number }[] = [];
  const taken = new Set<number>();
  for (const [receiptId, wanted] of originalReceipts) {
    const [serial] = [...wanted];
    if (wanted.size !== 1 || serial === null) continue;
    if (receipts.has(serial) || taken.has(serial)) continue;
    taken.add(serial);
    receiptNumbers.push({ receipt_id: receiptId, serial });
  }

  for (const m of [...badMethods].sort()) {
    problems.push(`${m} is not a payment method here.`);
  }
  for (const b of [...badBanks].sort()) {
    problems.push(`Bank account ${b} is not set up here.`);
  }

  const transitions = file.approvals
    .map(row => {
      const c = row.cells;
      const serial = serialOf(c['reference'] ?? '', 'TX');
      if (serial === null || !restoredSerials.has(serial)) return null;
      const occurredAt = instantOf(c['at'] ?? '');
      if (!occurredAt || !c['to']) return null;
      return {
        serial,
        from_status: c['from'] || null,
        to_status: c['to'],
        step_code: c['step'] || null,
        actor_user_id: person(c['by'] ?? ''),
        actor_role: c['role'] || null,
        comment: c['comment'] || null,
        occurred_at: occurredAt,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const restoredEntries = entries
    .filter(e => !folded.has(e.serial))
    .map(e => ({
      serial: e.serial,
      account_id: e.account.id,
      direction: e.direction,
      amount: fromCents(e.cents),
      posted_at: e.postedAt,
    }));

  return {
    problems,
    payload: {
      max,
      openings,
      receipt_numbers: receiptNumbers,
      transfers: [...transfers.values()],
      receipts: [...receipts.values()],
      transactions,
      entries: restoredEntries,
      transitions,
      balances,
    },
    outcome: {
      transactions: transactions.length + openings.filter(o => o.serial).length,
      entries: entries.length,
      transfers: transfers.size,
      approvals: transitions.length,
      accounts: byAccount.size,
      notPosted,
      unknownStaff: [...unknownStaff].sort(),
    },
  };
}

export class HistoryProblems extends MigrationError {
  constructor(readonly problems: string[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in that file. Nothing was restored.`
    );
    this.name = 'HistoryProblems';
  }
}

/** Check a transactions backup and restore it, all or nothing. */
export async function restoreHistory(
  buffer: Buffer,
  checksum: string,
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<HistoryOutcome> {
  if (!permissions.has(PERMISSION_MIGRATE)) {
    throw new MigrationError(
      'You do not have permission to import members.',
      'forbidden'
    );
  }
  if (await runningBatch()) {
    throw new MigrationError(
      'An import is still running. Let it finish or cancel it first.'
    );
  }
  const file = await parseHistoryFile(buffer);
  const plan = await planHistory(file);
  if (plan.problems.length > 0) throw new HistoryProblems(plan.problems);

  try {
    await withTransaction(async client => {
      await client.query(
        `select restore_transaction_history($1::jsonb, $2, $3)`,
        [
          JSON.stringify({ ...plan.payload, checksum }),
          actor.userId,
          actor.email,
        ]
      );
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'restrict_violation') {
      throw new MigrationError((err as Error).message);
    }
    throw err;
  }
  return plan.outcome;
}
