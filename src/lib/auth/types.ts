import type { APIContext } from 'astro';

// Provider-agnostic representation of a signed-in user. The rest of the app
// depends only on this shape.
export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  roles: string[];
  // The sign-in this request belongs to, and when it last did anything
  // (seconds since the epoch) — what the idle sign-out measures. Absent on a
  // token minted without them, which then reads as active since it was issued.
  sessionId?: string;
  lastSeen?: number;
  signedInAt?: number;
}

// Server-side auth surface used by middleware and pages.
export interface ServerAuth {
  getUser(): Promise<AuthUser | null>;
}

export type ServerAuthFactory = (context: APIContext) => ServerAuth;
