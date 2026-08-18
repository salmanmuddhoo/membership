import type { APIContext } from 'astro';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { getSupabaseConfig } from './config';

// Creates a request-scoped Supabase client for server-side use (middleware,
// pages, API routes). Sessions are read from and written to cookies so they
// stay in sync with the browser client and survive page refreshes.
export function createSupabaseServerClient(context: APIContext) {
  const { url, anonKey } = getSupabaseConfig();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        const header = context.request.headers.get('Cookie') ?? '';
        return parseCookieHeader(header).map(({ name, value }) => ({
          name,
          value: value ?? '',
        }));
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          context.cookies.set(name, value, options);
        });
      },
    },
  });
}
