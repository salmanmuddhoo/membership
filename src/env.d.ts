/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  // Environment label shown in the UI (e.g. "test"). Public, not a secret.
  readonly PUBLIC_APP_ENV?: string;

  // Microsoft Entra External ID (server-side only; never exposed to the client)
  readonly ENTRA_METADATA_URL?: string;
  readonly ENTRA_AUTHORITY?: string;
  readonly ENTRA_TENANT_ID?: string;
  readonly ENTRA_CLIENT_ID?: string;
  readonly ENTRA_CLIENT_SECRET?: string;
  readonly ENTRA_REDIRECT_URI?: string;
  readonly ENTRA_POST_LOGOUT_REDIRECT_URI?: string;
  readonly ENTRA_SCOPES?: string;
  readonly AUTH_SESSION_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    // Populated by the auth middleware from the session cookie.
    user: import('@lib/auth/types').AuthUser | null;
  }
}
