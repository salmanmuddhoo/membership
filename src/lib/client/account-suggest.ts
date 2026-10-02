// Suggestions under the number box on the Deposit, Withdrawal and Transfer
// lookups (officer feedback): as a number or a name is typed, the matching
// accounts of the chosen type are listed, and picking one opens that
// account's form. Typing a full number and pressing Enter still submits the
// lookup as before; the list is a shortcut, not the only way in.
//
// The page's form carries the box ([data-number]) and the account type: the
// radios (name="type") by default, or a select passed as options.typeSelect.
// With options.onPick, picking a suggestion hands it to the page instead of
// opening a form (the transfer form fills its box with it). The suggestions
// come from /transactions/lookup.json.

export interface Suggestion {
  accountId: string;
  accountNo: string;
  holderId: string;
  holderName: string;
}

export function wireAccountSuggest(
  form: HTMLFormElement,
  // The form under the person's page: deposit, withdraw or transfer.
  action: string,
  options: {
    // The account type comes from this select instead of the type radios.
    typeSelect?: HTMLSelectElement;
    // Called with the chosen suggestion instead of opening its form.
    onPick?: (suggestion: Suggestion) => void;
  } = {}
): void {
  const input = form.querySelector<HTMLInputElement>('[data-number]');
  if (!input) return;

  const host = input.parentElement!;
  host.classList.add('relative');
  const list = document.createElement('ul');
  list.id = 'account-suggestions';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  list.className =
    'absolute right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900';
  host.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  let items: Suggestion[] = [];
  let active = -1;
  let asked = 0;
  let timer: number | undefined;

  const destination = (s: Suggestion) =>
    `/members/${s.holderId}/${action}?account=${s.accountId}&from=transactions`;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const pick = (s: Suggestion) => {
    if (options.onPick) {
      close();
      options.onPick(s);
    } else {
      window.location.href = destination(s);
    }
  };

  const highlight = (index: number) => {
    active = index;
    list.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
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

  const render = () => {
    list.replaceChildren();
    if (items.length === 0) {
      close();
      return;
    }
    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `account-suggestion-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className =
        'flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800';
      const name = document.createElement('span');
      name.className = 'font-medium';
      name.textContent = s.holderName || '—';
      const number = document.createElement('code');
      number.className = 'text-xs text-neutral-500 dark:text-neutral-400';
      number.textContent = s.accountNo;
      li.append(name, number);
      // mousedown, not click: it lands before the box's blur closes the list.
      li.addEventListener('mousedown', event => {
        event.preventDefault();
        pick(s);
      });
      list.appendChild(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };

  const lookUp = async () => {
    const typed = input.value.trim();
    const type = options.typeSelect
      ? options.typeSelect.value
      : form.querySelector<HTMLInputElement>('input[name="type"]:checked')
          ?.value;
    if (typed.length < 2 || !type) {
      items = [];
      render();
      return;
    }
    const mine = ++asked;
    try {
      const response = await fetch(
        `/transactions/lookup.json?type=${encodeURIComponent(type)}&q=${encodeURIComponent(typed)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) return;
      const found = (await response.json()) as Suggestion[];
      // A slower answer to an earlier keystroke never replaces a newer one.
      if (mine !== asked) return;
      items = found;
      render();
    } catch {
      // The list is a shortcut; without it the lookup still works.
    }
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lookUp, 200);
  });
  const typeChanged = () => {
    if (input.value.trim()) void lookUp();
  };
  if (options.typeSelect) {
    options.typeSelect.addEventListener('change', typeChanged);
  } else {
    for (const radio of form.querySelectorAll('input[name="type"]')) {
      radio.addEventListener('change', typeChanged);
    }
  }
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlight(Math.min(active + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(Math.max(active - 1, 0));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      pick(items[active]);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', close);
}
