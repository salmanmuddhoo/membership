import type { APIContext } from 'astro';
import type { ServerAuth } from './types';
import { createEntraServerAuth } from './providers/entra';

// Returns the server-side auth surface. The backend is Microsoft Entra
// External ID (see docs/adr/0001-azure-native-backend.md).
export function createServerAuth(context: APIContext): ServerAuth {
  return createEntraServerAuth(context);
}
