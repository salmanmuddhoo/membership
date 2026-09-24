// What a search box's suggestion endpoint answers (officer request:
// suggestions as you type, src/lib/client/search-suggest.ts). Each list
// page's own suggest.json route runs its search for the typed text and
// hands the matches here; the route sits under the page's own prefix, so
// the middleware applies the page's permission to it too.
export interface Suggestion {
  label: string;
  detail?: string | null;
  href: string;
}

// How many suggestions to show: enough to find the one, few enough to read.
export const SUGGESTION_LIMIT = 8;

// The typed text, or null when it is too short to suggest on.
export function suggestQuery(url: URL): string | null {
  const q = (url.searchParams.get('q') ?? '').trim();
  return q.length >= 2 && q.length <= 100 ? q : null;
}

export function suggestionResponse(suggestions: Suggestion[]): Response {
  return new Response(
    JSON.stringify({ suggestions: suggestions.slice(0, SUGGESTION_LIMIT) }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    }
  );
}
