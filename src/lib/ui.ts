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
// A one-line card that is itself a link to a queue ("Waiting on you"):
// the title on the left, the count and an arrow on the right.
export const LINK_CARD =
  'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-neutral-200 bg-neutral-100 px-6 py-4 transition hover:border-mint-400 hover:bg-white dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-mint-700 dark:hover:bg-neutral-900';
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

// One line of feedback in a box: what went wrong, what to watch, what is
// done, or a plain note. A notice sits above or inside a card and never
// grows into one; something that needs a title is a CARD_OK or CARD_DANGER.
export const NOTICE_ERROR =
  'rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200';
export const NOTICE_WARN =
  'rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200';
export const NOTICE_OK =
  'border-mint-400 bg-mint-50 dark:border-mint-700 dark:bg-mint-950 rounded-lg border px-4 py-3 text-sm text-neutral-800 dark:text-neutral-100';
export const NOTICE =
  'rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
// A section that is good news — the account found, the request ready to go.
export const CARD_OK =
  'border-mint-400 bg-mint-50 dark:border-mint-700 dark:bg-mint-950 rounded-2xl border p-6';
// A section that destroys something, and the one button that does it.
export const CARD_DANGER =
  'rounded-2xl border border-red-300 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950';
export const CARD_DANGER_TITLE =
  'text-lg font-semibold text-red-900 dark:text-red-200';
export const BUTTON_DESTRUCTIVE =
  'rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50';

// A heading inside a card, below its title.
export const SUBTITLE =
  'text-sm font-semibold text-neutral-700 dark:text-neutral-200';
// A label wrapping a checkbox or radio, reading as one line.
export const CHECK_LABEL =
  'flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-100';
// A field inside a table row or an inline edit: the same input, smaller.
export const INPUT_SM =
  'rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100';

// Small marks beside a name: TAG is a code or a count (square), PILL a
// status (round); the WARN forms are amber, the OUTLINE forms quieter.
export const TAG =
  'rounded bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
export const PILL =
  'rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
export const PILL_WARN =
  'rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-100';
export const PILL_OUTLINE =
  'rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-600 dark:text-neutral-300';
export const PILL_OUTLINE_WARN =
  'rounded-full border border-amber-300 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-700 dark:text-amber-300';

// A button that is only an icon, beside a field.
export const ICON_BUTTON =
  'shrink-0 rounded-lg border border-neutral-300 p-1.5 text-neutral-600 transition hover:bg-neutral-200 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800';
// A block of code or a schema, scrolling past a height.
export const CODE_BLOCK =
  'max-h-72 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300';

// A dialog: the box, centred over a dimmed page, and its header row. The
// page adds the width and the padding it needs (w-[90vw] max-w-lg p-0).
export const DIALOG =
  'fixed top-1/2 left-1/2 m-0 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-neutral-200 bg-white text-neutral-800 backdrop:bg-neutral-900/50 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100';
export const DIALOG_HEADER =
  'flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800';

// A table: the header row in small capitals, rows divided by a hairline,
// a cell with room to its right, and a figure right-aligned in tabular
// numerals. A table that must scroll sits in a div with overflow-x-auto.
export const TABLE = 'w-full text-sm';
export const THEAD =
  'text-left text-xs text-neutral-500 uppercase dark:text-neutral-400';
export const TBODY = 'divide-y divide-neutral-200 dark:divide-neutral-800';
export const ROW = 'border-t border-neutral-200 dark:border-neutral-800';
export const TH = 'py-2 pr-4 font-medium';
export const TD = 'py-2 pr-4';
export const TD_NUM = 'py-2 pr-4 text-right tabular-nums';

const BUTTON_BASE =
  'bg-mint-300 hover:bg-mint-400 rounded-lg font-bold text-neutral-800 transition disabled:cursor-not-allowed disabled:opacity-50';
export const BUTTON = `${BUTTON_BASE} px-4 py-2 text-sm`;
export const BUTTON_SM = `${BUTTON_BASE} px-3 py-1.5 text-sm`;

// Officer feedback: a secondary button has a white fill, so it reads as a
// button on a grey card rather than a box drawn round some text.
const SECONDARY_BASE =
  'rounded-lg border border-neutral-300 bg-white font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800';
export const SECONDARY = `${SECONDARY_BASE} px-4 py-2 text-sm`;
export const SECONDARY_SM = `${SECONDARY_BASE} px-3 py-1.5 text-sm`;
// A bar of tabs between sibling pages (Configuration's sections, the API's
// reference and credentials): the page you are on is TAB_CURRENT, the
// others SECONDARY_SM, the same size.
export const TAB_CURRENT =
  'rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-800 bg-mint-300 transition';
// XS: inside a dense row, where even the small button is too much.
export const SECONDARY_XS = `${SECONDARY_BASE} px-2.5 py-1 text-xs`;

// A closing or deleting action: red border on a light red fill.
const DANGER_BASE =
  'rounded-lg border border-red-300 bg-red-50 font-medium text-red-700 transition hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950';
export const DANGER = `${DANGER_BASE} px-4 py-2 text-sm`;
export const DANGER_SM = `${DANGER_BASE} px-3 py-1.5 text-sm`;
export const DANGER_XS = `${DANGER_BASE} px-2.5 py-1 text-xs`;

// A filed document's two controls, the same everywhere: View opens it in
// the viewer, the red ✕ beside it deletes it. The same height, View first,
// at the right-hand end of the document's row. Only the ✕ glyph goes in
// DELETE_BUTTON, with an aria-label saying what it deletes.
export const VIEW_BUTTON = `${SECONDARY_BASE} inline-flex h-7 shrink-0 items-center px-2.5 text-xs`;
export const DELETE_BUTTON = `${DANGER_BASE} inline-flex h-7 w-7 shrink-0 items-center justify-center text-sm font-semibold`;
