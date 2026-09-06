// What a member app session may read about itself: the record, the
// accounts, the documents — and the one thing it may write, a capture of its
// own details for staff to verify (docs/member-app.md).
//
// Everything here is scoped by the principal. There is no "load member by
// id" a caller could point elsewhere: the id comes from the session, and a
// query that does not filter on it does not exist in this file.
import { recordAudit } from '../access/audit';
import { ApiError } from '../api/envelope';
import { PhoneFormatError, toInternational } from '../applications/phone';
import { visibleFields, type PartyValues } from '../applications/capture';
import {
  listMembershipTypes,
  type FieldSubject,
  type MembershipType,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  documentsForMember,
  type ChecklistState,
} from '../documents/documents';
import { fromCents, toCents } from '../payments/money';
import { transactionsForAccount } from '../payments/payments';
import type { MemberPrincipal, RequestOrigin } from './identity';
import { maskMobile } from './otp';

export interface MemberProfile {
  kind: MemberPrincipal['kind'];
  memberNo: string | null;
  status: string;
  joinedAt: string | null;
  membershipType: { code: string; name: string } | null;
  parties: PartyValues[];
  pendingUpdate: { id: string; submittedAt: string } | null;
}

export async function memberProfile(
  principal: MemberPrincipal
): Promise<MemberProfile> {
  if (!principal.memberId) {
    return {
      kind: principal.kind,
      memberNo: null,
      status: 'none',
      joinedAt: null,
      membershipType: null,
      parties: [],
      pendingUpdate: null,
    };
  }

  const [member, parties, pending] = await Promise.all([
    query<{
      member_no: string;
      status: string;
      joined_at: Date;
      type_code: string;
      type_name: string;
      application_id: string | null;
    }>(
      `select m.member_no, m.status, m.joined_at, t.code as type_code,
              t.name as type_name, m.application_id
         from member m
         join membership_type t on t.id = m.membership_type_id
        where m.id = $1`,
      [principal.memberId]
    ),
    query<{
      subject: FieldSubject;
      ordinal: number;
      values: Record<string, string>;
    }>(
      `select p.subject, p.ordinal, p.values
         from application_party p
         join member m on m.application_id = p.application_id
        where m.id = $1
        order by p.subject, p.ordinal`,
      [principal.memberId]
    ),
    query<{ id: string; submitted_at: Date }>(
      `select id, submitted_at from member_details_request
        where member_id = $1 and status = 'pending'`,
      [principal.memberId]
    ),
  ]);
  const row = member.rows[0];
  if (!row)
    throw new ApiError('not_found', 'That member record no longer exists.');

  return {
    kind: 'member',
    memberNo: row.member_no,
    status: row.status,
    joinedAt: row.joined_at.toISOString(),
    membershipType: { code: row.type_code, name: row.type_name },
    parties: parties.rows.map(p => ({
      subject: p.subject,
      ordinal: p.ordinal,
      values: p.values,
    })),
    pendingUpdate: pending.rows[0]
      ? {
          id: pending.rows[0].id,
          submittedAt: pending.rows[0].submitted_at.toISOString(),
        }
      : null,
  };
}

// --- Accounts ----------------------------------------------------------------

export interface AccountSummary {
  id: string;
  accountNo: string;
  typeCode: string;
  typeName: string;
  category: string;
  status: string;
  openedAt: string;
  // Decimal string. Null when nothing has been recorded against the
  // account: there is no ledger yet (docs/payments.md), only the payment
  // that opened it and any refund, so an account with neither has no
  // figure this can honestly state.
  balance: string | null;
}

