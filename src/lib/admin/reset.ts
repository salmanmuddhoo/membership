// Wiping an environment back to empty (System Administrator only).
//
// "All data" here means everything anyone did: every member, application,
// document, payment, transaction and receipt, every message sent, the audit
// log (sign-ins included), the history of job runs and of setting changes,
// with every reference number starting again — and every staff account but
// the System Administrator running it (the last one left is how the others
// get added back). Roles and permissions, API credentials and all
// configuration are kept: this is an environment emptied, not a factory
// reset of the system that runs it. The latest
// reset_all_test_data() migration says exactly what is removed, and
// reset.test.ts fails when a table is added without deciding which side it
// is on.
//
// Officer direction, 14 October 2026: available in production too, to
// whoever holds system.reset_data (the System Administrator by default,
// migration 0129). It was refused outright there until then. In production
// two things stand in front of it instead: the confirmation phrase is a
// longer one (reset-data.astro), and the export of every member with their
// balances is saved to SharePoint first (backupBeforeReset) — a reset that
// cannot save that copy removes nothing. Test is reset without one, as it
// always was.
import { isProductionEnvironment } from '../config';
import { query } from '../db/pool';
import { GraphError } from '../documents/graph';
import { backupBeforeReset } from '../migration/backup';

export class ResetError extends Error {
  constructor(
    message: string,
    readonly reason: 'backup_failed' | 'forbidden'
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

export interface SavedBackup {
  folder: string;
  fileName: string;
  transactionsFileName?: string;
}

export interface ResetOutcome {
  // The copy saved to SharePoint first, in production; null on Test.
  backup: SavedBackup | null;
}

// Permanently deletes every member, application, document, payment and
// receipt in the database — in production, only once the export is saved.
export async function resetAllTestData(
  actor: ResetActor,
  options: { backup?: () => Promise<SavedBackup> } = {}
): Promise<ResetOutcome> {
  let backup: ResetOutcome['backup'] = null;
  if (isProductionEnvironment()) {
    try {
      backup = await (options.backup ?? (() => backupBeforeReset()))();
    } catch (error) {
      console.error('[admin/reset] backup before reset failed', error);
      throw new ResetError(
        error instanceof GraphError && error.reason === 'not_configured'
          ? 'SharePoint is not set up, so no backup could be saved first. Nothing was removed.'
          : 'The backup to SharePoint could not be saved first. Nothing was removed.',
        'backup_failed'
      );
    }
  }

  await query('select reset_all_test_data($1, $2)', [
    actor.userId,
    actor.email,
  ]);
  return { backup };
}
