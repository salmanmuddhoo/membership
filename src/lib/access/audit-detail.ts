// The detail behind one line of the audit log (officer request): what
// `describeEntry` on the page says in one line, this says in full — built on
// the server, from the record the entry is about, not from the raw JSON the
// row carries.
//
// One query per entity type actually present on the page, never one per
// row: the page hands every row it is about to show to describeAuditDetail
// once, and this groups them by entityType before it goes near the
// database.
import { paysOut, transactionStatusLabel } from '../ledger/labels';
import { KIND_WORDS as TRANSACTION_KIND_WORDS } from '../ledger/void-notifications';
import {
  assembleTransaction,
  TRANSACTION_SELECT,
  type TransactionRow,
  type TransactionSummary,
} from '../ledger/review';
import { APPLICATION_STATUS_LABELS } from '../applications/status-labels';
import { statusLabel } from '../members/labels';
import { formatMoney } from '../payments/money';
import { query } from '../db/pool';
import type { AuditEventRow } from './audit';

export interface AuditDetailFact {
  label: string;
  value: string;
}

export interface AuditDetail {
  sentence: string;
  facts: AuditDetailFact[];
}

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

// ---------------------------------------------------------------------------
// Small formatting helpers, shared by every branch below.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// snake_case or camelCase -> "Words", for a key nobody configured a label
// for (a configuration table's own column names).
function humaniseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// Only the keys that actually changed — a config row's own before/after is
// its whole row (record_configuration_change, migration 0010), and most of
// it never changed.
function diffFacts(previous: unknown, next: unknown): AuditDetailFact[] {
  const before = asRecord(previous);
  const after = asRecord(next);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const facts: AuditDetailFact[] = [];
  for (const key of keys) {
    if (key === 'updated_at' || key === 'updatedAt') continue;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (
      hasBefore &&
      hasAfter &&
      JSON.stringify(before[key]) === JSON.stringify(after[key])
    ) {
      continue;
    }
    const beforeText = hasBefore ? formatValue(before[key]) : null;
    const afterText = hasAfter ? formatValue(after[key]) : null;
    const value =
      beforeText !== null && afterText !== null && beforeText !== afterText
        ? `${beforeText} → ${afterText}`
        : (afterText ?? beforeText ?? '—');
    facts.push({ label: humaniseKey(key), value });
  }
  return facts;
}

// What is left of an action's own name once nothing else in this file knows
// what to say about it: "member · dormancy detected" reads as a fact rather
// than a sentence, but it is at least never wrong and never internal.
function fallbackSentence(row: AuditEventRow): string {
  return `${row.entityType} ${row.action.replace(/\./g, ' · ')}`;
}

function genericDetail(row: AuditEventRow): AuditDetail {
  return {
    sentence: fallbackSentence(row),
    facts: diffFacts(row.previousValue, row.newValue),
  };
}

