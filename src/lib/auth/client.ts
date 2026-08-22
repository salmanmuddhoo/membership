import { getBackendProvider } from '@lib/config';
import type { BrowserAuth } from './types';
import { supabaseBrowserAuth } from './providers/supabase';

// Returns the browser-side auth surface for the configured backend.
export function getBrowserAuth(): BrowserAuth {
  switch (getBackendProvider()) {
    case 'supabase':
      return supabaseBrowserAuth;
    case 'azure':
      throw new Error('Azure auth provider is not implemented yet.');
  }
}
