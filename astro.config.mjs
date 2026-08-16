// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

// The page itself is prerendered to static HTML; only /api/subscribe runs on
// demand (it opts out with `export const prerender = false`). The adapter is
// here for that one route — drop it and the site is pure static, but the
// signup form loses its backend.
//
// `site` is the apex host, so canonical tags and sitemap entries are apex-only.
// www is 301'd to apex at the Cloudflare edge and never appears in our markup.
export default defineConfig({
  site: 'https://soupergreens.com',
  adapter: cloudflare(),
  integrations: [sitemap()],
});
