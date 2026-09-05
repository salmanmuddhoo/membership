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

// Preline ships type declarations only for its self-registering ("auto")
// builds. The non-auto builds BaseLayout imports are the same classes minus
// that registration, so they borrow the auto builds' types.
declare module 'preline/plugins/dropdown-non-auto' {
  export { default } from 'preline/plugins/dropdown';
}
declare module 'preline/plugins/overlay-non-auto' {
  export { default } from 'preline/plugins/overlay';
}
declare module 'preline/plugins/theme-switch-non-auto' {
  export { default } from 'preline/plugins/theme-switch';
}

// ConfirmDialog.astro's replacement for window.confirm()/alert() — one
// dialog shared across the app instead of the browser's own popup.
interface ConfirmOptions {
  okLabel?: string;
  cancelLabel?: string;
  // Red OK button. Defaults to true for appConfirm/confirmedSubmit (every
  // caller so far is guarding a delete, a void, or a permanent reset) and
  // is ignored by appAlert, which never shows Cancel to begin with.
  danger?: boolean;
}

interface Window {
  appConfirm(message: string, options?: ConfirmOptions): Promise<boolean>;
  appAlert(
    message: string,
    options?: Pick<ConfirmOptions, 'okLabel'>
  ): Promise<void>;
  confirmedSubmit(
    form: HTMLFormElement,
    message: string,
    options?: ConfirmOptions
  ): void;
}

declare namespace App {
  interface Locals {
    // Populated by the auth middleware from the session cookie.
    user: import('@lib/auth/types').AuthUser | null;

    // The signed-in user resolved against this system's own records, with the
    // permissions their roles confer. Null until the middleware has matched an
    // active account — a valid Entra session alone does not produce one.
    principal: import('@lib/access/principal').Principal | null;

    // The "Applications" badge count, started by the middleware before the
    // page's own reads so the two overlap; DashboardLayout awaits it. Absent
    // for API requests and for anyone without application.view.
    pendingActions?: Promise<number>;
  }
}
