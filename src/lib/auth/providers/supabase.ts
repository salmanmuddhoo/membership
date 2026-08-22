import type { APIContext } from 'astro';
import type { User } from '@supabase/supabase-js';
import {
  createBrowserClient,
  createServerClient,
  parseCookieHeader,
} from '@supabase/ssr';
import { getSupabaseConfig } from '@lib/config';
import type { AuthUser, BrowserAuth, ServerAuth } from '../types';

function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null;
  const role =
    (user.app_metadata?.role as string | undefined) ??
    (user.user_metadata?.role as string | undefined);
  return {
    id: user.id,
    email: user.email ?? null,
    roles: role ? [role] : [],
  };
}

// --- Server (request-scoped, cookie-based sessions) -----------------------
export function createSupabaseServerAuth(context: APIContext): ServerAuth {
  const { url, anonKey } = getSupabaseConfig();

  const client = createServerClient(url, anonKey, {
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

  return {
    async getUser() {
      const {
        data: { user },
      } = await client.auth.getUser();
      return toAuthUser(user);
    },
  };
}

// --- Browser (login / logout) ---------------------------------------------
let browserClient: ReturnType<typeof createBrowserClient> | null = null;

function getBrowserClient() {
  if (!browserClient) {
    const { url, anonKey } = getSupabaseConfig();
    browserClient = createBrowserClient(url, anonKey);
  }
  return browserClient;
}

export const supabaseBrowserAuth: BrowserAuth = {
  async signIn(email, password) {
    const { error } = await getBrowserClient().auth.signInWithPassword({
      email,
      password,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  },
  async signOut() {
    await getBrowserClient().auth.signOut();
  },
};
