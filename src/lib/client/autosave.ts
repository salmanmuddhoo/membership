// Saving a capture form without a Save button (QA-05).
//
// S-302 saved continuously — two seconds after typing stopped, on leaving a
// field, on an interval and on leaving the page — and S-614 phase 7 took all
// of it out for Next alone, because a request on every pause in typing read
// as the application being slow. That left an officer interrupted before
// Next with nothing saved. This brings back the two moments that cost the
// officer nothing: leaving a field they changed, and leaving the page
// (another tab, the tablet locked, the tab closed). Never while typing.
//
// Saves run one after another, never two at once: the first save of a new
// application is the one that creates it and moves the address to
// /applications/<id>, and a second one racing it would create a second
// application. Next awaits whatever is running, then saves what is left.

export interface AutosaveOptions {
  form: HTMLFormElement;
  // One save of the whole form. `leaving` is true when the page is going
  // away: the request must then be sent with keepalive, and nothing on the
  // page is worth updating.
  save: (leaving: boolean) => Promise<boolean>;
  // False while there is nothing worth saving (a new form still blank).
  worthSaving?: () => boolean;
}

export interface Autosave {
  // Saves now if anything changed since the last save, after any save
  // already running. Resolves to whether the form is saved.
  flush: () => Promise<boolean>;
}

export function wireAutosave(options: AutosaveOptions): Autosave {
  const { form, save } = options;
  const worthSaving = options.worthSaving ?? (() => true);
  let dirty = false;
  let chain: Promise<boolean> = Promise.resolve(true);

  const run = (leaving: boolean): Promise<boolean> => {
    chain = chain.then(async () => {
      if (!dirty || !worthSaving()) return !dirty;
      dirty = false;
      const saved = await save(leaving);
      // Still unsaved: the next trigger tries again.
      if (!saved) dirty = true;
      return saved;
    });
    return chain;
  };

  const changed = () => {
    dirty = true;
  };
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);

  // Leaving a field. focusout bubbles; blur does not.
  form.addEventListener('focusout', event => {
    const target = event.target as HTMLElement | null;
    if (!target || !('name' in target)) return;
    void run(false);
  });

  // Leaving the page. pagehide for a closed tab or a navigation,
  // visibilitychange for a tablet that locks or another app in front — the
  // one of the two a mobile browser reliably fires.
  window.addEventListener('pagehide', () => void run(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void run(true);
  });

  return {
    flush: () => {
      // Next: whatever changed must be saved before moving on, even if a
      // save is already running for an earlier change.
      dirty = dirty || worthSaving();
      return run(false);
    },
  };
}
