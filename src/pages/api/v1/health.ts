// The first endpoint, and the worked example of how every later one is built.
//
// It reports whether the platform's dependencies are answering. It requires a
// signed-in account (permission: null) rather than being open, because an
// unauthenticated health endpoint tells a stranger when the database is down.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess } from '@lib/api/endpoint';
import { query } from '@lib/db/pool';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/health',
    summary: 'Report platform health',
    description:
      'Confirms the API is serving and the database is reachable. Requires a ' +
      'signed-in account: an open health endpoint tells an unauthenticated ' +
      'caller when the platform is degraded.',
    tag: 'Platform',
    permission: null,
    responseSchema: {
      type: 'object',
      required: ['status', 'database', 'checkedAt'],
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        database: { type: 'string', enum: ['reachable', 'unreachable'] },
        checkedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  async ({ correlationId }) => {
    let database: 'reachable' | 'unreachable' = 'reachable';

    try {
      await query('select 1');
    } catch {
      // Deliberately not re-thrown: a health check that returns 500 when the
      // database is down tells you less than one that returns 200 saying so.
      database = 'unreachable';
    }

    return apiSuccess(
      {
        status: database === 'reachable' ? 'ok' : 'degraded',
        database,
        checkedAt: new Date().toISOString(),
      },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
