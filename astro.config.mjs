// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// The page itself is prerendered to static HTML; only /api/subscribe runs on
// demand (it opts out with `export const prerender = false`). The adapter is
// here for that one route — drop it and the site is pure static, but the
// signup form loses its backend.
export default defineConfig({
  site: 'https://soupergreens.com',
  adapter: cloudflare(),
});
