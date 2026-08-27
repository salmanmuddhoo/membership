// The first endpoint, and the worked example of how every later one is built.
//
// It reports whether the platform's dependencies are answering. It requires a
// signed-in account (permission: null) rather than being open, because an
// unauthenticated health endpoint tells a stranger when the database is down.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess } from '@lib/api/endpoint';
import { query } from '@lib/db/pool';
import { getGraphConfig } from '@lib/documents/graph';

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
      required: ['status', 'database', 'sharePoint', 'checkedAt'],
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        database: { type: 'string', enum: ['reachable', 'unreachable'] },
        sharePoint: {
          type: 'string',
          enum: ['configured', 'not_configured'],
          description:
            'Whether the GRAPH_* settings are present in this environment. ' +
            'Not a reachability check — it makes no network call, so a health ' +
            'check does not depend on Microsoft answering.',
        },
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

    // Presence of configuration, not reachability. Calling Graph here would
    // make every health check wait on Microsoft, and would report an outage at
    // their end as one at ours. What this answers is the question an operator
    // actually has when documents will not file: has this environment been set
    // up at all?
    let sharePoint: 'configured' | 'not_configured' = 'configured';
    try {
      getGraphConfig();
    } catch {
      sharePoint = 'not_configured';
    }

    return apiSuccess(
      {
        // SharePoint is deliberately not part of `status`. An environment
        // where documents are not set up yet is incomplete, not degraded, and
        // an alert that fires on it from day one is an alert nobody reads.
        status: database === 'reachable' ? 'ok' : 'degraded',
        database,
        sharePoint,
        checkedAt: new Date().toISOString(),
      },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
