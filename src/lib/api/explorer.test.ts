// Grouping the API document for the reference page (S-110).
//
// Run against the REAL docs/openapi.json as well as fixtures. A page that
// silently drops an endpoint is worse than no page: an integrator reads it as
// the complete list, and the one call they needed is the one that is not
// there.
import { describe, expect, it } from 'vitest';
import {
  categorise,
  endpointKey,
  tryDefinitions,
  type OpenApiDocument,
} from './explorer';
import realDocument from '../../../docs/openapi.json';

const specification = realDocument as unknown as OpenApiDocument;

function documentOf(paths: OpenApiDocument['paths']): OpenApiDocument {
  return { info: { title: 'Test', version: '1.0.0' }, paths };
}

describe('against the document the build actually generates', () => {
  const categories = categorise(specification);

  it('accounts for every operation exactly once', () => {
    const expected = Object.values(specification.paths).reduce(
      (n, operations) => n + Object.keys(operations).length,
      0
    );
    const grouped = categories.reduce((n, c) => n + c.endpoints.length, 0);

    expect(grouped).toBe(expected);
    // And no endpoint appears in two categories.
    const keys = categories.flatMap(c => c.endpoints.map(endpointKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts every endpoint in a named category', () => {
    expect(categories.length).toBeGreaterThan(1);
    for (const category of categories) {
      expect(category.name).not.toBe('');
      expect(category.endpoints.length).toBeGreaterThan(0);
    }
  });

  // The page states what each call needs. A blank there would read as "no
  // permission required", which for this API is never true.
  it('knows what every endpoint requires', () => {
    for (const category of categories) {
      for (const endpoint of category.endpoints) {
        expect(
          endpoint.permission,
          `${endpointKey(endpoint)} states no permission`
        ).not.toBe('');
      }
    }
  });

  it('is sorted, so an endpoint stays where it was last seen', () => {
    const names = categories.map(c => c.name);
    expect(names).toEqual([...names].sort());
    // By path first, then method, so the several methods on one path sit
    // together rather than being scattered by verb.
    for (const category of categories) {
      const order = category.endpoints.map(e => [e.path, e.method]);
      const sorted = [...order].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
      );
      expect(order).toEqual(sorted);
    }
  });

  // What the browser is handed has to cover what the markup renders, or a
  // form exists with no definition behind it and the button does nothing.
  it('hands the browser a definition for every endpoint rendered', () => {
    const definitions = tryDefinitions(categories);
    for (const category of categories) {
      for (const endpoint of category.endpoints) {
        expect(definitions[endpointKey(endpoint)]).toBeDefined();
      }
    }
  });
});

describe('categorise', () => {
  it('groups by the first tag', () => {
    const categories = categorise(
      documentOf({
        '/api/v1/a': { get: { tags: ['Members'], summary: 'A' } },
        '/api/v1/b': { get: { tags: ['Members'], summary: 'B' } },
        '/api/v1/c': { get: { tags: ['Payments'], summary: 'C' } },
      })
    );

    expect(categories.map(c => c.name)).toEqual(['Members', 'Payments']);
    expect(categories[0].endpoints).toHaveLength(2);
  });

  // One path serving GET and POST is one route file and two endpoints; both
  // have to appear.
  it('keeps every method on a path', () => {
    const categories = categorise(
      documentOf({
        '/api/v1/roles': {
          get: { tags: ['Administration'], summary: 'List' },
          post: { tags: ['Administration'], summary: 'Create' },
        },
      })
    );

    expect(categories[0].endpoints.map(e => e.method)).toEqual(['GET', 'POST']);
  });

  // An untagged operation is still an endpoint. Dropping it would make the
  // page quietly incomplete, which is the one thing it must not be.
  it('still shows an operation with no tag', () => {
    const categories = categorise(
      documentOf({ '/api/v1/x': { get: { summary: 'Untagged' } } })
    );

    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe('Other');
  });

  it('reads the {id} segments a caller has to fill in', () => {
    const categories = categorise(
      documentOf({
        '/api/v1/accounts/{id}/transactions': {
          get: { tags: ['Payments'], summary: 'T' },
        },
      })
    );

    expect(categories[0].endpoints[0].pathParams).toEqual(['id']);
  });
});

describe('what counts as a read', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  const categories = categorise(
    documentOf({
      '/api/v1/thing': Object.fromEntries(
        methods.map(m => [m, { tags: ['Test'], summary: m }])
      ),
    })
  );
  const isRead = Object.fromEntries(
    categories[0].endpoints.map(e => [e.method, e.isRead])
  );

  it('treats GET as safe to call by accident', () => {
    expect(isRead.GET).toBe(true);
  });

  // The switch on the page is keyed off this. A wrong guess here costs a
  // click in one direction and data in the other, so everything that is not
  // defined to be safe is treated as a write.
  it('treats everything else as a write', () => {
    expect(isRead.POST).toBe(false);
    expect(isRead.PUT).toBe(false);
    expect(isRead.PATCH).toBe(false);
    expect(isRead.DELETE).toBe(false);
  });
});

describe('tryDefinitions', () => {
  const categories = categorise(
    documentOf({
      '/api/v1/search/{id}': {
        post: {
          tags: ['Test'],
          summary: 'S',
          parameters: [
            { name: 'q', in: 'query', required: true },
            { name: 'limit', in: 'query' },
            { name: 'id', in: 'path', required: true },
          ],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    })
  );
  const definition = tryDefinitions(categories)['POST /api/v1/search/{id}'];

  it('carries only the query parameters, not the path ones', () => {
    // Path parameters are already known from the path itself; repeating them
    // would render the same field twice.
    expect(definition.query.map(q => q.name)).toEqual(['q', 'limit']);
    expect(definition.pathParams).toEqual(['id']);
  });

  it('remembers which are required', () => {
    expect(definition.query).toEqual([
      { name: 'q', required: true },
      { name: 'limit', required: false },
    ]);
  });

  it('says whether there is a body to send', () => {
    expect(definition.hasBody).toBe(true);
  });

  it('says there is none when the endpoint takes none', () => {
    const none = categorise(
      documentOf({ '/api/v1/x': { get: { tags: ['T'], summary: 'X' } } })
    );
    expect(tryDefinitions(none)['GET /api/v1/x'].hasBody).toBe(false);
  });
});
