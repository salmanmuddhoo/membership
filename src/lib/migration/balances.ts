// Account balances from a migration file (officer direction): a sheet of
// account number and balance that overrides the balance on file.
//
// A member's Shares and MSA accounts both go by the member's AB number, so
// a row naming an AB number also says which of the two it means (Account
// Type); every other account — HSA0001, INV0001, a non-member's — has a
// number of its own and needs no type. The whole file is checked before
// anything is written, as the member import is: one problem and nothing
// changes.
//
// What is replaced is the account's migrated opening balance
// (set_opening_balance, migration 0111), so an account holding any other
// transaction is refused here. Every account set is audited in the
// database, with its balance before and after; the upload itself is audited
// here.
import ExcelJS from 'exceljs';
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';
import { fromCents, toCents } from '../payments/money';
import { migrationFeeVersionId } from '../payments/payments';
import { runningBatch } from './batches';
import {
  MigrationError,
  PERMISSION_MIGRATE,
  objectCellText,
  parseAmount,
} from './members';

interface Actor {
  userId: string;
  email: string;
}

const SHEET = 'Balances';
const ACCOUNT_COLUMN = 'Account Number';
const TYPE_COLUMN = 'Account Type';
const BALANCE_COLUMN = 'Balance';

export interface BalanceRow {
  rowNumber: number;
  account: string;
  accountType: string;
  balance: string;
}

export interface BalanceRowError {
  rowNumber: number;
  account: string;
  message: string;
}

export interface ValidatedBalance {
  rowNumber: number;
  accountId: string;
  // As the officer knows it: the account number, or the AB number and type.
  label: string;
  // The member or non-member who holds the account.
  holderId: string;
  holderKind: 'member' | 'customer';
  previous: string;
  balance: string;
  feeVersionId: string | null;
}

export interface BalanceOutcome {
  rows: number;
  changed: number;
  unchanged: number;
  // Holders with at least one balance changed.
  members: number;
  nonMembers: number;
  // Every balance in the file, and what those accounts held before.
  totalCents: number;
  previousCents: number;
}

function assertMayMigrate(permissions: ReadonlySet<string>): void {
  if (!permissions.has(PERMISSION_MIGRATE)) {
    throw new MigrationError(
      'You do not have permission to import members.',
      'forbidden'
    );
  }
}

/** The file to fill in: one sheet, three columns. */
export async function buildBalanceTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Al Barakah MCSL';
  const sheet = workbook.addWorksheet(SHEET);
  const columns = [
    {
      header: `${ACCOUNT_COLUMN} *`,
      note: 'An AB number for Shares or MSA, or the account number (HSA0001, INV0001).',
      fill: 'FFF4B6B6',
    },
    {
      header: TYPE_COLUMN,
      note: 'Shares or MSA, on a row with an AB number. Leave blank for any other account.',
      fill: 'FFFFE08A',
    },
    {
      header: `${BALANCE_COLUMN} *`,
      note: 'The balance the account should hold, e.g. 10000 or 10000.50.',
      fill: 'FFF4B6B6',
    },
  ];
  columns.forEach((c, i) => {
    const cell = sheet.getRow(1).getCell(i + 1);
    cell.value = c.header;
    cell.note = c.note;
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c.fill },
    };
    sheet.getColumn(i + 1).width = 22;
  });
  // Account numbers are text: 0001 must stay 0001.
  sheet.getColumn(1).numFmt = '@';
  sheet.getRow(1).commit();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function header(text: string): string {
  return text.replace(/\*/g, '').replace(/[.:]/g, '').trim().toLowerCase();
}

/** The rows of an uploaded balance file, blank rows left out. */
export async function parseBalanceFile(buffer: Buffer): Promise<BalanceRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new MigrationError('That file is not an Excel workbook (.xlsx).');
  }
  const sheet = workbook.getWorksheet(SHEET) ?? workbook.worksheets[0];
  if (!sheet) throw new MigrationError('That file has no sheet to read.');

  let accountCol = 0;
  let typeCol = 0;
  let balanceCol = 0;
  sheet.getRow(1).eachCell((cell, n) => {
    const h = header(objectCellText(cell.value));
    if (['account number', 'account', 'account no'].includes(h)) {
      accountCol = n;
    } else if (['account type', 'type'].includes(h)) {
      typeCol = n;
    } else if (h === 'balance') {
      balanceCol = n;
    }
  });
  if (!accountCol || !balanceCol) {
    throw new MigrationError(
      `Use the template's column headings: ${ACCOUNT_COLUMN}, ${TYPE_COLUMN}, ${BALANCE_COLUMN}.`
    );
  }

  const rows: BalanceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const text = (col: number) =>
      col ? objectCellText(row.getCell(col).value) : '';
    const parsed = {
      rowNumber,
      account: text(accountCol),
      accountType: text(typeCol),
      balance: text(balanceCol),
    };
    if (parsed.account || parsed.accountType || parsed.balance) {
      rows.push(parsed);
    }
  });
  return rows;
}

