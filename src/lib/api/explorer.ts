// Reading the generated OpenAPI document into something a page can render
// (S-110).
//
// docs/openapi.json is produced from the route descriptors by
// `pnpm openapi:generate`, and `pnpm openapi:check` fails the build if the
// committed copy has drifted. So this is not a second description of the API
// that can fall out of step with the first — it is the same one, grouped.
//
// Kept out of the page so it can be tested. What matters here is not how it
// looks: it is that every endpoint appears, exactly once, in a category, with
// the right idea of whether calling it changes anything.

// Only what this needs. The document has far more in it — the error responses
// alone are four per operation, identical every time.
export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  'x-required-permission'?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
  }[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
}

export interface OpenApiDocument {
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  summary: string;
  description?: string;
  // What the caller needs to hold, in the words the document uses.
  permission: string;
  // Whether calling it is safe to do by accident. Everything else is held
  // behind a switch on the page.
  isRead: boolean;
  parameters: NonNullable<OpenApiOperation['parameters']>;
  // The {id} segments, which have to be filled in before there is a URL.
  pathParams: string[];
  requestSchema: unknown;
  responseSchema: unknown;
}

export interface ApiCategory {
  name: string;
  endpoints: ApiEndpoint[];
}

// HEAD and GET are the methods defined not to change anything. Everything
// else is treated as a write, including the ones that usually are not: a
// wrong guess in this direction costs a click, and in the other costs data.
const READ_METHODS = new Set(['get', 'head']);

const JSON_CONTENT = 'application/json';

/**
 * Every endpoint in the document, grouped by its category and sorted.
 *
 * Sorted on both axes so the page is stable: an endpoint stays where a reader
 * last saw it, rather than moving because the generator walked the files in a
 * different order.
 */
export function categorise(document: OpenApiDocument): ApiCategory[] {
  const byCategory = new Map<string, ApiEndpoint[]>();

  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      // An operation with no tag is still an endpoint, and hiding it would
      // make the page quietly incomplete.
      const name = operation.tags?.[0] ?? 'Other';
      const endpoints = byCategory.get(name) ?? [];

      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? '',
        description: operation.description,
        permission: operation['x-required-permission'] ?? '',
        isRead: READ_METHODS.has(method.toLowerCase()),
        parameters: operation.parameters ?? [],
        pathParams: [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
        requestSchema: operation.requestBody?.content?.[JSON_CONTENT]?.schema,
        responseSchema:
          operation.responses?.['200']?.content?.[JSON_CONTENT]?.schema,
      });

      byCategory.set(name, endpoints);
    }
  }

  return [...byCategory.entries()]
    .map(([name, endpoints]) => ({
      name,
      endpoints: endpoints.sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// What the browser needs to build a request, and nothing else. The whole
// document is around 200KB, most of it schemas and repeated error responses
// that only the rendered markup uses; sending all of it to a tablet for the
// sake of a few fields would be wasteful.
export interface TryDefinition {
  method: string;
  path: string;
  isRead: boolean;
  pathParams: string[];
  query: { name: string; required: boolean }[];
  hasBody: boolean;
}

// The key a form and its definition agree on. One function so the two cannot
// disagree about the spelling.
export function endpointKey(endpoint: {
  method: string;
  path: string;
}): string {
  return `${endpoint.method} ${endpoint.path}`;
}

export function tryDefinitions(
  categories: ApiCategory[]
): Record<string, TryDefinition> {
  return Object.fromEntries(
    categories.flatMap(category =>
      category.endpoints.map(endpoint => [
        endpointKey(endpoint),
        {
          method: endpoint.method,
          path: endpoint.path,
          isRead: endpoint.isRead,
          pathParams: endpoint.pathParams,
          query: endpoint.parameters
            .filter(p => p.in === 'query')
            .map(p => ({ name: p.name, required: p.required ?? false })),
          hasBody: endpoint.requestSchema !== undefined,
        } satisfies TryDefinition,
      ])
    )
  );
}
