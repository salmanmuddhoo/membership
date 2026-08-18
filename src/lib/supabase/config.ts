// Reads Supabase configuration from environment variables.
// Values are resolved lazily so the app builds even when env vars are absent,
// and fails with a clear message at runtime if they are missing.
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
