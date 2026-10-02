// A dropdown with one thing to choose chooses it (officer request): a
// select that opens on a placeholder ("Choose…") and offers exactly one
// other option is set to that option on load, and told it changed so the
// page's own script follows (a reference field, a bank account). Only on
// forms that record something: a filter's "All" over one choice is a real
// answer and stays.
export function chooseTheOnlyOption(root: ParentNode = document): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>(
    'select:not([multiple])'
  )) {
    if (select.form?.method === 'get') continue;
    if (select.disabled) continue;
    const current = select.selectedOptions[0];
    if (current && current.value !== '') continue;
    const real = Array.from(select.options).filter(
      o => o.value !== '' && !o.disabled && !o.hidden
    );
    if (real.length !== 1) continue;
    select.value = real[0].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
