// The nightly backup of "Export members with balances" (officer request,
// October 2026): the same workbook the migration page downloads, saved to
// SharePoint at midnight Mauritius time by the members-backup job
// (scripts/run-job.ts), two days kept.
//
// Each night's file is named for its day — members-backup-2026-10-14.xlsx —
// and once it is safely in the library every older one but the newest is
// removed, so the folder always holds tonight's and last night's. On the
// third night the first is gone, which is the rotation the Society asked
// for, without two fixed "slot" names that would hide which day a file is
// from. A second run on the same day replaces that day's file rather than
// adding a copy beside it.
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

export const BACKUP_FOLDER = isProductionEnvironment()
  ? 'Production/Al Barakah MCSL – Backups'
  : 'Test/Al Barakah MCSL – Backups';

// Tonight's file and the night before's.
export const BACKUPS_KEPT = 2;

const BACKUP_NAME = /^members-backup-(\d{4}-\d{2}-\d{2})\.xlsx$/;

export function backupFileName(day: string): string {
  return `members-backup-${day}.xlsx`;
}

/**
 * Which of the files in the folder go once `current` is written: every
 * backup but `current` and the newest before it. Anything not named as a
 * backup is someone else's and is never touched.
 */
export function backupsToRemove(names: string[], current: string): string[] {
  const others = names
    .filter(name => BACKUP_NAME.test(name) && name !== current)
    .sort()
    .reverse();
  return others.slice(BACKUPS_KEPT - 1);
}

export interface BackupOutcome {
  folder: string;
  fileName: string;
  members: number;
  nonMembers: number;
  removed: string[];
}

/**
 * Export everyone with their balances and save it to SharePoint, then trim
 * the folder to the last two days. The old files are only removed once the
 * new one is in: a failed upload leaves yesterday's and the day before's
 * where they were.
 */
export async function backupMembers(
  options: { at?: Date; config?: GraphConfig } = {}
): Promise<BackupOutcome> {
  const config = options.config ?? getGraphConfig();
  const fileName = backupFileName(localDay(options.at));

  // Recorded in the audit log as the export it is, under the service
  // account a migration already runs as (migration 0066) — nobody signed in.
  const system = await query<{ id: string; email: string }>(
    `select id, email from app_user where entra_subject = 'system:migration'`
  );
  if (!system.rows[0]) {
    throw new Error('The system:migration service account is missing.');
  }
  const { buffer, members, nonMembers } = await exportMembers(
    { userId: system.rows[0].id, email: 'members-backup job' },
    new Set([PERMISSION_MIGRATE])
  );

  await ensureFolderPath(BACKUP_FOLDER, config);
  await uploadReplacing(`${BACKUP_FOLDER}/${fileName}`, buffer, config);

  const removed = backupsToRemove(
    await listFolderNames(BACKUP_FOLDER, config),
    fileName
  );
  for (const name of removed) {
    await deleteItemByPath(`${BACKUP_FOLDER}/${name}`, config);
  }

  return { folder: BACKUP_FOLDER, fileName, members, nonMembers, removed };
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
