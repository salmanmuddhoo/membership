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
  prefetch: true,
  vite: {
    plugins: [tailwindcss()],
  },
});
