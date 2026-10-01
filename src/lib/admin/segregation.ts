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
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';

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

// What the Segregation of duties page offers (officer feedback: the rules
// were a table and a permission, with no screen to see or change them).
//
// A rule is only a control if the code asks about its later action before
// performing it, so the page offers exactly those — the checkSegregation
// call sites (workflow.ts, documents.ts, payments.ts, review.ts,
// reversals.ts, receipts.ts) — and, as the earlier action, the ones those
// records are audited under with the same entity id. A pair outside this
// catalogue would save and never refuse anyone, which is worse than no rule.
export interface SegregationAction {
  action: string;
  // Completes "Whoever … it" / "may not … it".
  past: string;
  present: string;
}

export interface SegregationRecordType {
  entityType: string;
  label: string;
  // "an application", "a transaction": for the sentence a new rule is
  // described by, which is also what a refused officer reads.
  noun: string;
  earlier: SegregationAction[];
  later: SegregationAction[];
}

const APP = 'membership.application';
export const SEGREGATION_CATALOGUE: SegregationRecordType[] = [
  {
    entityType: 'membership_application',
    label: 'Applications',
    noun: 'an application',
    earlier: [
      { action: `${APP}.captured`, past: 'captured', present: 'capture' },
      {
        action: `${APP}.regional_reviewed`,
        past: 'gave regional oversight to',
        present: 'give regional oversight to',
      },
      { action: `${APP}.reviewed`, past: 'reviewed', present: 'review' },
    ],
    later: [
      {
        action: `${APP}.regional_reviewed`,
        past: 'gave regional oversight to',
        present: 'give regional oversight to',
      },
      { action: `${APP}.reviewed`, past: 'reviewed', present: 'review' },
      { action: `${APP}.approved`, past: 'approved', present: 'approve' },
    ],
  },
  {
    entityType: 'document',
    label: 'Documents',
    noun: 'a document',
    earlier: [{ action: 'document.filed', past: 'filed', present: 'file' }],
    later: [
      { action: 'document.verified', past: 'verified', present: 'verify' },
    ],
  },
  {
    entityType: 'payment',
    label: 'Payments',
    noun: 'a payment',
    earlier: [
      {
        action: 'membership.payment.recorded',
        past: 'recorded',
        present: 'record',
      },
    ],
    later: [
      {
        action: 'membership.payment.refunded',
        past: 'refunded',
        present: 'refund',
      },
      { action: 'membership.payment.voided', past: 'voided', present: 'void' },
    ],
  },
  {
    entityType: 'transaction',
    label: 'Transactions',
    noun: 'a transaction',
    earlier: [
      { action: 'transaction.captured', past: 'captured', present: 'capture' },
      { action: 'transaction.reviewed', past: 'reviewed', present: 'review' },
      { action: 'transaction.approved', past: 'approved', present: 'approve' },
    ],
    later: [
      { action: 'transaction.reviewed', past: 'reviewed', present: 'review' },
      { action: 'transaction.approved', past: 'approved', present: 'approve' },
      {
        action: 'transaction.posted',
        past: 'posted or disbursed',
        present: 'post or disburse',
      },
      { action: 'transaction.reversed', past: 'reversed', present: 'reverse' },
      {
        action: 'transaction.voided',
        past: 'voided the receipt of',
        present: 'void the receipt of',
      },
    ],
  },
];

export class SegregationError extends Error {}

interface Actor {
  userId: string;
  email: string;
}

// Switch a rule on or off. Never deleted: a rule switched off still shows
// what was once enforced, and when it stopped is on the audit trail.
export async function setSegregationRuleEnabled(
  ruleId: string,
  enabled: boolean,
  actor: Actor
): Promise<void> {
  await withTransaction(async client => {
    const current = await client.query<{
      is_enabled: boolean;
      description: string;
    }>(
      `select is_enabled, description from segregation_rule
        where id = $1 for update`,
      [ruleId]
    );
    const rule = current.rows[0];
    if (!rule) throw new SegregationError('That rule no longer exists.');
    if (rule.is_enabled === enabled) return;
    await client.query(
      `update segregation_rule set is_enabled = $2 where id = $1`,
      [ruleId, enabled]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: enabled
          ? 'segregation.rule.enabled'
          : 'segregation.rule.disabled',
        entityType: 'segregation_rule',
        entityId: ruleId,
        previousValue: { isEnabled: rule.is_enabled },
        newValue: { isEnabled: enabled, description: rule.description },
      },
      client
    );
  });
}

// Add a pair from the catalogue. The description is written from the pair
// rather than typed, so what a refused officer reads always says what the
// rule actually does. A pair already on file (switched off, say) is
// switched on instead of refused.
export async function addSegregationRule(
  input: { entityType: string; earlierAction: string; laterAction: string },
  actor: Actor
): Promise<void> {
  const type = SEGREGATION_CATALOGUE.find(
    t => t.entityType === input.entityType
  );
  const earlier = type?.earlier.find(a => a.action === input.earlierAction);
  const later = type?.later.find(a => a.action === input.laterAction);
  if (!type || !earlier || !later) {
    throw new SegregationError('Choose both actions.');
  }
  if (earlier.action === later.action) {
    throw new SegregationError('Choose two different actions.');
  }
  const description = `Whoever ${earlier.past} ${type.noun} may not ${later.present} it.`;

  await withTransaction(async client => {
    const existing = await client.query<{ id: string; is_enabled: boolean }>(
      `select id, is_enabled from segregation_rule
        where entity_type = $1 and earlier_action = $2 and later_action = $3
        for update`,
      [type.entityType, earlier.action, later.action]
    );
    if (existing.rows[0]?.is_enabled) {
      throw new SegregationError('That rule is already on.');
    }
    let id = existing.rows[0]?.id;
    if (id) {
      await client.query(
        `update segregation_rule set is_enabled = true where id = $1`,
        [id]
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `insert into segregation_rule
           (entity_type, earlier_action, later_action, description)
         values ($1, $2, $3, $4) returning id`,
        [type.entityType, earlier.action, later.action, description]
      );
      id = inserted.rows[0].id;
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: existing.rows[0]
          ? 'segregation.rule.enabled'
          : 'segregation.rule.added',
        entityType: 'segregation_rule',
        entityId: id,
        newValue: {
          earlierAction: earlier.action,
          laterAction: later.action,
          isEnabled: true,
        },
      },
      client
    );
  });
}
