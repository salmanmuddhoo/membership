// A chunked long-running job, and the proof that chunking works (S-113).
//
// Stands in for the two real jobs this mechanism exists for:
//
//   * M7's migration import — read the cleansed legacy extract in batches,
//     writing members as it goes.
//   * M8's dormancy sweep — walk every member, decide dormancy, record the
//     ones that changed.
//
// Both share the shape: a large ordered set, processed in chunks, with progress
// saved after each chunk so an eviction costs one chunk rather than the run.
import { query } from '../db/pool';
import type { JobContext } from './runner';

export interface SweepCheckpoint {
  // Keyset pagination, not OFFSET. OFFSET re-reads and re-skips every earlier
  // row on each chunk, so a sweep gets slower as it progresses; and if rows are
  // inserted while it runs, OFFSET silently skips or repeats members.
  lastId: string | null;
}

export interface ChunkedSweepOptions {
  chunkSize: number;
  // Injected so a test can make the work observable and deterministic.
  processChunk?: (ids: string[]) => Promise<void>;
}

// Walk app_user in id order, in chunks, checkpointing after each.
export async function runChunkedSweep(
  context: JobContext<SweepCheckpoint>,
  options: ChunkedSweepOptions
): Promise<void> {
  let lastId = context.checkpoint?.lastId ?? null;

  for (;;) {
    // Between chunks is the only safe place to stop: never mid-write.
    if (context.shouldStop()) {
      context.log('stopping between chunks', { lastId });
      return;
    }

    const rows = await query<{ id: string }>(
      lastId === null
        ? `select id::text from app_user order by id limit $1`
        : `select id::text from app_user where id > $2 order by id limit $1`,
      lastId === null ? [options.chunkSize] : [options.chunkSize, lastId]
    );

    if (rows.rows.length === 0) {
      context.log('sweep complete', { processed: context.processedCount });
      return;
    }

    const ids = rows.rows.map(r => r.id);
    if (options.processChunk) await options.processChunk(ids);

    lastId = ids[ids.length - 1];

    // Saved AFTER the chunk's work, so a crash between the work and the save
    // repeats that chunk rather than skipping it. Repeating is recoverable if
    // the work is idempotent; skipping a member silently is not.
    await context.save({ lastId }, ids.length);

    context.log('chunk done', { processed: context.processedCount, lastId });
  }
}
