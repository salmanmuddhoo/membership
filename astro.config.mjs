import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// One repository, two hosts: Test on Vercel, production on Azure App
// Service. Astro takes a single adapter, but this file is a module, so the
// adapter is chosen when the build runs rather than written down once.
//
// Vercel sets VERCEL=1 in its own build environment, so Test needs no
// configuration at all; DEPLOY_TARGET is the explicit override for anyone
// who wants to produce a Vercel build elsewhere (CI does, to run
// verify:routes, which reads .vercel/output).
//
// The default is deliberately the Azure build. A pipeline that loses its
// variable then still builds production correctly and breaks Test instead —
// the cheaper of the two mistakes.
const buildsForVercel =
  !!process.env.VERCEL || process.env.DEPLOY_TARGET === 'vercel';

// Azure App Service terminates TLS in front of the app, so the Node server
// sees plain HTTP and would rebuild every request URL as `http://…`. Astro's
// cross-origin check then compares that against the browser's `https://…`
// Origin header, finds them different, and refuses every form submission with
// "Cross-site POST form submissions are forbidden" — sign-in included.
//
// Astro trusts `X-Forwarded-Proto` only when a host is pinned here, precisely
// so a crafted `X-Forwarded-Host` cannot rewrite `Astro.url`. Pinning the one
// host this deployment answers on buys the forwarded protocol without
// reopening that. Vercel hands the adapter a real HTTPS request and never
// needs it.
const siteUrl = process.env.PUBLIC_SITE_URL;
const proxiedHost = siteUrl ? new URL(siteUrl).hostname : undefined;

// https://astro.build/config
export default defineConfig({
  // Server-rendered so authentication can be enforced in middleware.
  output: 'server',
  adapter: buildsForVercel ? vercel() : node({ mode: 'standalone' }),
  // Public site URL, per environment: Azure and Vercel each serve their own
  // domain. PUBLIC_SITE_URL is set in the host's own configuration; the
  // fallback only ever applies to a local build.
  site: siteUrl ?? 'https://al-barakah.example.com',
  security: {
    allowedDomains: proxiedHost
      ? [{ hostname: proxiedHost, protocol: 'https' }]
      : [],
  },
  // Every same-origin link becomes prefetchable with no per-link markup
  // (prefetchAll) — `prefetch: true` alone only makes the data-astro-prefetch
  // attribute available, it does not turn it on anywhere, and nothing in
  // this project was opting in. 'tap' rather than the 'hover' default: an
  // officer on a tablet has no hover to fire it, only the touchstart/
  // mousedown 'tap' listens for, which still lands before the click's own
  // request goes out. The two links that perform something on GET rather
  // than just navigating (/auth/login, /auth/logout) opt out explicitly
  // with data-astro-prefetch="false" — touching down on "Sign out" must
  // never end the session by itself.
  prefetch: { prefetchAll: true, defaultStrategy: 'tap' },
  vite: {
    plugins: [tailwindcss()],
  },
});
