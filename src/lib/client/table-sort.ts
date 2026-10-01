// Sorting on every table (officer feedback): click a column heading to
// sort the rows already on the page by it, click again to reverse. A page
// opts a table in with data-sortable on the <table>, and the heading of a
// column that has no order (a checkbox, an actions column, a heading over
// several columns) with data-no-sort.
//
// Client-side, against the rows on the page: every list here is capped or
// paged and already loaded, so re-asking the server for the same rows in a
// different order would be a round trip spent on nothing new.
//
// A cell sorts by its data-sort-value when it carries one — an ISO date
// under a formatted one, a plain number under a formatted amount — and by
// its text otherwise. Two plain numbers compare as numbers; anything else
// compares as text with digit runs in numeric order.

const NUMBER = /^-?\d+(\.\d+)?$/;

function valueOf(cell: Element | undefined): string {
  if (!cell) return '';
  return cell.getAttribute('data-sort-value') ?? cell.textContent?.trim() ?? '';
}

function compare(a: string, b: string): number {
  if (NUMBER.test(a) && NUMBER.test(b)) return Number(a) - Number(b);
  // Empty sorts last either way, so a blank never sits above a value.
  if (a === '' || b === '') return a === '' ? (b === '' ? 0 : 1) : -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function wire(table: HTMLTableElement): void {
  const headerRow = table.tHead?.rows[0];
  const body = table.tBodies[0];
  if (!headerRow || !body) return;

  let activeIndex = -1;
  let ascending = true;

  const headings = [...headerRow.cells];
  headings.forEach((th, index) => {
    if (
      th.hasAttribute('data-no-sort') ||
      th.colSpan > 1 ||
      !th.textContent?.trim()
    ) {
      return;
    }
    th.classList.add('cursor-pointer', 'select-none');
    th.tabIndex = 0;
    th.setAttribute('aria-sort', 'none');
    const indicator = document.createElement('span');
    indicator.setAttribute('data-sort-indicator', '');
    indicator.className = 'ml-1 text-[10px]';
    indicator.setAttribute('aria-hidden', 'true');
    th.appendChild(indicator);

    const sort = () => {
      ascending = activeIndex === index ? !ascending : true;
      activeIndex = index;
      const rows = [...body.rows];
      rows.sort((a, b) => {
        const result = compare(
          valueOf(a.cells[index]),
          valueOf(b.cells[index])
        );
        // Blanks stay last whichever way the column runs.
        if (
          result !== 0 &&
          (valueOf(a.cells[index]) === '' || valueOf(b.cells[index]) === '')
        ) {
          return result;
        }
        return ascending ? result : -result;
      });
      for (const row of rows) body.appendChild(row);
      for (const heading of headings) {
        if (heading.hasAttribute('aria-sort'))
          heading.setAttribute('aria-sort', 'none');
        const mark = heading.querySelector('[data-sort-indicator]');
        if (mark) mark.textContent = '';
      }
      th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      indicator.textContent = ascending ? '▲' : '▼';
    };
    th.addEventListener('click', event => {
      // A control inside the heading (a select-all checkbox) keeps its
      // own click.
      if ((event.target as HTMLElement).closest('input, button, a')) return;
      sort();
    });
    th.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        sort();
      }
    });
  });
}

/** Wire every table[data-sortable] under the root (the page by default). */
export function wireSortableTables(root: ParentNode = document): void {
  for (const table of root.querySelectorAll<HTMLTableElement>(
    'table[data-sortable]'
  )) {
    wire(table);
  }
}
