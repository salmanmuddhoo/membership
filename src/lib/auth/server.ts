import type { APIContext } from 'astro';
import { getBackendProvider } from '@lib/config';
import type { ServerAuth } from './types';
import { createSupabaseServerAuth } from './providers/supabase';

// Returns the server-side auth surface for the configured backend.
export function createServerAuth(context: APIContext): ServerAuth {
  switch (getBackendProvider()) {
    case 'supabase':
      return createSupabaseServerAuth(context);
    case 'entra':
      // Implemented in providers/entra.ts in a follow-up (see ADR 0001).
      // Explicit so the switch fails loudly until it exists.
      throw new Error(
        'Entra auth provider is not implemented yet (see docs/adr/0001-azure-native-backend.md).'
      );
  }
}
