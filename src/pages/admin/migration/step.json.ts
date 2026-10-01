// One chunk of a running migration batch (docs/backlog.md M7,
// src/lib/migration/batches.ts): imports up to 50 rows and reports how far
// the batch has got. Polled by migration.astro's script while a batch is
// running — a form-encoded POST so Astro's own origin check covers it.
import type { APIRoute } from 'astro';
import { importNextRows } from '@lib/migration/batches';
import { MigrationError } from '@lib/migration/members';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const principal = locals.principal!;
  if (!principal.permissions.has('system.migrate_members')) {
    return json(
      { error: 'You do not have permission to import members.' },
      403
    );
  }

  const form = await request.formData();
  const batchId = ((form.get('batchId') as string | null) ?? '').trim();
  if (!UUID.test(batchId)) {
    return json({ error: 'That import no longer exists.' }, 400);
  }

  try {
    const progress = await importNextRows(
      batchId,
      { userId: principal.userId, email: principal.email },
      principal.permissions,
      50
    );
    return json({
      status: progress.status,
      total: progress.total,
      processed: progress.processed,
      imported: progress.imported,
      failed: progress.failed,
    });
  } catch (err) {
    if (err instanceof MigrationError) {
      return json({ error: err.message }, 400);
    }
    console.error('[admin/migration/step]', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
};