export async function memberAccounts(
  principal: MemberPrincipal
): Promise<AccountSummary[]> {
  if (!principal.memberId && !principal.customerId) return [];

  const rows = await query<{
    id: string;
    account_no: string | null;
    member_no: string | null;
    type_code: string;
    type_name: string;
    category: string;
    status: string;
    opened_at: Date;
  }>(
    `select a.id, a.account_no, m.member_no, t.code as type_code,
            t.name as type_name, t.category, a.status, a.opened_at
       from account a
       join account_type t on t.id = a.account_type_id
       left join member m on m.id = a.member_id
      where ($1::uuid is not null and a.member_id = $1::uuid)
         or ($2::uuid is not null and a.customer_id = $2::uuid)
      order by t.sort_order, t.name`,
    [principal.memberId, principal.customerId]
  );

  return Promise.all(
    rows.rows.map(async r => {
      const transactions = await transactionsForAccount(r.id);
      const cents = transactions.reduce(
        (sum, t) => sum + (t.type === 'debit' ? -1 : 1) * toCents(t.amount),
        0
      );
      return {
        id: r.id,
        // A Shares or MSA account carries the member's own number
        // (migration 0018); one carried over from a customer keeps its own.
        accountNo: r.account_no ?? r.member_no ?? '',
        typeCode: r.type_code,
        typeName: r.type_name,
        category: r.category,
        status: r.status,
        openedAt: r.opened_at.toISOString(),
        balance: transactions.length > 0 ? fromCents(cents) : null,
      };
    })
  );
}

export interface AccountTransaction {
  id: string;
  occurredAt: string;
  direction: 'credit' | 'debit';
  amount: string;
  description: string;
  receiptNo: string | null;
}

export async function accountTransactions(
  principal: MemberPrincipal,
  accountId: string
): Promise<AccountTransaction[]> {
  const owned = await query<{ id: string }>(
    `select id from account
      where id = $1::uuid
        and (($2::uuid is not null and member_id = $2::uuid)
          or ($3::uuid is not null and customer_id = $3::uuid))`,
    [
      isUuid(accountId) ? accountId : null,
      principal.memberId,
      principal.customerId,
    ]
  );
  if (owned.rowCount === 0) throw new ApiError('not_found', 'No such account.');

  return (await transactionsForAccount(accountId)).map((t, i) => ({
    id: `${accountId}:${i}`,
    occurredAt: t.occurredAt.toISOString(),
    direction: t.type,
    amount: t.amount,
    description: t.description,
    receiptNo: null,
  }));
}

// --- Documents ---------------------------------------------------------------

export interface FiledDocument {
  id: string;
  documentCode: string;
  documentName: string;
  status: 'pending' | 'filed' | 'verified' | 'rejected';
  filedAt: string;
  expiresAt: string | null;
}

// The checklist's own states, as a member needs to read them. Under review
// and uploaded are both "filed" from the outside; expired reads as rejected,
// which is what it means for the person: bring a new one.
export function memberDocumentState(
  state: ChecklistState
): FiledDocument['status'] {
  switch (state) {
    case 'verified':
      return 'verified';
    case 'rejected':
    case 'expired':
      return 'rejected';
    default:
      return 'filed';
  }
}

export async function memberDocuments(
  principal: MemberPrincipal
): Promise<FiledDocument[]> {
  if (!principal.memberId) return [];
  const member = await query<{ application_id: string | null }>(
    `select application_id from member where id = $1`,
    [principal.memberId]
  );
  const groups = await documentsForMember(
    principal.memberId,
    member.rows[0]?.application_id ?? null
  );
  return groups.flatMap(group =>
    group.entries.map(e => ({
      id:
        e.documentId ??
        `${group.applicationId}:${e.documentTypeId}:${e.subject}`,
      documentCode: e.documentCode,
      documentName: e.documentName,
      status: memberDocumentState(e.state),
      filedAt: (e.uploadedAt ?? new Date(0)).toISOString(),
      expiresAt: e.expiresAt?.toISOString() ?? null,
    }))
  );
}

// --- A member's own capture of their details ------------------------------

export interface ChangeRequest {
  id: string;
  status: 'pending' | 'applied' | 'declined';
  submittedAt: string;
}