// config.<table>.<insert|update|delete> (record_configuration_change,
// migration 0010): the table it touched and what that write did to it.
function configDetail(row: AuditEventRow): AuditDetail {
  const parts = row.action.split('.');
  const op = parts[parts.length - 1];
  const table =
    parts.length >= 3 ? parts.slice(1, -1).join('_') : row.entityType;
  const label = humaniseKey(table);
  const verb =
    op === 'insert' ? 'Added' : op === 'delete' ? 'Removed' : 'Changed';
  return {
    sentence: `${verb} ${label}`,
    facts: diffFacts(row.previousValue, row.newValue),
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function kindWord(kind: string): string {
  const word = TRANSACTION_KIND_WORDS[kind] ?? kind.replace(/_/g, ' ');
  return word.toLowerCase();
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function accountLabel(t: TransactionSummary): string {
  return `${t.accountNo} · ${t.accountTypeName}`;
}

function holderLabel(t: TransactionSummary): string {
  return t.memberNo ? `${t.holderName} (${t.memberNo})` : t.holderName;
}

function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function methodLabel(t: TransactionSummary): string | null {
  if (!t.methodName) return null;
  const ref = t.methodReference ? ` ${t.methodReference}` : '';
  return `${t.methodName.toLowerCase()}${ref}`;
}

function transactionCommentOrReason(row: AuditEventRow): string | null {
  const v = asRecord(row.newValue);
  return asString(v.comment) ?? asString(v.reason);
}

function transactionSentence(
  row: AuditEventRow,
  t: TransactionSummary
): string {
  const money = formatMoney(t.amount, t.currency);
  const kind = kindWord(t.kind);
  const account = accountLabel(t);
  const holder = t.payeeName ?? holderLabel(t);
  const method = methodLabel(t);
  const receipt = t.receiptNo ? `receipt ${t.receiptNo}` : null;
  const comment = transactionCommentOrReason(row);
  const commentSuffix = comment ? ` ${comment}` : '';

  switch (row.action) {
    case 'transaction.posted': {
      const counterpart =
        t.counterpartAccountNo &&
        `${t.counterpartAccountNo} · ${t.counterpartAccountTypeName ?? ''} of ${t.counterpartHolderName ?? ''}`.trim();
      const parts: string[] = [];
      if (t.kind === 'transfer_leg' && !t.payeeName && counterpart) {
        // An internal transfer's two legs read from each side: the
        // receiving account's own trail says money arrived, the paying
        // account's says it left — never both the same sentence.
        parts.push(
          t.legDirection === 'credit'
            ? `${money} transferred to ${account} of ${holderLabel(t)} from ${counterpart}`
            : `${money} transferred from ${account} of ${holderLabel(t)} to ${counterpart}`
        );
      } else if (paysOut(t)) {
        parts.push(
          `${money} disbursed for ${withArticle(kind)} from ${account} of ${holderLabel(t)}`
        );
        if (t.payeeName) parts.push(`to ${t.payeeName}`);
      } else {
        parts.push(`${money} deposited to ${account} of ${holderLabel(t)}`);
      }
      if (method) parts.push(`by ${method}`);
      if (receipt) parts.push(receipt);
      return `${parts.join(', ')}.`;
    }
    case 'transaction.captured':
    case 'transaction.submitted':
      return `Recorded ${withArticle(kind)} of ${money} from ${account} for ${holderLabel(t)}.`;
    case 'transaction.reviewed':
      return `Forwarded ${kind} ${t.displayReference} of ${money} for ${holder}.${commentSuffix}`;
    case 'transaction.approved':
      return `Approved ${kind} ${t.displayReference} of ${money} for ${holder}.${commentSuffix}`;
    case 'transaction.returned':
      return `Returned ${kind} ${t.displayReference} for correction.${commentSuffix}`;
    case 'transaction.rejected':
      return `Rejected ${kind} ${t.displayReference}.${commentSuffix}`;
    case 'transaction.cancelled':
      return `Cancelled ${kind} ${t.displayReference}.${commentSuffix}`;
    case 'transaction.resubmitted':
      return `Corrected and resubmitted ${kind} ${t.displayReference} of ${money}.`;
    case 'transaction.reversed': {
      const reversedBy = asString(asRecord(row.newValue).reversed_by);
      return `Reversed ${kind} ${t.displayReference}${reversedBy ? ` as ${reversedBy}` : ''}.${commentSuffix}`;
    }
    case 'transaction.voided':
      return `Voided the receipt for ${kind} ${t.displayReference}.${commentSuffix}`;
    default:
      return fallbackSentence(row);
  }
}

function transactionFacts(t: TransactionSummary): AuditDetailFact[] {
  const facts: AuditDetailFact[] = [
    { label: 'Kind', value: capitalise(kindWord(t.kind)) },
    { label: 'Amount', value: formatMoney(t.amount, t.currency) },
    {
      label: 'Status',
      value: transactionStatusLabel(t),
    },
    { label: 'Account', value: `${accountLabel(t)} of ${holderLabel(t)}` },
  ];
  if (t.methodName) {
    facts.push({
      label: 'Method',
      value: t.methodReference
        ? `${t.methodName} ${t.methodReference}`
        : t.methodName,
    });
  }
  if (t.payeeName) facts.push({ label: 'Paid to', value: t.payeeName });
  if (t.claimant) facts.push({ label: 'Claimant', value: t.claimant.name });
  if (t.receiptNo) facts.push({ label: 'Receipt', value: t.receiptNo });
  if (t.transferReference) {
    facts.push({ label: 'Transfer', value: t.transferReference });
    if (t.counterpartAccountNo) {
      facts.push({
        label: 'Other side',
        value:
          `${t.counterpartAccountNo} · ${t.counterpartAccountTypeName ?? ''} ` +
          `of ${t.counterpartHolderName ?? ''}`.trim(),
      });
    }
  }
  return facts;
}

async function loadTransactionsByReference(
  references: string[]
): Promise<Map<string, TransactionSummary>> {
  const map = new Map<string, TransactionSummary>();
  if (references.length === 0) return map;
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.reference = any($1::text[])
         or (tr.reference = any($1::text[]) and t.leg_direction = 'debit')`,
    [references]
  );
  for (const row of result.rows) {
    const summary = assembleTransaction(row);
    map.set(summary.reference, summary);
    if (summary.transferReference) map.set(summary.transferReference, summary);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

interface ApplicationInfo {
  reference: string;
  kindLabel: string;
  applicantName: string;
}

const APPLICATION_KIND_LABELS: Record<string, string> = {
  membership: 'Membership',
  additional_account: 'Additional account',
  customer_account: 'Customer account',
};

function applicationSentence(row: AuditEventRow, app: ApplicationInfo): string {
  const v = asRecord(row.newValue);
  const p = asRecord(row.previousValue);
  const prevStatus = asString(p.status);
  const nextStatus = asString(v.status);
  const comment = asString(v.comment) ?? asString(v.reason);
  const commentSuffix = comment ? ` ${comment}` : '';
  const statusChange =
    prevStatus && nextStatus && prevStatus !== nextStatus
      ? ` ${APPLICATION_STATUS_LABELS[prevStatus] ?? prevStatus} → ` +
        `${APPLICATION_STATUS_LABELS[nextStatus] ?? nextStatus}.`
      : '';
  const who = app.applicantName || 'the applicant';
  const base = `${app.kindLabel} application ${app.reference} for ${who}`;

  switch (row.action) {
    case 'membership.application.started':
    case 'membership.application.started_from_customer':
    case 'membership.application.started_online':
    case 'membership.application.started_for_rejoin':
      return `${base} started.`;
    case 'membership.application.captured':
      return `${base} submitted.`;
    case 'membership.application.deleted':
      return `${base} deleted.`;
    case 'membership.application.renumbered':
      return `${base}: reference updated to ${asString(v.reference) ?? app.reference}.`;
    default:
      return `${base}.${statusChange}${commentSuffix}`;
  }
}

function applicationDetail(
  row: AuditEventRow,
  app: ApplicationInfo
): AuditDetail {
  const facts: AuditDetailFact[] = [
    { label: 'Reference', value: app.reference },
    { label: 'Kind', value: app.kindLabel },
    { label: 'Applicant', value: app.applicantName || '—' },
  ];
  const v = asRecord(row.newValue);
  const p = asRecord(row.previousValue);
  const prevStatus = asString(p.status);
  const nextStatus = asString(v.status);
  if (prevStatus || nextStatus) {
    const prevLabel = prevStatus
      ? (APPLICATION_STATUS_LABELS[prevStatus] ?? prevStatus)
      : null;
    const nextLabel = nextStatus
      ? (APPLICATION_STATUS_LABELS[nextStatus] ?? nextStatus)
      : null;
    facts.push({
      label: 'Status',
      value:
        prevLabel && nextLabel
          ? `${prevLabel} → ${nextLabel}`
          : (nextLabel ?? prevLabel ?? '—'),
    });
  }
  const comment = asString(v.comment) ?? asString(v.reason);
  if (comment) facts.push({ label: 'Comment', value: comment });
  return { sentence: applicationSentence(row, app), facts };
}

async function loadApplications(
  ids: string[]
): Promise<Map<string, ApplicationInfo>> {
  const map = new Map<string, ApplicationInfo>();
  if (ids.length === 0) return map;
  const result = await query<{
    id: string;
    reference: string;
    application_kind: string;
    rejoins_member_id: string | null;
    applicant_name: string;
  }>(
    `select a.id::text as id, a.reference, a.application_kind,
            a.rejoins_member_id::text as rejoins_member_id,
            trim(coalesce(p.values->>'name', ep.values->>'name',
                          ecp.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', ep.values->>'surname',
                             ecp.values->>'surname', ''))
              as applicant_name
       from membership_application a
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
       -- An additional_account application captures no applicant of its own
       -- (S-613) — the person is the existing member or customer it names.
       left join member em on em.id = a.existing_member_id
       left join application_party ep
         on ep.application_id = em.application_id
        and ep.subject = 'applicant' and ep.ordinal = 1
       left join customer ec on ec.id = a.existing_customer_id
       left join application_party ecp
         on ecp.application_id = ec.application_id
        and ecp.subject = 'applicant' and ecp.ordinal = 1
      where a.id = any($1::uuid[])`,
    [ids]
  );
  for (const r of result.rows) {
    const kindLabel =
      r.application_kind === 'membership' && r.rejoins_member_id
        ? 'Rejoin'
        : (APPLICATION_KIND_LABELS[r.application_kind] ?? r.application_kind);
    map.set(r.id, {
      reference: r.reference,
      kindLabel,
      applicantName: r.applicant_name.trim(),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Members and customers
// ---------------------------------------------------------------------------

interface PersonInfo {
  name: string;
  memberNo: string | null;
}

// A handful of the more common member/customer actions, phrased the way
// describeEntry already phrases them elsewhere on this same page — with the
// person's name in front, since here they are the whole point of the line.
const PERSON_ACTION_SENTENCES: Record<string, (who: string) => string> = {
  'member.created': who => `${who} created as a member.`,
  'member.contact.updated': who => `Contact details updated for ${who}.`,
  'member.details.corrected': who => `Details corrected for ${who}.`,
  'member.majority_transition': who => `${who} reached majority age.`,
  'member.migration.imported': who => `${who} imported via migration.`,
  'member.migration.updated': who => `Migrated record updated for ${who}.`,
  'member.details.applied': who => `Details change applied for ${who}.`,
  'member.details.declined': who => `Details change declined for ${who}.`,
  'member.details.requested': who => `Details change requested for ${who}.`,
  'member.link.refused': who => `Member portal link refused for ${who}.`,
  'member.link.requested': who => `Member portal link requested for ${who}.`,
  'member.signup.requested': who =>
    `Member portal signup requested for ${who}.`,
  'member.otp.resent': who => `OTP resent to ${who}.`,
  'member.otp.rejected': who => `OTP rejected for ${who}.`,
  'member.session.revoked': who => `Member session revoked for ${who}.`,
  'member.dormancy_detected': who => `${who} marked dormant.`,
  'member.reactivated': who => `${who} reactivated.`,
  'customer.created': who => `${who} recorded as a customer.`,
  'customer.converted': who => `${who} converted to a member.`,
  'customer.migration.imported': who => `${who} imported via migration.`,
  'customer.migration.updated': who => `Migrated record updated for ${who}.`,
};

function personDetail(
  row: AuditEventRow,
  kind: 'Member' | 'Customer',
  person: PersonInfo
): AuditDetail {
  const who = person.memberNo
    ? `${person.name} (${person.memberNo})`
    : person.name;
  const facts: AuditDetailFact[] = [{ label: kind, value: who }];

  const p = asRecord(row.previousValue);
  const v = asRecord(row.newValue);
  const prevStatus = asString(p.status);
  const nextStatus = asString(v.status);
  let statusChange = '';
  if (prevStatus || nextStatus) {
    const prevLabel = prevStatus ? statusLabel(prevStatus) : null;
    const nextLabel = nextStatus ? statusLabel(nextStatus) : null;
    facts.push({
      label: 'Status',
      value:
        prevLabel && nextLabel
          ? `${prevLabel} → ${nextLabel}`
          : (nextLabel ?? prevLabel ?? '—'),
    });
    if (prevLabel && nextLabel && prevLabel !== nextLabel) {
      statusChange = ` ${prevLabel} → ${nextLabel}.`;
    }
  }
  const reason = asString(v.reason);
  if (reason) facts.push({ label: 'Reason', value: reason });

  const build = PERSON_ACTION_SENTENCES[row.action];
  const base = build
    ? build(who)
    : `${who}: ${humaniseKey(row.action.split('.').pop() ?? row.action).toLowerCase()}.`;
  const sentence = `${base}${statusChange}${reason && !build ? ` ${reason}` : ''}`;
  return { sentence, facts };
}

async function loadMembers(ids: string[]): Promise<Map<string, PersonInfo>> {
  const map = new Map<string, PersonInfo>();
  if (ids.length === 0) return map;
  const result = await query<{ id: string; member_no: string; name: string }>(
    `select m.id::text as id, m.member_no,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as name
       from member m
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where m.id = any($1::uuid[])`,
    [ids]
  );
  for (const r of result.rows) {
    map.set(r.id, { name: r.name.trim() || 'Member', memberNo: r.member_no });
  }
  return map;
}

async function loadCustomers(ids: string[]): Promise<Map<string, PersonInfo>> {
  const map = new Map<string, PersonInfo>();
  if (ids.length === 0) return map;
  const result = await query<{ id: string; name: string }>(
    `select c.id::text as id,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as name
       from customer c
       left join application_party p
         on p.application_id = c.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where c.id = any($1::uuid[])`,
    [ids]
  );
  for (const r of result.rows) {
    map.set(r.id, { name: r.name.trim() || 'Customer', memberNo: null });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface DocumentInfo {
  typeName: string;
  whose: string;
  fileName: string | null;
}

function documentSentence(row: AuditEventRow, d: DocumentInfo): string {
  switch (row.action) {
    case 'document.filed':
      return `${d.typeName} filed for ${d.whose}.`;
    case 'document.verified': {
      const v = asRecord(row.newValue);
      const reason = asString(v.reason);
      return v.state === 'rejected'
        ? `${d.typeName} rejected for ${d.whose}.${reason ? ` ${reason}` : ''}`
        : `${d.typeName} verified for ${d.whose}.`;
    }
    case 'document.removed':
      return `${d.typeName} removed for ${d.whose}.`;
    case 'document.expired':
      return `${d.typeName} expired for ${d.whose}.`;
    default:
      return fallbackSentence(row);
  }
}

function documentDetail(row: AuditEventRow, d: DocumentInfo): AuditDetail {
  const facts: AuditDetailFact[] = [
    { label: 'Document', value: d.typeName },
    { label: 'For', value: d.whose },
  ];
  const fileName = d.fileName ?? asString(asRecord(row.newValue).fileName);
  if (fileName) facts.push({ label: 'File', value: fileName });
  const reason =
    asString(asRecord(row.newValue).reason) ??
    asString(asRecord(row.previousValue).rejection_reason);
  if (reason) facts.push({ label: 'Reason', value: reason });
  return { sentence: documentSentence(row, d), facts };
}

async function loadDocuments(
  ids: string[]
): Promise<Map<string, DocumentInfo>> {
  const map = new Map<string, DocumentInfo>();
  if (ids.length === 0) return map;
  const result = await query<{
    id: string;
    type_name: string;
    reference: string | null;
    transaction_reference: string | null;
    applicant_name: string | null;
    file_name: string | null;
  }>(
    `select d.id::text as id, dt.name as type_name,
            coalesce(a.reference, ma.reference, ta.reference) as reference,
            t.reference as transaction_reference,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as applicant_name,
            dv.file_name
       from document d
       join document_type dt on dt.id = d.document_type_id
       left join membership_application a on a.id = d.application_id
       left join member m on m.id = d.member_id
       left join membership_application ma on ma.id = m.application_id
       left join transaction t on t.id = d.transaction_id
       left join member tm on tm.id = t.member_id
       left join customer tc on tc.id = t.customer_id
       left join membership_application ta
         on ta.id = coalesce(tm.application_id, tc.application_id)
       left join application_party p
         on p.application_id = coalesce(a.id, ma.id, ta.id)
        and p.subject = 'applicant' and p.ordinal = 1
       left join lateral (
         select file_name from document_version
          where document_id = d.id and state = 'committed'
          order by version_no desc
          limit 1
       ) dv on true
      where d.id = any($1::uuid[])`,
    [ids]
  );
  for (const r of result.rows) {
    const name = (r.applicant_name ?? '').trim();
    const whose = r.transaction_reference
      ? r.transaction_reference
      : name && r.reference
        ? `${name} (${r.reference})`
        : (r.reference ?? name ?? 'record');
    map.set(r.id, {
      typeName: r.type_name,
      whose,
      fileName: r.file_name,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

const ACTION_SIGNED_IN = 'auth.signed_in';
const ACTION_SIGNED_OUT = 'auth.signed_out';
const ACTION_TIMED_OUT = 'auth.timed_out';

function signInDetail(row: AuditEventRow): AuditDetail {
  const v = asRecord(row.newValue);
  const signedInRaw = asString(v.signedInAt);
  const facts: AuditDetailFact[] = [];
  if (signedInRaw) {
    const signedInAt = new Date(signedInRaw);
    if (!Number.isNaN(signedInAt.getTime())) {
      facts.push({
        label: 'Session started',
        value: dateTimeFormat.format(signedInAt),
      });
    }
  }
  if (row.ipAddress) facts.push({ label: 'IP address', value: row.ipAddress });

  switch (row.action) {
    case ACTION_SIGNED_IN:
      return {
        sentence: row.ipAddress
          ? `Signed in from ${row.ipAddress}.`
          : 'Signed in.',
        facts,
      };
    case ACTION_TIMED_OUT:
      return { sentence: 'Signed out after inactivity.', facts };
    case ACTION_SIGNED_OUT:
      return { sentence: 'Signed out.', facts };
    default:
      return genericDetail(row);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function describeAuditDetail(
  rows: AuditEventRow[]
): Promise<Map<string, AuditDetail>> {
  const result = new Map<string, AuditDetail>();
  if (rows.length === 0) return result;

  const txRefs = new Set<string>();
  const appIds = new Set<string>();
  const memberIds = new Set<string>();
  const customerIds = new Set<string>();
  const documentIds = new Set<string>();

  for (const row of rows) {
    switch (row.entityType) {
      case 'transaction':
        txRefs.add(row.entityId);
        break;
      case 'membership_application':
        appIds.add(row.entityId);
        break;
      case 'member':
        memberIds.add(row.entityId);
        break;
      case 'customer':
        customerIds.add(row.entityId);
        break;
      case 'document':
        documentIds.add(row.entityId);
        break;
      default:
        break;
    }
  }

  const [transactions, applications, members, customers, documents] =
    await Promise.all([
      loadTransactionsByReference([...txRefs]),
      loadApplications([...appIds]),
      loadMembers([...memberIds]),
      loadCustomers([...customerIds]),
      loadDocuments([...documentIds]),
    ]);

  for (const row of rows) {
    // Never throws for an unknown shape (officer feedback): whatever this
    // row turns out to be, the page still gets a detail row rather than a
    // broken page.
    try {
      let detail: AuditDetail | null = null;
      if (row.entityType === 'transaction') {
        const t = transactions.get(row.entityId);
        if (t)
          detail = {
            sentence: transactionSentence(row, t),
            facts: transactionFacts(t),
          };
      } else if (row.entityType === 'membership_application') {
        const app = applications.get(row.entityId);
        if (app) detail = applicationDetail(row, app);
      } else if (row.entityType === 'member') {
        const person = members.get(row.entityId);
        if (person) detail = personDetail(row, 'Member', person);
      } else if (row.entityType === 'customer') {
        const person = customers.get(row.entityId);
        if (person) detail = personDetail(row, 'Customer', person);
      } else if (row.entityType === 'document') {
        const doc = documents.get(row.entityId);
        if (doc) detail = documentDetail(row, doc);
      } else if (row.entityType === 'auth_session') {
        detail = signInDetail(row);
      } else if (row.action.startsWith('config.')) {
        detail = configDetail(row);
      }
      result.set(row.id, detail ?? genericDetail(row));
    } catch (error) {
      console.error(
        '[audit-detail] could not describe',
        row.action,
        row.entityType,
        row.entityId,
        error
      );
      result.set(row.id, genericDetail(row));
    }
  }

  return result;
}
