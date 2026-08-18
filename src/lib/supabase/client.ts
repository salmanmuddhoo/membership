import { createBrowserClient } from '@supabase/ssr';
import { getSupabaseConfig } from './config';

// Browser-side Supabase client used by the login and logout flows.
// It persists the session in cookies so the server middleware can read it.
const { url, anonKey } = getSupabaseConfig();

export const supabase = createBrowserClient(url, anonKey);
