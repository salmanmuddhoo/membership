// How long each kind of record is kept (S-1003).
//
// The Society states its retention periods here, in the application, rather
// than in a message somebody then has to translate into code. Every period
// starts unset, and unset means retain indefinitely — the behaviour this
// system has always had. Nothing is disposed of until a number is entered.
//
// Disposal itself is in ./disposal.ts. This module is only the policy: what
// the classes are, what each one is currently set to, and who changed it.
import { ConfigError } from '../config/reference';
import { query, withConfigurationActor } from '../db/pool';

// The classes, in the order the screen shows them. Seeded by migration 0061;
// this union is what the rest of the code may name, so a typo is a type error
// rather than a policy that silently never matches a row.
export type RetentionClass =
  | 'notification_log'
  | 'rejected_application'
  | 'abandoned_draft'
  // S-1703: a former member's documents, anchored on the day the
  // membership ended (member.status_changed_at) — the anchor the first
  // release of this module said it did not have (docs/retention.md).
  | 'former_member_documents';

export interface RetentionPolicy {
  code: RetentionClass;
  label: string;
  // Null means retain indefinitely. Not zero, and not a sentinel: the absence
  // of a period is a different thing from a period of none, and the database
  // says so too.
  periodMonths: number | null;
}

// A period below this would dispose of records an officer is plausibly still
// working with, and there is no undo. It is not a legal floor — it is a guard
// against 6 being typed where 60 was meant, which is the realistic way this
// control goes wrong.
export const MINIMUM_PERIOD_MONTHS = 6;

// Fifty years. Anything beyond this is indistinguishable from "keep forever",
// which the screen already offers by leaving the field empty, and a five-digit
// period is far more likely to be a slip than an intention.
export const MAXIMUM_PERIOD_MONTHS = 600;

export async function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  const result = await query<{
    code: RetentionClass;
    label: string;
    period_months: number | null;
  }>(
    `select code, label, period_months
       from retention_policy
      order by sort_order, label`
  );

  return result.rows.map(row => ({
    code: row.code,
    label: row.label,
    periodMonths: row.period_months,
  }));
}

export async function retentionPeriod(
  code: RetentionClass
): Promise<number | null> {
  const result = await query<{ period_months: number | null }>(
    'select period_months from retention_policy where code = $1',
    [code]
  );
  return result.rows[0]?.period_months ?? null;
}

/**
 * Set or clear one class's period.
 *
 * Clearing is always allowed and always safe: it stops disposal, it does not
 * bring anything back. Setting is what needs the guards above.
 */
export async function setRetentionPeriod(
  code: RetentionClass,
  periodMonths: number | null,
  actor: { userId: string; email: string }
): Promise<void> {
  if (periodMonths !== null) {
    if (!Number.isInteger(periodMonths)) {
      throw new ConfigError('Enter a whole number of months.');
    }
    if (periodMonths < MINIMUM_PERIOD_MONTHS) {
      throw new ConfigError(
        `The shortest period that can be set is ${MINIMUM_PERIOD_MONTHS} months.`
      );
    }
    if (periodMonths > MAXIMUM_PERIOD_MONTHS) {
      throw new ConfigError(
        `The longest period that can be set is ${MAXIMUM_PERIOD_MONTHS} months. ` +
          'Leave it empty to keep records indefinitely.'
      );
    }
  }

  await withConfigurationActor(
    { userId: actor.userId, description: actor.email },
    async client => {
      const result = await client.query(
        'update retention_policy set period_months = $2 where code = $1',
        [code, periodMonths]
      );
      if (result.rowCount === 0) {
        throw new ConfigError(
          'That record type no longer exists.',
          'not_found'
        );
      }
    }
  );
}
