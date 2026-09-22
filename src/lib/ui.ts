// The screen's vocabulary (design audit).
//
// Every page composes the same handful of things — a page of one of four
// widths, a grey card with a title, a white panel inside it, a label over an
// input, a mint button — and until now each page spelt them out itself, so
// a form was 2xl here and 3xl there, a card p-4 here and p-6 there, a submit
// button one size and the row's button another. This is the one place they
// are spelt, and a page reaches for the name rather than the classes.
//
// A page picks its width by what it is for, not by taste:
//   PAGE.form    one thing to fill in and submit — a deposit, a closure
//   PAGE.detail  one record and what can be done to it — a member, a request
//   PAGE.list    lists, hubs and configuration — the register, a queue
//   PAGE.wide    tables that need the room — the audit log, a report
//
// Cards: CARD is a section of the page (grey); PANEL is one item inside a
// section (white); FILTER is the bar of controls over a table, or a tile of
// counts — shorter than a section so it does not read as one.
//
// Buttons: BUTTON is the action of a form or a card, at its foot; BUTTON_SM
// sits inside a table row, a list item or beside a single field.

export const PAGE = {
  form: 'mx-auto max-w-3xl space-y-6',
  detail: 'mx-auto max-w-4xl space-y-6',
  list: 'mx-auto max-w-5xl space-y-6',
  wide: 'mx-auto max-w-6xl space-y-6',
} as const;

export const CARD =
  'rounded-2xl border border-neutral-200 bg-neutral-100 p-6 dark:border-neutral-800 dark:bg-neutral-950';
// A form that is a card: the same card, with its fields spaced.
export const FORM_CARD = `space-y-4 ${CARD}`;
export const FILTER =
  'rounded-2xl border border-neutral-200 bg-neutral-100 p-4 dark:border-neutral-800 dark:bg-neutral-950';
export const PANEL =
  'rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900';

export const CARD_TITLE =
  'text-lg font-semibold text-neutral-800 dark:text-neutral-100';
// The small capitals a wizard's step or a request's block is labelled with.
export const CARD_LABEL =
  'text-sm font-semibold text-neutral-700 uppercase dark:text-neutral-200';
export const HINT = 'text-sm text-neutral-500 dark:text-neutral-400';
export const MUTED = 'text-sm text-neutral-600 dark:text-neutral-300';

export const LABEL = 'block text-sm text-neutral-600 dark:text-neutral-300';
// A field's control: INPUT under a label, full width; INPUT_BARE where the
// width is the page's to set (a short code, an amount in a row).
export const INPUT_BARE =
  'rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100';
export const INPUT = `mt-1 block w-full ${INPUT_BARE}`;

const BUTTON_BASE =
  'bg-mint-300 hover:bg-mint-400 rounded-lg text-sm font-bold text-neutral-800 transition disabled:cursor-not-allowed disabled:opacity-50';
export const BUTTON = `${BUTTON_BASE} px-4 py-2`;
export const BUTTON_SM = `${BUTTON_BASE} px-3 py-1.5`;

const SECONDARY_BASE =
  'rounded-lg border border-neutral-300 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800';
export const SECONDARY = `${SECONDARY_BASE} px-4 py-2`;
export const SECONDARY_SM = `${SECONDARY_BASE} px-3 py-1.5`;

const DANGER_BASE =
  'rounded-lg border border-red-300 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950';
export const DANGER = `${DANGER_BASE} px-4 py-2`;
export const DANGER_SM = `${DANGER_BASE} px-3 py-1.5`;
