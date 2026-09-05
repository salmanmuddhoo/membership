// Writing to the append-only audit trail (FRD Section 10).
//
// The table refuses updates and deletes, so the only thing this module can do
// is add a record. Two rules govern how it is used:
//
//   * A business change and its audit entry must land together. Pass the
//     transaction's client so both commit or neither does — writing the audit
//     row on a separate connection would leave a record of a change that was
//     rolled back.
//   * Failing to record an action is not a reason to fail the action itself in
//     every case, but it is never silent. Callers recording a security event
//     (a refusal, a rejected principal) should let the error propagate; callers
//     recording an incidental action may use recordAuditQuietly.
import type { PoolClient } from 'pg';
import { query } from '../db/pool';

export interface AuditEntry {
  // Null only for the system acting on its own behalf, which actorDescription
  // must then name (a scheduled job, the migration runner).
  actorUserId?: string | null;
  actorDescription: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: unknown;
  newValue?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
}

const INSERT = `
  insert into audit_event (
    actor_user_id, actor_description, action, entity_type, entity_id,
    previous_value, new_value, request_id, ip_address
  ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

function params(entry: AuditEntry): unknown[] {
  return [
    entry.actorUserId ?? null,
    entry.actorDescription,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.previousValue === undefined
      ? null
      : JSON.stringify(entry.previousValue),
    entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
    entry.requestId ?? null,
    entry.ipAddress ?? null,
  ];
}

// Record an action. Pass `client` when inside withTransaction() so the entry
// shares the transaction with the change it describes.
export async function recordAudit(
  entry: AuditEntry,
  client?: PoolClient
): Promise<void> {
  if (client) {
    await client.query(INSERT, params(entry));
    return;
  }
  await query(INSERT, params(entry));
}

// Record an action without letting a logging failure break the request.
//
// Only for entries that are not themselves the security control — an access
// refusal still refuses if this fails, but the operator needs to know the trail
// has a hole, so the failure is logged loudly rather than swallowed.
export async function recordAuditQuietly(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch (error) {
    console.error(
      '[audit] FAILED TO RECORD:',
      entry.action,
      entry.entityId,
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Reading the trail (audit.view) — a page over it, not a table dump.
// ---------------------------------------------------------------------------

export interface AuditEventRow {
  id: string;
  occurredAt: Date;
  // The user's current display name where the actor is still a real account;
  // actor_description otherwise (a scheduled job, or a user since removed —
  // this is history, not a live reference, so a deleted account's row keeps
  // whatever it said at the time rather than going blank).
  actorName: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previousValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
}

export interface AuditEventFilters {
  // Matches against the actor's current display name/email, or their
  // recorded description where there is no live account.
  actor?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditEventPage {
  events: AuditEventRow[];
  total: number;
}

export const AUDIT_PAGE_LIMIT = 100;

export async function listAuditEvents(
  filters: AuditEventFilters = {}
): Promise<AuditEventPage> {
  const limit = Math.min(Math.max(filters.limit ?? AUDIT_PAGE_LIMIT, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await query<{
    id: string;
    occurred_at: Date;
    actor_name: string;
    actor_email: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    previous_value: unknown;
    new_value: unknown;
    ip_address: string | null;
    total_count: string;
  }>(
    // count(*) over () is evaluated before LIMIT/OFFSET, so it reports the
    // size of the whole match, not of the page.
    `select e.id::text as id, e.occurred_at, e.action, e.entity_type,
            e.entity_id, e.previous_value, e.new_value,
            e.ip_address::text as ip_address,
            coalesce(u.display_name, e.actor_description) as actor_name,
            u.email::text as actor_email,
            count(*) over () as total_count
       from audit_event e
       left join app_user u on u.id = e.actor_user_id
      where ($1::text is null or e.action = $1::text)
        and ($2::text is null or e.entity_type = $2::text)
        and ($3::text is null or e.entity_id = $3::text)
        and ($4::timestamptz is null or e.occurred_at >= $4::timestamptz)
        and ($5::timestamptz is null or e.occurred_at <= $5::timestamptz)
        and (
          $6::text is null
          or strpos(
               lower(coalesce(u.display_name, e.actor_description)),
               lower($6::text)
             ) > 0
          or strpos(lower(coalesce(u.email::text, '')), lower($6::text)) > 0
        )
      order by e.occurred_at desc
      limit $7::int offset $8::int`,
    [
      filters.action ?? null,
      filters.entityType ?? null,
      filters.entityId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.actor ?? null,
      limit,
      offset,
    ]
  );

  return {
    events: result.rows.map(r => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorName: r.actor_name,
      actorEmail: r.actor_email,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      previousValue: r.previous_value,
      newValue: r.new_value,
      ipAddress: r.ip_address,
    })),
    total: result.rowCount ? Number(result.rows[0].total_count) : 0,
  };
}

// For the filter dropdowns — every action and entity type actually on file,
// rather than a list maintained by hand that drifts from what the code
// really records.
export async function distinctAuditActions(): Promise<string[]> {
  const result = await query<{ action: string }>(
    'select distinct action from audit_event order by action'
  );
  return result.rows.map(r => r.action);
}

export async function distinctAuditEntityTypes(): Promise<string[]> {
  const result = await query<{ entity_type: string }>(
    'select distinct entity_type from audit_event order by entity_type'
  );
  return result.rows.map(r => r.entity_type);
}
