import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // Server-rendered so authentication can be enforced in middleware.
  output: 'server',
  adapter: vercel(),
  // Public site URL. Set to the deployed domain in production.
  site: 'https://al-barakah.example.com',
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
