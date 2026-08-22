import type { APIContext } from 'astro';

// Provider-agnostic representation of a signed-in user. The rest of the app
// depends only on this shape.
export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  roles: string[];
}

// Server-side auth surface used by middleware and pages.
export interface ServerAuth {
  getUser(): Promise<AuthUser | null>;
}

export type ServerAuthFactory = (context: APIContext) => ServerAuth;
