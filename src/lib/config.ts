// Central runtime configuration.
//
// The backend is chosen by PUBLIC_AUTH_PROVIDER so production can move from
// Supabase to Azure later without touching the rest of the app — only a new
// provider implementation and this switch are involved. Test/preview and
// production are separated purely by environment variables (scoped per
// environment in Vercel), so the same code runs everywhere.

export type BackendProvider = 'supabase' | 'azure';

export function getBackendProvider(): BackendProvider {
  const value = (
    import.meta.env.PUBLIC_AUTH_PROVIDER ?? 'supabase'
  ).toLowerCase();

  if (value !== 'supabase' && value !== 'azure') {
    throw new Error(
      `Unknown PUBLIC_AUTH_PROVIDER "${value}". Expected "supabase" or "azure".`
    );
  }

  return value;
}

export function getSupabaseConfig(): { url: string; anonKey: string } {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase configuration. Set PUBLIC_SUPABASE_URL and ' +
        'PUBLIC_SUPABASE_ANON_KEY (see .env.example).'
    );
  }

  return { url, anonKey };
}
