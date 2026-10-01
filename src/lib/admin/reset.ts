// Wiping a test environment back to empty (System Administrator only).
//
// "All data" here means everything anyone did: every member, application,
// document, payment, transaction and receipt, every message sent, the audit
// log (sign-ins included), the history of job runs and of setting changes,
// with every reference number starting again — and every staff account but
// the System Administrator running it (the last one left is how the others
// get added back). Roles and permissions, API credentials and all
// configuration are kept: this is a test environment emptied, not a factory
// reset of the system that runs it. The latest
// reset_all_test_data() migration says exactly what is removed, and
// reset.test.ts fails when a table is added without deciding which side it
// is on.
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
  transactions: number;
  // Staff accounts other than the one looking at the screen: the reset
  // removes all of them.
  otherStaff: number;
}

// What the confirmation screen shows before anyone commits to the button —
// the scale of what "all data" actually means right now, not an abstraction.
export async function countsBeforeReset(
  viewerUserId: string
): Promise<ResetCounts> {
  const result = await query<{
    members: string;
    applications: string;
    payments: string;
    documents: string;
    transactions: string;
    other_staff: string;
  }>(
    `select
       (select count(*) from member)                as members,
       (select count(*) from membership_application) as applications,
       (select count(*) from payment)                as payments,
       (select count(*) from document)                as documents,
       (select count(*) from transaction)             as transactions,
       (select count(*) from app_user where id <> $1) as other_staff`,
    [viewerUserId]
  );
  const row = result.rows[0];
  return {
    members: Number(row.members),
    applications: Number(row.applications),
    payments: Number(row.payments),
    documents: Number(row.documents),
    transactions: Number(row.transactions),
    otherStaff: Number(row.other_staff),
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
