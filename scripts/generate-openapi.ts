// Generate the OpenAPI document from the routes themselves (S-110).
//
// Hand-maintained API documentation is wrong within a week. This walks the
// endpoint files, reads the descriptor each one exports, and writes the
// document from those. There is nothing to keep in step by hand.
//
// It is also the enforcement point for "an endpoint added without
// documentation is reported": a file under src/pages/api/v1 that exports no
// descriptor fails this script, and the script runs in the build.
//
//   pnpm openapi:generate   writes docs/openapi.json
//   pnpm openapi:check      fails if the committed document is out of date
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { EndpointDescriptor } from '../src/lib/api/endpoint';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const API_DIR = path.join(ROOT, 'src', 'pages', 'api', 'v1');
const OUTPUT = path.join(ROOT, 'docs', 'openapi.json');

async function endpointFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await endpointFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }

  return files.sort();
}

async function collectDescriptors(): Promise<EndpointDescriptor[]> {
  const files = await endpointFiles(API_DIR);
  const descriptors: EndpointDescriptor[] = [];
  const undocumented: string[] = [];

  for (const file of files) {
    // A route file may serve several methods on one path — GET to list and
    // POST to create are the same URL — so `descriptors` (plural) is accepted
    // alongside the single-endpoint `descriptor`. Requiring one file per method
    // would fight Astro's routing, which is per path.
    const module = (await import(file)) as {
      descriptor?: EndpointDescriptor;
      descriptors?: EndpointDescriptor[];
    };

    const found =
      module.descriptors ?? (module.descriptor ? [module.descriptor] : []);

    if (found.length === 0) {
      undocumented.push(path.relative(ROOT, file));
      continue;
    }
    descriptors.push(...found);
  }

  if (undocumented.length > 0) {
    console.error(
      'These endpoints export no descriptor, so they cannot be documented:\n' +
        undocumented.map(f => `  - ${f}`).join('\n') +
        '\n\nDefine the endpoint with defineEndpoint() and re-export its ' +
        'descriptor:\n  export const descriptor = endpoint.descriptor;\n' +
        'or, for a path serving several methods:\n' +
        '  export const descriptors = [list.descriptor, create.descriptor];'
    );
    process.exit(1);
  }

  return descriptors;
}

// The error envelope is identical for every endpoint, so it is declared once as
// a component and referenced rather than repeated per operation.
const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'correlationId'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'unauthenticated',
            'forbidden',
            'not_found',
            'validation_failed',
            'conflict',
            'rate_limited',
            'internal_error',
          ],
        },
        message: {
          type: 'string',
          description: 'Safe to show a person. Never contains internal detail.',
        },
        correlationId: {
          type: 'string',
          description: 'Ties this response to the server log.',
        },
        details: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'Field-level messages, for validation failures only.',
        },
      },
    },
  },
};

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  };
}

function buildDocument(descriptors: EndpointDescriptor[]) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const d of descriptors) {
    const operation: Record<string, unknown> = {
      summary: d.summary,
      ...(d.description ? { description: d.description } : {}),
      tags: [d.tag],
      operationId: `${d.method.toLowerCase()}${d.path
        .replace(/^\/api\/v1/, '')
        .replace(/[/{}-]+(.)/g, (_m, c: string) => c.toUpperCase())
        .replace(/[/{}-]/g, '')}`,
      // Stated per operation so a reader can see what each one needs without
      // cross-referencing prose.
      'x-required-permission': d.permission ?? '(any signed-in account)',
      responses: {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data', 'correlationId'],
                properties: {
                  data: d.responseSchema,
                  correlationId: { type: 'string' },
                },
              },
            },
          },
        },
        '401': errorResponse('Not signed in.'),
        '403': errorResponse('Signed in, but not permitted.'),
        '429': errorResponse('Rate limited. See the retry-after header.'),
        '500': errorResponse('Unexpected failure. Quote the correlation id.'),
      },
    };

    if (d.query?.length) {
      operation.parameters = d.query.map(q => ({
        name: q.name,
        in: 'query',
        required: q.required ?? false,
        ...(q.description ? { description: q.description } : {}),
        schema: q.schema,
      }));
    }

    if (d.requestSchema) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: d.requestSchema } },
      };
    }

    paths[d.path] = {
      ...(paths[d.path] ?? {}),
      [d.method.toLowerCase()]: operation,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Al Barakah MCSL API',
      version: '1.0.0',
      description:
        'Internal operations API. Consumed by this application and, from ' +
        'Phase 4, by the member mobile application (AD-03).\n\n' +
        'This document is GENERATED from the route descriptors by ' +
        '`pnpm openapi:generate`. Do not edit it by hand.',
    },
    servers: [{ url: '/', description: 'Same origin as the application' }],
    // Every endpoint is behind the application's own session cookie; there is
    // no separate API credential yet.
    components: {
      schemas: { Error: ERROR_SCHEMA },
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'ab_session',
          description:
            "The application's own signed session cookie, set by the OIDC " +
            'sign-in flow.',
        },
      },
    },
    security: [{ sessionCookie: [] }],
    paths,
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const descriptors = await collectDescriptors();
  const document = JSON.stringify(buildDocument(descriptors), null, 2) + '\n';

  if (check) {
    const existing = await readFile(OUTPUT, 'utf8').catch(() => null);
    if (existing !== document) {
      console.error(
        'docs/openapi.json is out of date. Run `pnpm openapi:generate` and ' +
          'commit the result.'
      );
      process.exit(1);
    }
    console.log(
      `docs/openapi.json is current (${descriptors.length} endpoint(s)).`
    );
    return;
  }

  await writeFile(OUTPUT, document, 'utf8');
  console.log(
    `Wrote docs/openapi.json from ${descriptors.length} endpoint descriptor(s).`
  );
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
