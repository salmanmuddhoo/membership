// A short-lived, per-instance cache for reference configuration.
//
// Membership types and their fields, account types, document types and
// checklists, fee versions and the workflow chain are read on nearly every
// page — several of them more than once in the same request, by functions
// that do not know the others just asked the same question. None of it
// changes mid-request, and all of it changes rarely: an administrator edits
// it, then everyone reads it for weeks.
//
// So a read is kept for a few seconds on the warm instance, and any
// configuration write on this instance clears it (withConfigurationActor in
// db/pool.ts — the one door every such write goes through). Another warm
// instance sees the change once its own copy ages out, which is the trade
// accepted for the workflow chain first (S-614, phase 6): a few seconds of
// staleness after a rare administrative change, against paying the same
// queries three to five times on every click.
//
// The promise is cached rather than the value, so concurrent callers in one
// request share a single query instead of each starting their own.
//
// Not for anything that is a security boundary: resolvePrincipal deliberately
// reads permissions fresh on every request (S-107), and stays that way.
const CACHE_MS = 5_000;

const entries = new Map<string, { at: number; value: Promise<unknown> }>();

export function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.value as Promise<T>;
  }

  const value = load();
  entries.set(key, { at: Date.now(), value });
  // A failed read must not be served again for five seconds.
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
}

export function clearReferenceCache(): void {
  entries.clear();
}
