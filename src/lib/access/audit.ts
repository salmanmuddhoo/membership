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