// The values as the form would have them: only fields the type configures,
// phones in international form, every mandatory field present. Refused with
// the fields named, all of them at once — the same rule as submission.
export function checkDetails(
  type: MembershipType,
  parties: PartyValues[]
): { parties: PartyValues[]; details: Record<string, string[]> } {
  const fields = visibleFields(type);
  const details: Record<string, string[]> = {};
  const seen = new Set<string>();
  const cleaned: PartyValues[] = [];

  for (const party of parties) {
    const subjectFields = fields.get(party.subject);
    if (!subjectFields) continue; // a subject this type does not configure
    const key = `${party.subject}.${party.ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const values: Record<string, string> = {};
    for (const field of subjectFields) {
      const raw = String(party.values?.[field.fieldKey] ?? '').trim();
      const path = `${party.subject}.${party.ordinal}.${field.fieldKey}`;
      if (raw === '') {
        if (
          field.isMandatory &&
          !(party.subject === 'nominee' && party.ordinal !== 1)
        ) {
          details[path] = [`${field.label} is required.`];
        }
        continue;
      }
      if (field.dataType === 'phone') {
        try {
          values[field.fieldKey] = toInternational(raw);
        } catch (error) {
          details[path] = [
            error instanceof PhoneFormatError
              ? error.message
              : 'Check this number.',
          ];
        }
        continue;
      }
      if (field.dataType === 'choice' && !field.choices.includes(raw)) {
        details[path] = [`Choose one of: ${field.choices.join(', ')}.`];
        continue;
      }
      values[field.fieldKey] = raw;
    }
    cleaned.push({ subject: party.subject, ordinal: party.ordinal, values });
  }

  return { parties: cleaned, details };
}

export async function submitDetails(
  principal: MemberPrincipal,
  parties: PartyValues[],
  origin: RequestOrigin
): Promise<ChangeRequest> {
  if (!principal.memberId) {
    throw new ApiError('forbidden', 'Only a member can update member details.');
  }
  const member = await query<{ type_id: string; status: string }>(
    `select membership_type_id as type_id, status from member where id = $1`,
    [principal.memberId]
  );
  const row = member.rows[0];
  if (!row)
    throw new ApiError('not_found', 'That member record no longer exists.');
  const type = (await listMembershipTypes()).find(t => t.id === row.type_id);
  if (!type) throw new ApiError('not_found', 'Unknown membership type.');

  const checked = checkDetails(type, Array.isArray(parties) ? parties : []);
  // The number the member signs in with changes at a branch, with ID: a
  // request cannot move it.
  for (const party of checked.parties) {
    if (party.subject === 'applicant' && 'mobile' in party.values) {
      party.values.mobile = principal.mobile;
    }
  }
  if (Object.keys(checked.details).length > 0) {
    throw new ApiError(
      'validation_failed',
      'Some details need attention.',
      checked.details
    );
  }

  return withTransaction(async client => {
    let inserted: { id: string; submitted_at: Date };
    try {
      const result = await client.query<{ id: string; submitted_at: Date }>(
        `insert into member_details_request (member_id, session_id, parties)
         values ($1, $2, $3::jsonb)
         returning id, submitted_at`,
        [
          principal.memberId,
          principal.sessionId,
          JSON.stringify(checked.parties),
        ]
      );
      inserted = result.rows[0];
    } catch (error) {
      // The partial unique index: one open request per member.
      if ((error as { code?: string })?.code === '23505') {
        throw new ApiError(
          'conflict',
          'An update is already waiting for staff to verify it.'
        );
      }
      throw error;
    }

    await recordAudit(
      {
        actorDescription: `member-app:${maskMobile(principal.mobile)}`,
        action: 'member.details.requested',
        entityType: 'member',
        entityId: principal.memberId!,
        newValue: { requestId: inserted.id, sessionId: principal.sessionId },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      },
      client
    );

    return {
      id: inserted.id,
      status: 'pending',
      submittedAt: inserted.submitted_at.toISOString(),
    };
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}
