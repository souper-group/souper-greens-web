# souper-greens-web

soupergreens.com — an [Astro](https://astro.build) site deployed to
**Cloudflare Workers** with static assets.

The page itself is prerendered to static HTML. One route runs on demand:
`POST /api/subscribe`, which stores mailing-list signups in Workers KV.

Built with the Souper Greens Design System (green `#006847`, orange `#FF8B2E`,
paper `#FAFBFF`, Manrope).

## Layout

```
src/
  pages/
    index.astro          ← the landing page (markup + client script)
    api/subscribe.ts     ← POST /api/subscribe → Workers KV
  styles/
    global.css           ← design-system tokens + page styles
public/
  assets/                ← logos, favicon, photos
  robots.txt
astro.config.mjs
wrangler.jsonc           ← Worker name, compat date, assets, KV binding
```

## Local development

```sh
npm install
npm run dev        # Astro dev server, fast refresh
npm run preview    # build + wrangler dev — the real Worker runtime
```

Use `npm run preview` when you need `/api/subscribe` to behave exactly as it
will in production; `npm run dev` does not run the Workers runtime.

## Build output

`npm run build` produces:

- `dist/client/` — static assets (this is what `assets.directory` points at)
- `dist/server/` — the Worker, plus a generated `dist/server/wrangler.json`

**That generated config is the one you deploy with.** The adapter resolves
`main` and rewrites `assets.directory` to `../client` when it writes it, which
is why the root `wrangler.jsonc` deliberately has no `main` field — setting one
there fails the build, because the Vite plugin validates the path before the
build has produced it.

## Deploying

One-time setup:

```sh
npx wrangler login
npx wrangler kv namespace create MAILING_LIST
```

Paste the returned namespace id into `wrangler.jsonc` (replacing
`REPLACE_WITH_KV_NAMESPACE_ID`), then:

```sh
npm run deploy      # astro build && wrangler deploy -c dist/server/wrangler.json
```

To attach the domain, add `soupergreens.com` and `www.soupergreens.com` as
custom domains on the Worker, and keep "Always Use HTTPS" on for the zone. The
www → apex redirect needs a Redirect Rule on the zone; the `_redirects` file
that Pages honoured does **not** apply to Workers.

## Reading the mailing list

```sh
npx wrangler kv key list --binding MAILING_LIST -c dist/server/wrangler.json
```

A stored record:

```json
{
  "email": "someone@example.com",
  "joinedAt": "2026-07-29T08:21:21.441Z",
  "source": "landing-page",
  "phone": "+16265550123",
  "smsConsent": true,
  "smsConsentAt": "2026-07-29T08:21:21.441Z",
  "smsConsentText": "Text me news, offers, and updates from Souper Greens …"
}
```

The last four keys appear **only** when someone entered a number *and* ticked
the consent box. A number submitted without consent is discarded server-side
while the email signup still succeeds.

### Before you send a single text

US marketing texts are governed by the TCPA, which requires prior express
written consent and carries per-message statutory damages. The form supports
that, but the code alone does not make you compliant:

- The consent wording lives in **two** places that must stay in sync —
  `src/pages/index.astro` (`#sms-consent-text`) and the `SMS_CONSENT_TEXT`
  constant in `src/pages/api/subscribe.ts`. The server stores its own copy
  rather than trusting the browser, so each record is an auditable account of
  what the person agreed to. Edit both together.
- You still need a way to **honor STOP** and keep an opt-out list — whichever
  SMS platform you choose must handle that.
- Have counsel review the consent language and your first campaign.

## Editing common things

- **Copy** — `src/pages/index.astro`. Brand voice: warm and communal, no
  Souplantation affiliation claims, no diet-culture language, no unconfirmed
  dates or prices. The page deliberately keeps nostalgia off the table and
  leads with intrigue; the "Fresh Flavors, Fond Memories" tagline named in the
  brand guidelines is intentionally *not* used here.
- **Rotating headline words** — the `<span class="word">` list in the `<h1>`.
  Hold times derive from position (1s each, 3s on the last), so adding or
  removing a word needs no JS change. An invisible `.word-sizer` holds the box
  at the width of "fork." so the line stays optically centred.
- **Photos** — drop images into `public/assets/photos/` and list them in the
  `PHOTOS` array in the page's `<script>`. The "First look" section stays
  hidden while the array is empty.
- **Toast waitlist** — paste the URL into the `LOCATIONS` array in the same
  script; the waitlist section appears automatically.

## Accessibility notes

Targets WCAG AA (seniors are a core audience). Where the design system's own
patterns fail AA, this page substitutes on-palette alternatives, commented in
`global.css`. Two deliberate misses remain for brand fidelity:

1. The primary button — paper on orange `#FF8B2E` is 2.26:1. Black on orange
   would pass at 8.96:1 and stay on-palette.
2. The rotating words in orange on green are 2.93:1, just under the 3:1
   large-text threshold. A lighter tint (`#FF9B47`, 3.26:1) would clear it.
   The resting word, "eat.", is paper on green at 6.61:1 and passes.

## Notes on the CSRF check

Astro's `checkOrigin` protection rejects form-encoded POSTs without a matching
`Origin` header. Browsers always send one, so the no-JS fallback works; be
aware if you ever script against the endpoint directly.
