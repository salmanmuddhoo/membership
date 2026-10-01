import { describe, expect, it } from 'vitest';
import { pageHref, pageNumbers, pagingFrom } from './paging';

describe('paging a long list (officer request)', () => {
  it('reads the page and 10/25/50 rows from the address, 25 by default', () => {
    expect(pagingFrom(new URL('http://x/members'))).toEqual({
      page: 1,
      per: 25,
      offset: 0,
    });
    expect(pagingFrom(new URL('http://x/members?page=3&per=10'))).toEqual({
      page: 3,
      per: 10,
      offset: 20,
    });
    // Anything else falls back rather than failing.
    expect(pagingFrom(new URL('http://x/m?page=-2&per=1000'))).toEqual({
      page: 1,
      per: 25,
      offset: 0,
    });
  });

  it('keeps the search and filters when changing page or size', () => {
    const url = new URL('http://x/members?q=ali&status=active&page=4');
    expect(pageHref(url, { page: 5 })).toBe(
      '/members?q=ali&status=active&page=5'
    );
    expect(pageHref(url, { page: 1 })).toBe('/members?q=ali&status=active');
    // A new size starts again at the first page.
    expect(pageHref(url, { per: 50 })).toBe(
      '/members?q=ali&status=active&per=50'
    );
    expect(pageHref(new URL('http://x/m?per=50'), { per: 25 })).toBe('/m');
  });

  it('offers the ends and two pages either side, with gaps', () => {
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
    expect(pageNumbers(2, 9)).toEqual([1, 2, 3, 4, null, 9]);
  });
});
