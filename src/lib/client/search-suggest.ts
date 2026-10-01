// Suggestions under a search box (officer request: every search suggests
// as you type, without pressing Search). Any input with
// data-suggest="/some/suggest.json" gets them: from two characters on, the
// matches are listed under the box, and picking one opens it. Enter with
// nothing picked still submits the search as before — the list is a
// shortcut, not the only way in. Wired for every page by DashboardLayout.
//
// The endpoint answers ?q= with { suggestions: [{ label, detail?, href }] }
// (src/lib/search/suggest.ts).

interface Suggestion {
  label: string;
  detail?: string | null;
  href: string;
}

let wired = 0;

function wire(input: HTMLInputElement): void {
  const endpoint = input.dataset.suggest;
  if (!endpoint || input.dataset.suggestWired) return;
  input.dataset.suggestWired = 'true';
  input.setAttribute('autocomplete', 'off');

  const host = input.parentElement!;
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }
  const list = document.createElement('ul');
  list.id = `search-suggestions-${(wired += 1)}`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  list.className =
    'absolute right-0 left-0 z-30 mt-1 max-h-80 min-w-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900';
  list.style.top = `${input.offsetTop + input.offsetHeight}px`;
  host.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  let items: Suggestion[] = [];
  let active = -1;
  let asked = 0;
  let timer: number | undefined;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (index: number) => {
    active = index;
    list
      .querySelectorAll<HTMLLIElement>('li[role="option"]')
      .forEach((li, i) => {
        const on = i === index;
        li.setAttribute('aria-selected', on ? 'true' : 'false');
        li.classList.toggle('bg-mint-100', on);
        li.classList.toggle('dark:bg-mint-950', on);
        if (on) {
          input.setAttribute('aria-activedescendant', li.id);
          li.scrollIntoView({ block: 'nearest' });
        }
      });
  };

  const render = (typed: string) => {
    list.replaceChildren();
    if (items.length === 0) {
      if (typed.length >= 2) {
        const none = document.createElement('li');
        none.className = 'px-3 py-2 text-neutral-500 dark:text-neutral-400';
        none.textContent = 'No match.';
        list.appendChild(none);
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      } else {
        close();
      }
      return;
    }
    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className =
        'flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800';
      const label = document.createElement('span');
      label.className = 'font-medium';
      label.textContent = s.label;
      li.appendChild(label);
      if (s.detail) {
        const detail = document.createElement('span');
        detail.className =
          'shrink-0 text-xs text-neutral-500 dark:text-neutral-400';
        detail.textContent = s.detail;
        li.appendChild(detail);
      }
      // mousedown, not click: it lands before the box's blur closes the list.
      li.addEventListener('mousedown', event => {
        event.preventDefault();
        window.location.href = s.href;
      });
      list.appendChild(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };

  const lookUp = async () => {
    const typed = input.value.trim();
    if (typed.length < 2) {
      items = [];
      render(typed);
      return;
    }
    const mine = ++asked;
    try {
      const separator = endpoint.includes('?') ? '&' : '?';
      const response = await fetch(
        `${endpoint}${separator}q=${encodeURIComponent(typed)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) return;
      const body = (await response.json()) as { suggestions?: Suggestion[] };
      // A slower answer to an earlier keystroke never replaces a newer one.
      if (mine !== asked) return;
      items = body.suggestions ?? [];
      render(typed);
    } catch {
      // The list is a shortcut; without it the search still works.
    }
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lookUp, 200);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) void lookUp();
  });
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    const count = items.length;
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      highlight((active + 1) % count);
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      highlight((active - 1 + count) % count);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      window.location.href = items[active].href;
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(close, 120));
}

export function wireSearchSuggestions(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input[data-suggest]').forEach(wire);
}
