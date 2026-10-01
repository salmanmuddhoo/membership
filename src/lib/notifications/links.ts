// The link a staff notification carries: the page at the app's own origin,
// or, on an environment that has not said what its origin is, a line that
// still reads as an instruction rather than a broken URL.
import { getAppOrigin } from '../config';

export function appLink(path: string): string {
  const origin = getAppOrigin();
  return origin ? `${origin}${path}` : 'Sign in to open it.';
}
