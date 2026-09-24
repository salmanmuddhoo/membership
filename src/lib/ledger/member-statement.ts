// A member's statement, sent to them (officer request): every account the
// holder has, over a period, as one PDF, by email or WhatsApp — to one
// member from their page, or to everyone at once from Finance →
// Statements, which the statement-send job carries out.
//
// The figures are each account's own statement (accountStatement in
// ledger.ts), unchanged; this module only puts a holder's accounts
// together, typesets them, and sends them the way a receipt is sent
// (receipt-notifications.ts): a signed, expiring link to the PDF in the
// wording, and the PDF attached where the wording says so.
import { jsPDF } from 'jspdf';
import { SignJWT, jwtVerify } from 'jose';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { getAppOrigin, getReceiptLinkSecret } from '../config';
import { query } from '../db/pool';
import type { JobContext } from '../jobs/runner';
import { notify } from '../notifications/notify';
import { STATEMENT_ISSUED } from '../notifications/event-codes';
import { formatMoney } from '../payments/money';
import { accountStatement, type Statement } from './ledger';
import { contactForHolder } from './receipt-notifications';
import type { StatementPeriod } from './statement';

export const PERMISSION_SEND = 'statement.send';
export const PERMISSION_SEND_ALL = 'statement.send_all';

export type HolderKind = 'member' | 'customer';
export interface Holder {
  kind: HolderKind;
  id: string;
}

export interface MemberStatement {
  holder: Holder;
  holderName: string;
  memberNo: string | null;
  period: StatementPeriod;
  accounts: Statement[];
}

export class StatementError extends Error {
  constructor(
    message: string,
    public readonly reason: 'invalid' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
  }
}

/**
 * The holder's statement for the period: each account that was open at
 * any point in it, in the order the member page lists them. Null when the
 * holder has no such account.
 */
export async function memberStatement(
  holder: Holder,
  period: StatementPeriod
): Promise<MemberStatement | null> {
  const accounts = await query<{ id: string }>(
    `select a.id
       from account a
       join account_type t on t.id = a.account_type_id
      where (case $1 when 'member' then a.member_id else a.customer_id end)
              = $2::uuid
        and a.opened_at < $4::date + 1
        and (a.status <> 'closed' or a.closed_at >= $3::date)
      order by t.sort_order, a.opened_at`,
    [holder.kind, holder.id, period.from, period.to]
  );
  const statements = (
    await Promise.all(
      accounts.rows.map(a => accountStatement(a.id, period.from, period.to))
    )
  ).filter((s): s is Statement => s !== null);
  if (statements.length === 0) return null;
  return {
    holder,
    holderName: statements[0].holderName,
    memberNo: statements[0].memberNo,
    period,
    accounts: statements,
  };
}

// ---------------------------------------------------------------------------
// The PDF

const longDate = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Indian/Mauritius',
});

export function periodWords(period: StatementPeriod): string {
  const day = (value: string) =>
    longDate.format(new Date(`${value}T00:00:00Z`));
  return `${day(period.from)} to ${day(period.to)}`;
}

export function statementPdfFileName(statement: MemberStatement): string {
  const who = statement.memberNo ?? statement.holderName;
  return `Statement ${who} ${statement.period.from} to ${statement.period.to}.pdf`;
}

/**
 * The statement as A4 pages: a heading, then each account in turn — its
 * opening balance, every entry, its closing balance and totals. Drawn with
 * jsPDF for the same reason the receipt is (receipt-pdf.ts): no browser.
 */
