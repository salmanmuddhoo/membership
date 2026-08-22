import type { APIContext } from 'astro';
import { getBackendProvider } from '@lib/config';
import type { ServerAuth } from './types';
import { createSupabaseServerAuth } from './providers/supabase';

// Returns the server-side auth surface for the configured backend.
export function createServerAuth(context: APIContext): ServerAuth {
  switch (getBackendProvider()) {
    case 'supabase':
      return createSupabaseServerAuth(context);
    case 'azure':
      // Add an Azure implementation (e.g. Entra ID) under providers/ and wire
      // it here. Kept explicit so the switch fails loudly until it exists.
      throw new Error('Azure auth provider is not implemented yet.');
  }
}
