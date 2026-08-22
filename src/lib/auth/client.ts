import { getBackendProvider } from '@lib/config';
import type { BrowserAuth } from './types';
import { supabaseBrowserAuth } from './providers/supabase';

// Returns the browser-side auth surface for the configured backend.
export function getBrowserAuth(): BrowserAuth {
  switch (getBackendProvider()) {
    case 'supabase':
      return supabaseBrowserAuth;
    case 'entra':
      throw new Error(
        'Entra auth provider is not implemented yet (see docs/adr/0001-azure-native-backend.md).'
      );
  }
}