interface AccountOnFile {
  id: string;
  account_no: string | null;
  member_no: string | null;
  holder_id: string;
  holder_kind: 'member' | 'customer';
  type_code: string;
  type_name: string;
  membership_type_id: string | null;
  balance: string;
  has_own: boolean;
  openings: number;
}

// Shares, MSA, "Multiplier Savings Account", "msa" — a type as an officer
// might type it.
function typeMatches(typed: string, account: AccountOnFile): boolean {
  const t = typed.trim().toLowerCase();
  const name = account.type_name.toLowerCase();
  return (
    t === account.type_code.toLowerCase() ||
    t === name ||
    t === name.replace(/\s+account$/, '')
  );
}

/**
 * Every row checked against what is on file. Nothing is written; a file
 * with any problem is refused whole.
 */
export async function validateBalanceRows(rows: BalanceRow[]): Promise<{
  valid: ValidatedBalance[];
  errors: BalanceRowError[];
}> {
  const keys = [...new Set(rows.map(r => r.account.trim().toUpperCase()))];
  // Joined on the file's own keys rather than filtered by them: a file of
  // thousands of rows against thousands of accounts stays one hash join.
  const onFile = await query<AccountOnFile>(
    `with k as (select distinct unnest($1::text[]) as key),
          matched as (
            select a.id from k join account a on upper(a.account_no) = k.key
            union
            select a.id
              from k
              join member m on upper(m.member_no) = k.key
              join account a on a.member_id = m.id and a.account_no is null)
     select a.id, a.account_no, m.member_no,
            coalesce(a.member_id, a.customer_id) as holder_id,
            case when a.member_id is not null then 'member' else 'customer' end
              as holder_kind,
            ty.code as type_code, ty.name as type_name,
            coalesce(m.membership_type_id, app.membership_type_id)
              as membership_type_id,
            coalesce(b.balance, 0)::text as balance,
            exists (
              select 1
                from transaction t
                left join payment_line pl on pl.id = t.payment_line_id
                left join payment_account_line pal
                  on pal.id = t.payment_account_line_id
                left join payment p
                  on p.id = coalesce(pl.payment_id, pal.payment_id)
               where t.account_id = a.id
                 and (p.id is null or p.method <> 'migration'
                      or p.voided_at is not null)) as has_own,
            (select count(*) from transaction t
              where t.account_id = a.id)::int as openings
       from matched x
       join account a on a.id = x.id
       join account_type ty on ty.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
       left join membership_application app
         on app.id = coalesce(m.application_id, c.application_id)
       left join account_balance b on b.account_id = a.id
      order by ty.sort_order, ty.name`,
    [keys]
  );
  const byNumber = new Map<string, AccountOnFile>();
  const byMember = new Map<string, AccountOnFile[]>();
  for (const a of onFile.rows) {
    if (a.account_no) {
      byNumber.set(a.account_no.toUpperCase(), a);
    } else if (a.member_no) {
      const key = a.member_no.toUpperCase();
      byMember.set(key, [...(byMember.get(key) ?? []), a]);
    }
  }

  const feeVersions = new Map<string, string | null>();
  const feeVersionFor = async (typeId: string | null) => {
    if (!typeId) return null;
    if (!feeVersions.has(typeId)) {
      feeVersions.set(typeId, await migrationFeeVersionId(typeId));
    }
    return feeVersions.get(typeId) ?? null;
  };

  const errors: BalanceRowError[] = [];
  const found: { row: BalanceRow; account: AccountOnFile; label: string }[] =
    [];
  const balances = new Map<number, string>();

  for (const row of rows) {
    const problems: string[] = [];
    const number = row.account.trim().toUpperCase();
    const balance = parseAmount(row.balance, BALANCE_COLUMN, problems);
    if (row.balance.trim() === '')
      problems.push(`${BALANCE_COLUMN} is required.`);

    let account: AccountOnFile | null = null;
    let label = number;
    if (number === '') {
      problems.push(`${ACCOUNT_COLUMN} is required.`);
    } else if (byMember.has(number)) {
      const held = byMember.get(number)!;
      if (row.accountType.trim() === '') {
        problems.push(
          `${TYPE_COLUMN} is required for ${number}: ${held
            .map(a => a.type_name)
            .join(' or ')}.`
        );
      } else {
        account = held.find(a => typeMatches(row.accountType, a)) ?? null;
        if (!account) {
          problems.push(
            `${number} holds no ${row.accountType.trim()} account. Use ${held
              .map(a => a.type_name)
              .join(' or ')}.`
          );
        } else {
          label = `${number} ${account.type_name}`;
        }
      }
    } else if (byNumber.has(number)) {
      account = byNumber.get(number)!;
      if (
        row.accountType.trim() !== '' &&
        !typeMatches(row.accountType, account)
      ) {
        problems.push(
          `${number} is a ${account.type_name}, not ${row.accountType.trim()}.`
        );
        account = null;
      }
    } else {
      problems.push(`${number} is not on file.`);
    }

    if (account?.has_own) {
      problems.push(
        `${label} has transactions of its own, so its balance cannot be set here.`
      );
    } else if (account && account.openings > 1) {
      problems.push(
        `${label} has more than one opening balance, so its balance cannot be set here.`
      );
    }

    if (problems.length > 0) {
      errors.push({
        rowNumber: row.rowNumber,
        account: row.account.trim(),
        message: problems.join(' '),
      });
    } else if (account) {
      found.push({ row, account, label });
      balances.set(row.rowNumber, balance);
    }
  }

  // The same account twice: which figure is meant is not ours to guess.
  const times = new Map<string, number>();
  for (const f of found) {
    times.set(f.account.id, (times.get(f.account.id) ?? 0) + 1);
  }
  const valid: ValidatedBalance[] = [];
  for (const f of found) {
    if ((times.get(f.account.id) ?? 0) > 1) {
      errors.push({
        rowNumber: f.row.rowNumber,
        account: f.row.account.trim(),
        message: `${f.label} appears more than once in this file.`,
      });
      continue;
    }
    valid.push({
      rowNumber: f.row.rowNumber,
      accountId: f.account.id,
      label: f.label,
      holderId: f.account.holder_id,
      holderKind: f.account.holder_kind,
      previous: fromCents(toCents(f.account.balance)),
      balance: balances.get(f.row.rowNumber)!,
      feeVersionId: await feeVersionFor(f.account.membership_type_id),
    });
  }
  errors.sort((a, b) => a.rowNumber - b.rowNumber);
  return { valid, errors };
}