export function renderMemberStatementPdf(
  statement: MemberStatement
): ArrayBuffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const left = 15;
  const right = 195;
  const bottom = 280;
  // Column positions: date, reference, description, out, in, balance.
  const col = { ref: 40, desc: 72, out: 150, in: 172, bal: 195 };
  let y = 20;

  const newPage = () => {
    doc.addPage();
    y = 20;
  };
  const ensure = (space: number) => {
    if (y + space > bottom) newPage();
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Al Barakah MCSL', left, y);
  doc.setFontSize(11);
  doc.text('Statement', right, y, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(
    [statement.holderName, statement.memberNo].filter(Boolean).join(' · '),
    left,
    y
  );
  doc.setTextColor(90);
  doc.text(periodWords(statement.period), right, y, { align: 'right' });
  doc.setTextColor(0);
  y += 4;
  doc.setDrawColor(180);
  doc.line(left, y, right, y);
  y += 8;

  for (const account of statement.accounts) {
    ensure(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`${account.accountNo} · ${account.accountTypeName}`, left, y);
    y += 6;
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text('Date', left, y);
    doc.text('Reference', col.ref, y);
    doc.text('Description', col.desc, y);
    doc.text('Out', col.out, y, { align: 'right' });
    doc.text('In', col.in, y, { align: 'right' });
    doc.text('Balance', col.bal, y, { align: 'right' });
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    y += 2;
    doc.line(left, y, right, y);
    y += 5;

    doc.text('Opening balance', col.desc, y);
    doc.text(formatMoney(account.openingBalance), col.bal, y, {
      align: 'right',
    });
    y += 5;

    for (const line of account.lines) {
      const description = doc.splitTextToSize(
        line.description,
        col.out - col.desc - 22
      ) as string[];
      ensure(5 * description.length);
      doc.text(shortDate.format(line.postedAt), left, y);
      doc.text(line.reference, col.ref, y);
      doc.text(description, col.desc, y);
      if (line.debit) {
        doc.text(formatMoney(line.debit), col.out, y, { align: 'right' });
      }
      if (line.credit) {
        doc.text(formatMoney(line.credit), col.in, y, { align: 'right' });
      }
      doc.text(formatMoney(line.balance), col.bal, y, { align: 'right' });
      y += 5 * description.length;
    }
    if (account.lines.length === 0) {
      doc.setTextColor(90);
      doc.text('No movement in this period.', col.desc, y);
      doc.setTextColor(0);
      y += 5;
    }

    ensure(14);
    doc.line(left, y - 2, right, y - 2);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.text('Closing balance', col.desc, y);
    doc.text(formatMoney(account.totalDebits), col.out, y, { align: 'right' });
    doc.text(formatMoney(account.totalCredits), col.in, y, { align: 'right' });
    doc.text(formatMoney(account.closingBalance), col.bal, y, {
      align: 'right',
    });
    doc.setFont('helvetica', 'normal');
    y += 12;
  }

  const pages = doc.getNumberOfPages();
  doc.setFontSize(8);
  doc.setTextColor(120);
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.text(`Page ${page} of ${pages}`, right, 290, { align: 'right' });
  }
  return doc.output('arraybuffer');
}

// ---------------------------------------------------------------------------
// The signed link

// Signed with the member-facing secret, like a receipt's link
// (receipt-links.ts), but for its own purpose: a receipt token never opens
// a statement, nor the other way round.
const PURPOSE = 'statement';
export const LINK_DAYS = 30;

function key(): Uint8Array | null {
  const secret = getReceiptLinkSecret();
  return secret ? new TextEncoder().encode(secret) : null;
}

