// The legacy migration a chunk at a time (officer direction: over 4,000
// members, a progress bar while it runs, and a way to stop it that leaves
// nothing behind). Migration 0110 holds the batch and its rows.
//
// An upload is parsed, checked and reconciled in full exactly as before —
// nothing is written unless every row is sound — and then stored as a
// batch rather than imported in the same request: importing costs tens of
// milliseconds a row, so 4,000 rows would outlast any request. The page
// then asks for the next few rows at a time (importNextRows) and draws its
// progress from the answer; closing the page only pauses it, and coming
// back carries on. Each row goes through importMembers, the same code a
// one-shot import used, and the row keeps what it wrote to, which is how
// cancelMigrationBatch knows what to remove.
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';
import { fromCents } from '../payments/money';
import {
  importMembers,
  MigrationError,
  PERMISSION_MIGRATE,
  type ValidatedRow,
} from './members';
import {
  migrationSummary,
  summaryDifference,
  type MigrationSummary,
} from './summary';

interface Actor {
  userId: string;
  email: string;
}

export interface BatchProgress {
  id: string;
  status: 'running' | 'completed' | 'cancelled';
  total: number;
  processed: number;
  imported: number;
  failed: number;
  startedAt: Date;
  startedByName: string | null;
  finishedAt: Date | null;
}

export interface BatchOutcome {
  progress: BatchProgress;
  // What the batch added, once it has finished.
  added: MigrationSummary | null;
  failures: { legacyCode: string; message: string }[];
}

// A row claimed this long ago and never finished belongs to a request that
// died part-way (a closed tab mid-chunk, a restarted server).
const STALE_MINUTES = 10;

function assertMayMigrate(permissions: ReadonlySet<string>): void {
  if (!permissions.has(PERMISSION_MIGRATE)) {
    throw new MigrationError(
      'You do not have permission to import members.',
      'forbidden'
    );
  }
}

const PROGRESS = `
  select b.id, b.status, b.total_rows, b.started_at, b.finished_at,
         u.display_name as started_by_name,
         count(r.*) filter (where r.status in ('imported', 'failed')) as processed,
         count(r.*) filter (where r.status = 'imported') as imported,
         count(r.*) filter (where r.status = 'failed') as failed
    from migration_batch b
    left join app_user u on u.id = b.started_by
    left join migration_batch_row r on r.batch_id = b.id`;

interface ProgressRow {
  id: string;
  status: BatchProgress['status'];
  total_rows: number;
  started_at: Date;
  finished_at: Date | null;
  started_by_name: string | null;
  processed: string;
  imported: string;
  failed: string;
}

function toProgress(r: ProgressRow): BatchProgress {
  return {
    id: r.id,
    status: r.status,
    total: r.total_rows,
    processed: Number(r.processed),
    imported: Number(r.imported),
    failed: Number(r.failed),
    startedAt: r.started_at,
    startedByName: r.started_by_name,
    finishedAt: r.finished_at,
  };
}

/** The upload still being imported, if there is one. */
export async function runningBatch(): Promise<BatchProgress | null> {
  const result = await query<ProgressRow>(
    `${PROGRESS} where b.status = 'running' group by b.id, u.display_name`
  );
  return result.rows[0] ? toProgress(result.rows[0]) : null;
}

export async function batchProgress(
  batchId: string
): Promise<BatchProgress | null> {
  const result = await query<ProgressRow>(
    `${PROGRESS} where b.id = $1 group by b.id, u.display_name`,
    [batchId]
  );
  return result.rows[0] ? toProgress(result.rows[0]) : null;
}

/** A batch with what it added and the rows it could not import. */
export async function batchOutcome(
  batchId: string
): Promise<BatchOutcome | null> {
  const progress = await batchProgress(batchId);
  if (!progress) return null;
  const [before, failures] = await Promise.all([
    query<{ summary_before: MigrationSummary }>(
      `select summary_before from migration_batch where id = $1`,
      [batchId]
    ),
    query<{ legacy_code: string; message: string | null }>(
      `select legacy_code, message from migration_batch_row
        where batch_id = $1 and status = 'failed' order by ordinal`,
      [batchId]
    ),
  ]);
  return {
    progress,
    added:
      progress.status === 'completed'
        ? summaryDifference(
            before.rows[0].summary_before,
            await migrationSummary()
          )
        : null,
    failures: failures.rows.map(r => ({
      legacyCode: r.legacy_code,
      message: r.message ?? '',
    })),
  };
}

/**
 * Store a checked upload as a batch to import. Refused while another is
 * still running: two at once could each claim the same legacy code.
 */
