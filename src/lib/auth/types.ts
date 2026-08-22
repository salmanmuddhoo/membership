import type { APIContext } from 'astro';

// Minimal, provider-agnostic representation of a signed-in user. The rest of
// the app depends only on this shape — never on a specific backend's types —
// so the backend can be swapped without ripple effects.
export interface AuthUser {
  id: string;
  email: string | null;
  roles: string[];
}

export interface SignInResult {
  ok: boolean;
  /** Provider error message (already-safe; UI maps it to friendly copy). */
  error?: string;
}

// Server-side auth surface used by middleware and pages.
export interface ServerAuth {
  getUser(): Promise<AuthUser | null>;
}

// Browser-side auth surface used by the login and logout flows.
export interface BrowserAuth {
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
}

export type ServerAuthFactory = (context: APIContext) => ServerAuth;
