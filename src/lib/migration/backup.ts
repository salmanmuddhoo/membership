// The nightly backup of "Export members with balances" (officer request,
// October 2026): the same workbook the migration page downloads, saved to
// SharePoint at midnight Mauritius time by the members-backup job
// (scripts/run-job.ts), the last five days kept (officer direction,
// 14 October 2026; it was two).
//
// Each night writes two files named for the day — members-backup-2026-10-14
// .xlsx, and transactions-backup-2026-10-14.xlsx with every transaction
// (officer request, 15 October 2026) — and once both are safely in the
// library every day's pair but the five newest is removed, so the folder
// always holds tonight's and the four nights before. On the sixth night the
// first is gone — a rotation without fixed "slot" names that would hide which
// day a file is from. A second run on the same day replaces that day's files
// rather than adding copies beside them.
//
// The folder sits beside the member documents and is split by environment
// the same way (documents.ts ROOT_FOLDER): a Test backup never lands next
// to Production's.
import { isProductionEnvironment } from '../config';
import { query } from '../db/pool';
import {
  GraphError,
  getAccessToken,
  getGraphConfig,
  listFolderNames,
  deleteItemByPath,
  reachGraph,
  type GraphConfig,
} from '../documents/graph';
import { ensureFolderPath } from '../documents/documents';
import { uploadInChunks } from '../documents/upload';
import { localDay } from '../time';
import { PERMISSION_MIGRATE, exportMembers } from './members';
import { exportTransactions } from './transactions-backup';

export const BACKUP_FOLDER = isProductionEnvironment()
  ? 'Production/Al Barakah MCSL – Backups'
  : 'Test/Al Barakah MCSL – Backups';

// Tonight's file and the four nights before.
export const BACKUPS_KEPT = 5;

// Each night writes two files, kept and removed together: the members with
// their balances, and every transaction (transactions-backup.ts).
const BACKUP_NAME = /^(members|transactions)-backup-(\d{4}-\d{2}-\d{2})\.xlsx$/;

export function backupFileName(day: string): string {
  return `members-backup-${day}.xlsx`;
}

export function transactionsBackupFileName(day: string): string {
  return `transactions-backup-${day}.xlsx`;
}

/**
 * Which of the files in the folder go once `day`'s are written: every
 * backup of any day but `day` and the BACKUPS_KEPT - 1 newest days before
 * it. Anything not named as a backup is someone else's and is never touched.
 */
export function backupsToRemove(names: string[], day: string): string[] {
  const dayOf = (name: string) => BACKUP_NAME.exec(name)?.[2] ?? null;
  const earlier = [
    ...new Set(names.map(dayOf).filter((d): d is string => !!d && d !== day)),
  ]
    .sort()
    .reverse();
  const kept = new Set([day, ...earlier.slice(0, BACKUPS_KEPT - 1)]);
  return names.filter(name => {
    const d = dayOf(name);
    return d !== null && !kept.has(d);
  });
}

export interface BackupOutcome {
  folder: string;
  fileName: string;
  transactionsFileName: string;
  members: number;
  nonMembers: number;
  transactions: number;
  entries: number;
  removed: string[];
}

/**
 * Export everyone with their balances and save it to SharePoint, then trim
 * the folder to the last five days. The old files are only removed once the
 * new one is in: a failed upload leaves the earlier days where they were.
 */
export async function backupMembers(
  options: { at?: Date; config?: GraphConfig } = {}
): Promise<BackupOutcome> {
  const config = options.config ?? getGraphConfig();
  const day = localDay(options.at);
  const fileName = backupFileName(day);
  const transactionsFileName = transactionsBackupFileName(day);
  const { members, nonMembers } = await saveExport(
    fileName,
    'members-backup job',
    config
  );
  const { transactions, entries } = await saveTransactions(
    transactionsFileName,
    config
  );

  const removed = backupsToRemove(
    await listFolderNames(BACKUP_FOLDER, config),
    day
  );
  for (const name of removed) {
    await deleteItemByPath(`${BACKUP_FOLDER}/${name}`, config);
  }

  return {
    folder: BACKUP_FOLDER,
    fileName,
    transactionsFileName,
    members,
    nonMembers,
    transactions,
    entries,
    removed,
  };
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Indian/Mauritius',
});

/**
 * The export, saved just before "Reset data" wipes a production database
 * (admin/reset.ts): members-before-reset-2026-10-14-1530.xlsx and
 * transactions-before-reset-2026-10-14-1530.xlsx, beside the nightly files.
 * Their names are not a nightly backup's, so the nightly trim never removes
 * them — the reset empties the audit log too, and these files are what is
 * left of what was there.
 */
export async function backupBeforeReset(
  options: { at?: Date; config?: GraphConfig } = {}
): Promise<{ folder: string; fileName: string; transactionsFileName: string }> {
  const config = options.config ?? getGraphConfig();
  const at = options.at ?? new Date();
  const when = `${localDay(at)}-${clock.format(at).replace(':', '')}`;
  const fileName = `members-before-reset-${when}.xlsx`;
  const transactionsFileName = `transactions-before-reset-${when}.xlsx`;
  await saveExport(fileName, 'before reset', config);
  await saveTransactions(transactionsFileName, config);
  return { folder: BACKUP_FOLDER, fileName, transactionsFileName };
}

async function saveTransactions(
  fileName: string,
  config: GraphConfig
): Promise<{ transactions: number; entries: number }> {
  const { buffer, transactions, entries } = await exportTransactions();
  await ensureFolderPath(BACKUP_FOLDER, config);
  await uploadReplacing(`${BACKUP_FOLDER}/${fileName}`, buffer, config);
  return { transactions, entries };
}

// The export, saved to the backup folder under this name. Recorded in the
// audit log as the export it is, under the service account a migration
// already runs as (migration 0066) — nobody signed in.
async function saveExport(
  fileName: string,
  description: string,
  config: GraphConfig
): Promise<{ members: number; nonMembers: number }> {
  const system = await query<{ id: string }>(
    `select id from app_user where entra_subject = 'system:migration'`
  );
  if (!system.rows[0]) {
    throw new Error('The system:migration service account is missing.');
  }
  const { buffer, members, nonMembers } = await exportMembers(
    { userId: system.rows[0].id, email: description },
    new Set([PERMISSION_MIGRATE])
  );
  await ensureFolderPath(BACKUP_FOLDER, config);
  await uploadReplacing(`${BACKUP_FOLDER}/${fileName}`, buffer, config);
  return { members, nonMembers };
}

// An upload session that replaces a file of the same name. Filed documents
// never do this (createUploadTicket renames instead); a backup run twice in
// a day should leave one file for that day, not two.
async function uploadReplacing(
  itemPath: string,
  bytes: Uint8Array,
  config: GraphConfig
): Promise<void> {
  const token = await getAccessToken(config);
  const response = await reachGraph(
    `${config.graphBaseUrl}/drives/${config.driveId}/root:/${encodeURI(itemPath)}:/createUploadSession`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GraphError(
      `Graph createUploadSession failed (${response.status}): ${detail}`,
      'request_failed',
      response.status
    );
  }
  const { uploadUrl } = (await response.json()) as { uploadUrl: string };
  await uploadInChunks(uploadUrl, bytes);
}