export async function signStatementToken(
  holder: Holder,
  period: StatementPeriod
): Promise<string | null> {
  const k = key();
  if (!k) return null;
  return new SignJWT({
    purpose: PURPOSE,
    kind: holder.kind,
    from: period.from,
    to: period.to,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(holder.id)
    .setIssuedAt()
    .setExpirationTime(`${LINK_DAYS}d`)
    .sign(k);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// What the token names, or null for anything else: expired, tampered,
// signed for another purpose, or with another secret.
export async function verifyStatementToken(
  token: string
): Promise<{ holder: Holder; period: StatementPeriod } | null> {
  const k = key();
  if (!k || !token) return null;
  try {
    const { payload } = await jwtVerify(token, k, { algorithms: ['HS256'] });
    const { purpose, kind, from, to, sub } = payload as Record<string, unknown>;
    if (
      purpose !== PURPOSE ||
      (kind !== 'member' && kind !== 'customer') ||
      typeof sub !== 'string' ||
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !DAY.test(from) ||
      !DAY.test(to)
    ) {
      return null;
    }
    return { holder: { kind, id: sub }, period: { from, to } };
  } catch {
    return null;
  }
}

export async function statementLink(
  holder: Holder,
  period: StatementPeriod
): Promise<string | null> {
  const origin = getAppOrigin();
  const token = await signStatementToken(holder, period);
  if (!origin || !token) return null;
  return `${origin}/statements/shared/${token}.pdf`;
}

// ---------------------------------------------------------------------------
// Sending

export type SendOutcome = 'sent' | 'no_contact' | 'failed' | 'no_accounts';

/**
 * Send one holder their statement on every channel they have an address
 * for. Never throws: what happened is the outcome, and the delivery log.
 */
export async function sendStatement(
  holder: Holder,
  period: StatementPeriod
): Promise<{ outcome: SendOutcome; notificationIds: string[] }> {
  try {
    const statement = await memberStatement(holder, period);
    if (!statement) return { outcome: 'no_accounts', notificationIds: [] };
    const contact = await contactForHolder(holder.kind, holder.id);
    if (!contact || (!contact.email && !contact.mobile)) {
      return { outcome: 'no_contact', notificationIds: [] };
    }
    const link = await statementLink(holder, period);
    const notificationIds = await notify({
      eventCode: STATEMENT_ISSUED,
      recipients: { email: contact.email, mobile: contact.mobile },
      values: {
        member_name: contact.name || statement.holderName,
        period: periodWords(period),
        accounts: statement.accounts
          .map(a => `${a.accountNo} · ${a.accountTypeName}`)
          .join(', '),
        link: link ?? 'Ask at your branch for a printed copy.',
      },
      entityType: holder.kind,
      entityId: holder.id,
      attachment: link
        ? {
            url: link,
            filename: statementPdfFileName(statement),
            contentType: 'application/pdf',
          }
        : null,
    });
    return {
      outcome: notificationIds.length > 0 ? 'sent' : 'failed',
      notificationIds,
    };
  } catch (error) {
    console.error('[statements] could not send a statement:', error);
    return { outcome: 'failed', notificationIds: [] };
  }
}

/**
 * An officer sends one holder their statement, from the holder's page.
 */
export async function sendStatementTo(
  holder: Holder,
  period: StatementPeriod,
  principal: Principal
): Promise<SendOutcome> {
  if (!principal.permissions.has(PERMISSION_SEND)) {
    throw new StatementError(
      'You do not have permission to send statements.',
      'forbidden'
    );
  }
  const { outcome, notificationIds } = await sendStatement(holder, period);
  await recordAudit({
    actorUserId: principal.userId,
    actorDescription: principal.email,
    action: 'statement.sent',
    entityType: holder.kind,
    entityId: holder.id,
    newValue: { from: period.from, to: period.to, outcome, notificationIds },
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Everyone at once

export interface StatementRun {
  id: string;
  from: string;
  to: string;
  status: 'queued' | 'sending' | 'done';
  requestedByName: string | null;
  requestedAt: Date;
  finishedAt: Date | null;
  sent: number;
  noContact: number;
  failed: number;
}

// Who a run sends to: every member and non-member with an account that is
// not closed. A converted customer's accounts moved to the member they
// became, so they are found under the member.
const HOLDERS = `
  select distinct
         case when a.member_id is not null then 'member' else 'customer' end
           as kind,
         coalesce(a.member_id, a.customer_id) as id
    from account a
   where a.status <> 'closed'
`;

export async function countHolders(): Promise<number> {
  const result = await query<{ n: number }>(
    `select count(*)::int as n from (${HOLDERS}) h`
  );
  return result.rows[0].n;
}

/**
 * Ask for every holder to be sent their statement for the period. The
 * statement-send job does the sending; one run at a time.
 */
export async function queueStatementRun(
  period: StatementPeriod,
  principal: Principal
): Promise<string> {
  if (!principal.permissions.has(PERMISSION_SEND_ALL)) {
    throw new StatementError(
      'You do not have permission to send everyone their statement.',
      'forbidden'
    );
  }
  try {
    const result = await query<{ id: string }>(
      `insert into statement_run (period_from, period_to, requested_by)
       values ($1, $2, $3) returning id`,
      [period.from, period.to, principal.userId]
    );
    const id = result.rows[0].id;
    await recordAudit({
      actorUserId: principal.userId,
      actorDescription: principal.email,
      action: 'statement.run.queued',
      entityType: 'statement_run',
      entityId: id,
      newValue: { from: period.from, to: period.to },
    });
    return id;
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new StatementError(
        'Statements are already being sent. Wait for that to finish.',
        'conflict'
      );
    }
    throw error;
  }
}

export async function listStatementRuns(limit = 20): Promise<StatementRun[]> {
  const result = await query<{
    id: string;
    period_from: string;
    period_to: string;
    status: StatementRun['status'];
    requested_by_name: string | null;
    requested_at: Date;
    finished_at: Date | null;
    sent: number;
    no_contact: number;
    failed: number;
  }>(
    `select r.id, r.period_from::text, r.period_to::text, r.status,
            u.display_name as requested_by_name, r.requested_at,
            r.finished_at,
            count(*) filter (where i.outcome = 'sent')::int as sent,
            count(*) filter (where i.outcome = 'no_contact')::int
              as no_contact,
            count(*) filter (where i.outcome = 'failed')::int as failed
       from statement_run r
       left join app_user u on u.id = r.requested_by
       left join statement_run_item i on i.run_id = r.id
      group by r.id, u.display_name
      order by r.requested_at desc
      limit $1`,
    [limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    from: r.period_from,
    to: r.period_to,
    status: r.status,
    requestedByName: r.requested_by_name,
    requestedAt: r.requested_at,
    finishedAt: r.finished_at,
    sent: r.sent,
    noContact: r.no_contact,
    failed: r.failed,
  }));
}

export interface StatementRunCheckpoint {
  runId: string;
  lastId: string | null;
}

/**
 * The statement-send job: work through the open run, if there is one, a
 * chunk of holders at a time. Each holder dealt with is recorded before
 * the checkpoint moves, and one already recorded is skipped, so a run
 * stopped and resumed — even mid-chunk — never sends anyone twice.
 */
export async function processStatementRuns(
  context: JobContext<StatementRunCheckpoint>,
  chunkSize = 50
): Promise<void> {
  const open = await query<{
    id: string;
    period_from: string;
    period_to: string;
  }>(
    `select id, period_from::text, period_to::text from statement_run
      where status in ('queued', 'sending')
      order by requested_at limit 1`
  );
  const run = open.rows[0];
  if (!run) {
    context.log('no statements waiting to be sent');
    return;
  }
  const period = { from: run.period_from, to: run.period_to };
  await query(
    `update statement_run set status = 'sending'
      where id = $1 and status = 'queued'`,
    [run.id]
  );
  let lastId =
    context.checkpoint?.runId === run.id ? context.checkpoint.lastId : null;

  for (;;) {
    if (context.shouldStop()) {
      context.log('stopping between chunks', { runId: run.id, lastId });
      return;
    }
    const chunk = await query<{ kind: HolderKind; id: string }>(
      `select h.kind, h.id::text
         from (${HOLDERS}) h
        where ($1::uuid is null or h.id > $1::uuid)
          and not exists (select 1 from statement_run_item i
                           where i.run_id = $2 and i.holder_id = h.id)
        order by h.id
        limit $3`,
      [lastId, run.id, chunkSize]
    );
    if (chunk.rows.length === 0) break;

    let dealt = 0;
    for (const holder of chunk.rows) {
      const { outcome } = await sendStatement(holder, period);
      await query(
        `insert into statement_run_item (run_id, holder_kind, holder_id, outcome)
         values ($1, $2, $3, $4)
         on conflict (run_id, holder_id) do nothing`,
        [run.id, holder.kind, holder.id, outcome]
      );
      dealt += 1;
    }
    lastId = chunk.rows[chunk.rows.length - 1].id;
    await context.save({ runId: run.id, lastId }, dealt);
  }

  await query(
    `update statement_run set status = 'done', finished_at = now()
      where id = $1`,
    [run.id]
  );
  context.log('statements sent', { runId: run.id });
}
