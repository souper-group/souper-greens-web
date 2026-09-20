import type { APIRoute } from 'astro';
// Astro 7 removed `Astro.locals.runtime.env`; bindings come from the Workers
// runtime module now. The adapter marks `cloudflare:*` imports external, so it
// resolves inside the Worker and never during the static prerender.
import { env } from 'cloudflare:workers';

type KVLike = {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
};
type RateLimiterLike = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * POST /api/subscribe — store a mailing-list signup in Workers KV.
 *
 * The only on-demand route on the site; everything else is prerendered.
 * Requires a KV namespace bound as `MAILING_LIST` (see wrangler.jsonc).
 *
 * Each signup is stored as:
 *   key:   subscriber:<email, lowercased>
 *   value: {"email":"…","joinedAt":"<ISO>","source":"landing-page",
 *           "phone":"+16265550123","smsConsent":true,
 *           "smsConsentAt":"<ISO>","smsConsentText":"<exact wording shown>"}
 *
 * Re-submitting the same email refreshes the record, so the list stays
 * deduplicated by construction.
 *
 * Phone is optional and is only ever stored alongside an explicit consent
 * checkbox. The consent wording is kept server-side rather than trusted from
 * the client, so the stored record is a reliable account of what the person
 * agreed to. IF YOU EDIT THE CONSENT SENTENCE IN src/pages/index.astro, EDIT
 * THE MATCHING CONSTANT BELOW TOO.
 */

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SMS_CONSENT_TEXT =
  '(Optional) Yes — send me Souper Greens marketing texts: news, offers, and ' +
  "opening updates at this number. Consent isn't a condition of any purchase; " +
  'message frequency varies; message and data rates may apply; reply STOP to ' +
  'opt out or HELP for help.';

function normalizePhone(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'yes' || value === 'on' || value === 'true';
}

/* ── Kit forwarding ──
 * KV is the durable record; Kit is best-effort on top. Adding a subscriber to
 * the form via the API still triggers the form's double opt-in, so people
 * confirm by email before going active. A Kit failure is logged and the record
 * simply lacks kitSyncedAt, which is the backfill marker.
 */
const KIT_API_BASE = 'https://api.kit.com/v4';
const KIT_FORM_NAME = 'landing page'; // matched case-insensitively
const KIT_FORM_CACHE_KEY = 'kit:form_id';

function kitFetch(path: string, apiKey: string, init?: { method?: string; body?: string }): Promise<Response> {
  return fetch(KIT_API_BASE + path, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': apiKey },
    signal: AbortSignal.timeout(5000),
  });
}

async function resolveKitFormId(apiKey: string, kv: KVLike): Promise<string> {
  const cached = await kv.get(KIT_FORM_CACHE_KEY);
  if (cached) return cached;

  const res = await kitFetch('/forms', apiKey);
  if (!res.ok) throw new Error(`Kit GET /forms responded ${res.status}`);
  const data = (await res.json()) as { forms?: Array<{ id: number | string; name?: string }> };
  const forms = data.forms ?? [];
  const match =
    forms.find((f) => (f.name ?? '').trim().toLowerCase() === KIT_FORM_NAME) ??
    (forms.length === 1 ? forms[0] : undefined);
  if (!match) throw new Error(`Kit form "${KIT_FORM_NAME}" not found among ${forms.length} forms`);

  const id = String(match.id);
  await kv.put(KIT_FORM_CACHE_KEY, id, { expirationTtl: 86400 });
  return id;
}

async function forwardToKit(email: string, apiKey: string, kv: KVLike): Promise<void> {
  const formId = await resolveKitFormId(apiKey, kv);
  // Kit wants the subscriber to exist before a form add by email. The create
  // is an upsert in practice, so an already-known address is not an error —
  // only the form add is required to succeed.
  const create = await kitFetch('/subscribers', apiKey, {
    method: 'POST',
    body: JSON.stringify({ email_address: email }),
  });
  if (!create.ok && create.status !== 409 && create.status !== 422) {
    throw new Error(`Kit POST /subscribers responded ${create.status}`);
  }
  const add = await kitFetch(`/forms/${formId}/subscribers`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ email_address: email }),
  });
  if (!add.ok) throw new Error(`Kit form add responded ${add.status}`);
}

