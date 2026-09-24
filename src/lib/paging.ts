// Paging a long list (officer request): every list that can grow long
// shows a page at a time, 10, 25 or 50 rows as the officer chooses, with
// the choice and the page in the address so a link or the Back button
// lands on the same rows. Pages read their paging with pagingFrom and
// render <Pagination> (src/components/Pagination.astro) under the table;
// the list's own query takes paging.per and paging.offset.
export const PAGE_SIZES = [10, 25, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export interface Paging {
  page: number;
  per: PageSize;
  offset: number;
}

export function pagingFrom(url: URL): Paging {
  const perAsked = Number(url.searchParams.get('per'));
  const per = (PAGE_SIZES as readonly number[]).includes(perAsked)
    ? (perAsked as PageSize)
    : DEFAULT_PAGE_SIZE;
  const pageAsked = Math.floor(Number(url.searchParams.get('page')));
  const page = Number.isFinite(pageAsked) && pageAsked > 1 ? pageAsked : 1;
  return { page, per, offset: (page - 1) * per };
}

export function pageCount(total: number, per: number): number {
  return Math.max(Math.ceil(total / per), 1);
}

// The same address with the page or the page size changed, every other
// parameter (search, filters) kept. The defaults are left out, so the
// first page of a plain list is the plain address.
export function pageHref(
  url: URL,
  changes: { page?: number; per?: number }
): string {
  const next = new URL(url);
  if (changes.per !== undefined) {
    if (changes.per === DEFAULT_PAGE_SIZE) next.searchParams.delete('per');
    else next.searchParams.set('per', String(changes.per));
    next.searchParams.delete('page');
  }
  if (changes.page !== undefined) {
    if (changes.page <= 1) next.searchParams.delete('page');
    else next.searchParams.set('page', String(changes.page));
  }
  return `${next.pathname}${next.search}`;
}

// The page numbers to offer: the first, the last, and two either side of
// the current one, with a gap (null) where pages are left out.
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const wanted = new Set([
    1,
    pages,
    page - 2,
    page - 1,
    page,
    page + 1,
    page + 2,
  ]);
  const sorted = [...wanted]
    .filter(n => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const n of sorted) {
    if (out.length > 0 && n - (out[out.length - 1] as number) > 1)
      out.push(null);
    out.push(n);
  }
  return out;
}
