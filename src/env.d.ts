/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly PUBLIC_AUTH_PROVIDER?: 'supabase' | 'azure';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    // Populated by the auth middleware; provider-agnostic.
    user: import('@lib/auth/types').AuthUser | null;
  }
}
