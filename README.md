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

The `MAILING_LIST` KV namespace already exists and its id is committed in
`wrangler.jsonc`, so deploying is just:

```sh
npx wrangler login
npm run deploy      # astro build && wrangler deploy -c dist/server/wrangler.json
```

The `SESSION` binding the adapter adds deliberately has no id — Wrangler
[provisions it automatically](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
on first deploy. Astro sessions are unused here; the binding only has to exist.

> The namespace id is an identifier, not a credential, so committing it is the
> documented practice — reaching the data needs Cloudflare account auth. Real
> secrets (API tokens, and the Kit key when that lands) belong in
> `wrangler secret put` or `.dev.vars`, never in this repo.

## Custom domains and redirects

Do this once, after the first successful deploy. Dashboard wording shifts from
time to time, so match on intent rather than exact labels.

### 0. The zone has to be on Cloudflare

`soupergreens.com` must be in the same Cloudflare account as the Worker.
If it isn't yet: **Account Home → Add a domain**, pick the Free plan, then
change the nameservers at your registrar to the two Cloudflare gives you.
Wait for the zone to go **Active** before continuing.

### 1. Attach both hostnames to the Worker

**Compute / Workers & Pages → souper-greens-web → Settings → Domains & Routes
→ Add → Custom Domain**, once for each:

- `soupergreens.com`
- `www.soupergreens.com`

Pick **Custom Domain**, not Route. A custom domain creates the DNS record and
issues the TLS certificate for you; a route only attaches the Worker to a
record you already manage.

Add `www` even though it only ever redirects — the redirect still has to be
served over HTTPS, which needs a valid certificate on that hostname.

Certificates take a few minutes. Both should read **Active** before you test.

### 2. Redirect www → apex

This is a **zone-level Redirect Rule**, not a Worker setting. The `_redirects`
file that Cloudflare Pages honoured does nothing on Workers — this rule is what
replaces it.

**The zone (soupergreens.com) → Rules → Redirect Rules → Create rule**

- **Name:** `www to apex`
- **If** — use the expression editor:
  ```
  http.host eq "www.soupergreens.com"
  ```
- **Then:**
  - Type: **Dynamic**
  - Expression:
    ```
    concat("https://soupergreens.com", http.request.uri.path)
    ```
  - Status code: **301**
  - **Preserve query string:** on

Use *Dynamic* rather than *Static*. A static redirect to
`https://soupergreens.com` throws away the path, so `/menu` would land on the
homepage.

Redirect Rules run before Workers in Cloudflare's request pipeline, so www
traffic is redirected without ever reaching the Worker.

### 3. Force HTTPS

On the zone:

- **SSL/TLS → Overview → encryption mode: Full (strict)**
- **SSL/TLS → Edge Certificates → Always Use HTTPS: On**

That covers both `http://` variants. It is on by default for new zones; just
confirm.

### 4. Verify all four

```sh
curl -sI http://soupergreens.com/      | grep -iE '^HTTP|^location'
curl -sI http://www.soupergreens.com/  | grep -iE '^HTTP|^location'
curl -sI https://www.soupergreens.com/ | grep -iE '^HTTP|^location'
curl -sI https://soupergreens.com/     | grep -iE '^HTTP'
```

| Request | Expected |
|---|---|
| `http://soupergreens.com` | 301 → `https://soupergreens.com/` |
| `http://www.soupergreens.com` | 301 → https, then 301 → apex |
| `https://www.soupergreens.com` | 301 → `https://soupergreens.com/` |
| `https://soupergreens.com` | 200 |

DNS and certificates can take a few minutes to settle; a failure in the first
minute or two usually is not a misconfiguration.

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
