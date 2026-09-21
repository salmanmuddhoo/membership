/**
 * Hold on to what an officer has typed into the payment form while they are
 * away from it.
 *
 * Taking a cash payment over the threshold means leaving the Payments step
 * for the Cash Deposit Form and coming back — and, the way a plain link and
 * a server-rendered form work, coming back to a form reset to the fee
 * schedule's defaults. Officer feedback: the amount typed the first time was
 * lost, and so was the payment method, which is what made the form's own
 * button appear in the first place.
 *
 * Kept in sessionStorage, per application: it is a half-finished form, not a
 * record of anything, and it should not outlive the tab or follow the
 * officer to a different application. It is cleared the moment a payment is
 * actually recorded — from then on the receipt is the truth.
 */
const KEY_PREFIX = 'payment-draft:';

type Draft = Record<string, string>;

function fieldsOf(form: HTMLFormElement): HTMLElement[] {
  return [
    ...form.querySelectorAll<HTMLInputElement>('[data-amount-input]'),
    ...form.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
      '[name="method"], [name="methodReference"]'
    ),
  ];
}

function nameOf(field: HTMLElement): string {
  return (field as HTMLInputElement).name ?? '';
}

/** Storage can throw or be empty — a lost draft is a nuisance, not a fault. */
function read(key: string): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function write(key: string, draft: Draft): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Private browsing, or storage full. Nothing to do about it here.
  }
}

export function clearPaymentDraft(applicationId: string): void {
  try {
    window.sessionStorage.removeItem(KEY_PREFIX + applicationId);
  } catch {
    // As above.
  }
}

/**
 * Put back whatever was typed before, then keep saving as it changes.
 *
 * Call once, before the form's own first recalculation, so the total and the
 * cash rules are computed against the restored values rather than against
 * the defaults they replace.
 */
export function keepPaymentDraft(
  form: HTMLFormElement,
  applicationId: string
): void {
  if (!applicationId) return;
  const key = KEY_PREFIX + applicationId;
  const fields = fieldsOf(form);

  const draft = read(key);
  if (draft) {
    for (const field of fields) {
      const saved = draft[nameOf(field)];
      // A readonly amount is the fee schedule's own figure, not the
      // officer's, so it is never overwritten from a draft.
      if (saved === undefined) continue;
      if ((field as HTMLInputElement).readOnly) continue;
      (field as HTMLInputElement).value = saved;
    }
  }

  const save = () => {
    const next: Draft = {};
    for (const field of fields) {
      const name = nameOf(field);
      if (name) next[name] = (field as HTMLInputElement).value;
    }
    write(key, next);
  };

  for (const field of fields) {
    field.addEventListener('input', save);
    field.addEventListener('change', save);
  }

  // Once the payment is submitted the draft has served its purpose: either a
  // receipt exists, in which case the form is gone, or it was refused, in
  // which case the server re-renders with what was posted anyway.
  form.addEventListener('submit', () => clearPaymentDraft(applicationId));
}
