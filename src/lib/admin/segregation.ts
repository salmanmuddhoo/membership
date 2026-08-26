// Segregation of duties (S-203).
//
// The rule is not "these two roles may not be held together" — a Regional
// Officer who also covers Clerk duties is exactly what FRD 6.1 describes, and
// blocking the combination would break the operating model. The rule is that
// one person may not perform two conflicting actions ON THE SAME RECORD. So the
// check is per record, at the moment of acting.
//
// What makes this trustworthy is where the history comes from: audit_event,
// which is append-only and refuses UPDATE, DELETE and TRUNCATE even to the
// table owner. Someone cannot erase their earlier action to unblock the later
// one. The control and the evidence are the same rows.
import { query } from '../db/pool';

export interface SegregationRule {
  id: string;
  entityType: string;
  earlierAction: string;
  laterAction: string;
  description: string;
  isEnabled: boolean;
}

export interface SegregationVerdict {
  allowed: boolean;
  // Present when refused, so the person is told which earlier action of theirs
  // is in the way rather than simply being denied.
  conflict?: {
    earlierAction: string;
    description: string;
    performedAt: Date;
  };
}

// One query: for the action being attempted, find any enabled rule whose
// earlier action this same person already performed on this same record.
//
// Joining the rules to the audit log rather than fetching rules and then
// checking each keeps it to a single round trip on a path that runs before
// every governed action.
const CONFLICT_QUERY = `
  select r.earlier_action,
         r.description,
         a.occurred_at
    from segregation_rule r
    join audit_event a
      on a.action = r.earlier_action
     and a.entity_type = r.entity_type
     and a.entity_id = $3
     and a.actor_user_id = $1
   where r.is_enabled
     and r.entity_type = $2
     and r.later_action = $4
   order by a.occurred_at asc
   limit 1
`;

// May this user perform `action` on this record?
export async function checkSegregation(
  userId: string,
  entityType: string,
  entityId: string,
  action: string
): Promise<SegregationVerdict> {
  const result = await query<{
    earlier_action: string;
    description: string;
    occurred_at: Date;
  }>(CONFLICT_QUERY, [userId, entityType, entityId, action]);

  const row = result.rows[0];
  if (!row) return { allowed: true };

  return {
    allowed: false,
    conflict: {
      earlierAction: row.earlier_action,
      description: row.description,
      performedAt: row.occurred_at,
    },
  };
}

export async function listSegregationRules(): Promise<SegregationRule[]> {
  const result = await query<{
    id: string;
    entity_type: string;
    earlier_action: string;
    later_action: string;
    description: string;
    is_enabled: boolean;
  }>(
    `select id, entity_type, earlier_action, later_action, description, is_enabled
       from segregation_rule
      order by entity_type, later_action, earlier_action`
  );

  return result.rows.map(r => ({
    id: r.id,
    entityType: r.entity_type,
    earlierAction: r.earlier_action,
    laterAction: r.later_action,
    description: r.description,
    isEnabled: r.is_enabled,
  }));
}