export async function startMigrationBatch(
  rows: ValidatedRow[],
  checksum: string,
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<string> {
  assertMayMigrate(permissions);
  if (rows.length === 0) {
    throw new MigrationError('The file has no rows to import.');
  }
  if (await runningBatch()) {
    throw new MigrationError(
      'Another import is still running. Let it finish or cancel it first.',
      'invalid'
    );
  }
  const before = await migrationSummary();
  return withTransaction(async client => {
    const batch = await client.query<{ id: string }>(
      `insert into migration_batch
         (checksum, total_rows, summary_before, started_by)
       values ($1, $2, $3, $4)
       returning id`,
      [checksum, rows.length, JSON.stringify(before), actor.userId]
    );
    const batchId = batch.rows[0].id;
    // One statement per few hundred rows rather than one per row.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await client.query(
        `insert into migration_batch_row (batch_id, ordinal, legacy_code, data)
         select $1, x.ordinal, x.legacy_code, x.data
           from jsonb_to_recordset($2::jsonb)
                as x(ordinal integer, legacy_code text, data jsonb)`,
        [
          batchId,
          JSON.stringify(
            chunk.map((row, j) => ({
              ordinal: i + j + 1,
              legacy_code: row.legacyCode,
              data: row,
            }))
          ),
        ]
      );
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'migration.batch.started',
        entityType: 'migration',
        entityId: batchId,
        newValue: { checksum, rows: rows.length },
      },
      client
    );
    return batchId;
  });
}

// A stored row back to what importMembers takes: JSON has no dates.
function revive(data: ValidatedRow): ValidatedRow {
  return {
    ...data,
    joinedAt: data.joinedAt ? new Date(data.joinedAt) : null,
  };
}

/**
 * Import the next few rows of a running batch and say how far it has got.
 * Finishing the last row completes the batch.
 */
export async function importNextRows(
  batchId: string,
  actor: Actor,
  permissions: ReadonlySet<string>,
  limit = 50
): Promise<BatchProgress> {
  assertMayMigrate(permissions);
  const batch = await query<{ status: string; checksum: string }>(
    `select status, checksum from migration_batch where id = $1`,
    [batchId]
  );
  if (!batch.rows[0]) {
    throw new MigrationError('That import no longer exists.', 'invalid');
  }
  if (batch.rows[0].status !== 'running') {
    return (await batchProgress(batchId))!;
  }

  await query(
    `update migration_batch_row
        set status = 'failed', finished_at = now(),
            message = 'The import stopped part-way through this row. Check the record and upload it again.'
      where batch_id = $1 and status = 'importing'
        and started_at < now() - make_interval(mins => $2)`,
    [batchId, STALE_MINUTES]
  );

  const claimed = await query<{ ordinal: number; data: ValidatedRow }>(
    `update migration_batch_row r
        set status = 'importing', started_at = now()
      where (r.batch_id, r.ordinal) in (
              select batch_id, ordinal from migration_batch_row
               where batch_id = $1 and status = 'pending'
               order by ordinal
               limit $2
               for update skip locked)
      returning r.ordinal, r.data`,
    [batchId, limit]
  );

  for (const row of claimed.rows.sort((a, b) => a.ordinal - b.ordinal)) {
    const outcome = await importMembers(
      [revive(row.data)],
      actor,
      permissions,
      batch.rows[0].checksum,
      { batchId }
    );
    const done = outcome.imported[0];
    const failed = outcome.failed[0];
    await query(
      `update migration_batch_row
          set status = $3, message = $4, member_no = $5, holder_kind = $6,
              holder_id = $7, created = $8, application_id = $9,
              finished_at = now()
        where batch_id = $1 and ordinal = $2`,
      [
        batchId,
        row.ordinal,
        done ? 'imported' : 'failed',
        failed?.message ?? null,
        done?.memberNo || null,
        done?.kind ?? null,
        done?.holderId ?? null,
        done?.created ?? null,
        failed?.applicationId ?? null,
      ]
    );
  }

  const progress = (await batchProgress(batchId))!;
  if (progress.processed >= progress.total) {
    const finished = await query(
      `update migration_batch set status = 'completed', finished_by = $2,
              finished_at = now()
        where id = $1 and status = 'running'`,
      [batchId, actor.userId]
    );
    if (finished.rowCount) {
      const outcome = (await batchOutcome(batchId))!;
      await recordAudit({
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'migration.batch.completed',
        entityType: 'migration',
        entityId: batchId,
        newValue: {
          checksum: batch.rows[0].checksum,
          rows: progress.total,
          imported: progress.imported,
          failed: progress.failed,
          holders: outcome.added?.total.holders ?? 0,
          totalBalance: fromCents(outcome.added?.total.amountCents ?? 0),
        },
      });
    }
    return (await batchProgress(batchId))!;
  }
  return progress;
}

/**
 * Stop a running batch and remove everything it has written
 * (cancel_migration_batch, 0110). Refused while rows are mid-import, and
 * once money has moved on an account it imported.
 */
export async function cancelMigrationBatch(
  batchId: string,
  actor: Actor,
  permissions: ReadonlySet<string>
): Promise<{ holders: number; accounts: number; payments: number }> {
  assertMayMigrate(permissions);
  try {
    return await withTransaction(async client => {
      const result = await client.query<{
        removed: { holders: number; accounts: number; payments: number };
      }>(`select cancel_migration_batch($1, $2) as removed`, [
        batchId,
        actor.userId,
      ]);
      const removed = result.rows[0].removed;
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.email,
          action: 'migration.batch.cancelled',
          entityType: 'migration',
          entityId: batchId,
          newValue: removed,
        },
        client
      );
      return removed;
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (
      code === 'restrict_violation' ||
      code === 'no_data_found' ||
      code === 'lock_not_available'
    ) {
      throw new MigrationError((err as Error).message, 'invalid');
    }
    throw err;
  }
}
