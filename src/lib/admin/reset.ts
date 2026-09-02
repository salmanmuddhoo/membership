// Wiping a test environment back to empty (System Administrator only).
//
// "All data" here means every member, application, document, payment and
// receipt — and their permanent history, application_transition and
// audit_event included. Staff accounts, roles and permissions, and reference
// configuration (membership types, fee schedules, the document checklist,
// workflow steps) are untouched: this is a test environment being reset, not
// a factory reset of the system that runs it. See migration 0019 for exactly
// what gets removed and why it is safe to.
//
// The refusal below is the one that matters most: it runs before any
// connection to the database is even opened, on the same PUBLIC_APP_ENV
// signal the rest of the app already trusts for "is this really a test
// environment" (see isProductionEnvironment in ../config). The database has
// its own, independent guard behind this one — see migration 0019 — so a
// mistake here is stopped twice, not once.
import { isProductionEnvironment } from '../config';
import { query } from '../db/pool';

export class ResetError extends Error {
  constructor(
    message: string,
    readonly reason: 'production' | 'forbidden'
  ) {
    super(message);
    this.name = 'ResetError';
  }
}

export interface ResetActor {
  userId: string;
  email: string;
}

export interface ResetCounts {
  members: number;
  applications: number;
  payments: number;
  documents: number;
}

// What the confirmation screen shows before anyone commits to the button —
// the scale of what "all data" actually means right now, not an abstraction.
export async function countsBeforeReset(): Promise<ResetCounts> {
  const result = await query<{
    members: string;
    applications: string;
    payments: string;
    documents: string;
  }>(
    `select
       (select count(*) from member)                as members,
       (select count(*) from membership_application) as applications,
       (select count(*) from payment)                as payments,
       (select count(*) from document)                as documents`
  );
  const row = result.rows[0];
  return {
    members: Number(row.members),
    applications: Number(row.applications),
    payments: Number(row.payments),
    documents: Number(row.documents),
  };
}

// Permanently deletes every member, application, document, payment and
// receipt in the database, on a test environment only.
export async function resetAllTestData(actor: ResetActor): Promise<void> {
  if (isProductionEnvironment()) {
    throw new ResetError(
      'This deployment is not marked as a test environment ' +
        '(PUBLIC_APP_ENV), so this cannot run here.',
      'production'
    );
  }

  await query('select reset_all_test_data($1, $2)', [
    actor.userId,
    actor.email,
  ]);
}