function respond(ok: boolean, error: string | null, status: number, wantsHtml: boolean): Response {
  if (wantsHtml) {
    const heading = ok ? "You're on the list." : 'Hmm, that did not work.';
    const detail = ok ? "We'll save you a seat." : error || 'Please go back and try again.';
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} — Souper Greens</title>
<style>body{font-family:'Manrope',system-ui,sans-serif;background:#006847;color:#FAFBFF;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}a{color:#FF8B2E;font-weight:600}</style>
</head><body><main><h1>${heading}</h1><p>${detail}</p><p><a href="/">Back to Souper Greens</a></p></main></body></html>`;
    return new Response(html, {
      status: ok ? 200 : status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let email = '';
  let honeypot = '';
  let rawPhone = '';
  let smsConsent = false;
  // A JSON body means the client script is running; anything else is the
  // no-JS form post, which wants an HTML page back.
  const contentType = request.headers.get('content-type') || '';
  let wantsHtml = !contentType.includes('application/json');

  // Second line of defence behind the zone-level WAF rule: per-IP throttle
  // inside the Worker, mostly to keep a scripted client from spraying Kit
  // confirmation emails. Fails open if the binding is missing (local dev).
  const bindings = env as unknown as Record<string, unknown>;
  const limiter = bindings.SIGNUP_RATE_LIMITER as RateLimiterLike | undefined;
  if (limiter && typeof limiter.limit === 'function') {
    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await limiter.limit({ key: ip });
      if (!success) {
        return respond(false, 'That was a lot of signups at once — give it a minute and try again.', 429, wantsHtml);
      }
    } catch {
      // fail open — the WAF rule still stands in front of us
    }
  }

  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      email = String(body.email ?? '');
      honeypot = String(body.website ?? '');
      rawPhone = String(body.phone ?? '');
      smsConsent = isTruthy(body.smsConsent);
    } else {
      // No-JS fallback: a plain form post.
      const form = await request.formData();
      email = String(form.get('email') ?? '');
      honeypot = String(form.get('website') ?? '');
      rawPhone = String(form.get('phone') ?? '');
      smsConsent = isTruthy(form.get('smsConsent'));
      wantsHtml = true;
    }
  } catch {
    return respond(false, 'We could not read that request.', 400, wantsHtml);
  }

  // A filled honeypot means a bot — pretend everything worked.
  if (honeypot.trim() !== '') {
    return respond(true, null, 200, wantsHtml);
  }

  email = email.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return respond(false, 'That email address does not look right — mind checking it?', 400, wantsHtml);
  }

  let phone: string | null = null;
  if (rawPhone.trim() !== '') {
    phone = normalizePhone(rawPhone);
    if (!phone) {
      return respond(false, 'Please enter a 10-digit US mobile number, or leave it blank.', 400, wantsHtml);
    }
    // No consent, no number — drop the phone rather than reject the signup,
    // so the person still gets on the email list.
    if (!smsConsent) phone = null;
  }

  const mailingList = bindings.MAILING_LIST as KVLike | undefined;
  if (!mailingList || typeof mailingList.put !== 'function') {
    return respond(false, 'Signups are not quite ready yet — please try again later.', 500, wantsHtml);
  }

  const now = new Date().toISOString();
  const record: Record<string, unknown> = {
    email,
    joinedAt: now,
    source: 'landing-page',
  };
  if (phone) {
    record.phone = phone;
    record.smsConsent = true;
    record.smsConsentAt = now;
    record.smsConsentText = SMS_CONSENT_TEXT;
  }

  try {
    await mailingList.put(`subscriber:${email}`, JSON.stringify(record));
  } catch {
    return respond(false, 'Something went wrong saving your signup — please try again in a minute.', 500, wantsHtml);
  }

  // KV write succeeded — the signup is safe regardless of what happens next.
  // The Kit outcome is recorded on the KV record itself so it can be diagnosed
  // from the dashboard's KV view without chasing logs: kitSyncedAt on success,
  // kitError with the reason on failure, kitSkipped when no key is configured.
  const kitApiKey = typeof bindings.KIT_API_KEY === 'string' ? bindings.KIT_API_KEY : '';
  if (kitApiKey) {
    try {
      await forwardToKit(email, kitApiKey, mailingList);
      record.kitSyncedAt = new Date().toISOString();
      delete record.kitError;
    } catch (err) {
      // Not the subscriber's problem: they are in KV, and the missing
      // kitSyncedAt field marks this record for a later backfill.
      const message = err instanceof Error ? err.message : String(err);
      record.kitError = message.slice(0, 300);
      console.error(`Kit forward failed for ${email}:`, message);
    }
  } else {
    record.kitSkipped = 'no KIT_API_KEY secret visible to the worker';
  }
  try {
    await mailingList.put(`subscriber:${email}`, JSON.stringify(record));
  } catch {
    // The original record is already stored; losing the annotation is fine.
  }

  return respond(true, null, 200, wantsHtml);
};

export const ALL: APIRoute = ({ request }) => {
  if (request.method === 'POST') {
    // Handled by the POST export above; this only catches other verbs.
    return new Response(null, { status: 405 });
  }
  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed.' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
};