/** Set every balance of a checked file, all or nothing. */
export async function applyBalances(
  valid: ValidatedBalance[],
  checksum: string,
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<BalanceOutcome> {
  assertMayMigrate(permissions);
  if (valid.length === 0) {
    throw new MigrationError('The file has no rows to set.');
  }
  if (await runningBatch()) {
    throw new MigrationError(
      'An import is still running. Let it finish or cancel it first.'
    );
  }
  try {
    return await withTransaction(async client => {
      const result = await client.query<{ changed: number }>(
        `select set_opening_balances($1::jsonb, $2, $3) as changed`,
        [
          JSON.stringify(
            valid.map(v => ({
              account_id: v.accountId,
              amount: v.balance,
              fee_version_id: v.feeVersionId ?? '',
            }))
          ),
          actor.userId,
          actor.email,
        ]
      );
      const changed = result.rows[0].changed;
      const total = valid.reduce((sum, v) => sum + toCents(v.balance), 0);
      const previous = valid.reduce((sum, v) => sum + toCents(v.previous), 0);
      const affected = new Map<string, 'member' | 'customer'>();
      for (const v of valid) {
        if (toCents(v.previous) !== toCents(v.balance)) {
          affected.set(v.holderId, v.holderKind);
        }
      }
      const members = [...affected.values()].filter(k => k === 'member').length;
      const nonMembers = affected.size - members;
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.email,
          action: 'migration.balances.uploaded',
          entityType: 'migration',
          entityId: checksum,
          newValue: {
            checksum,
            rows: valid.length,
            changed,
            members,
            nonMembers,
            totalBalance: fromCents(total),
            previousBalance: fromCents(previous),
          },
        },
        client
      );
      return {
        rows: valid.length,
        changed,
        unchanged: valid.length - changed,
        members,
        nonMembers,
        totalCents: total,
        previousCents: previous,
      };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'restrict_violation' || code === 'check_violation') {
      throw new MigrationError((err as Error).message);
    }
    throw err;
  }
}
