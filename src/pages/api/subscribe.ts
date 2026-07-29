import type { APIRoute } from 'astro';
// Astro 7 removed `Astro.locals.runtime.env`; bindings come from the Workers
// runtime module now. The adapter marks `cloudflare:*` imports external, so it
// resolves inside the Worker and never during the static prerender.
import { env } from 'cloudflare:workers';

type KVLike = { put(key: string, value: string): Promise<unknown> };

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
  'Text me news, offers, and updates from Souper Greens at this number. ' +
  "Consent isn't a condition of any purchase; message frequency varies; " +
  'message and data rates may apply; reply STOP to opt out or HELP for help.';

function normalizePhone(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'yes' || value === 'on' || value === 'true';
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
  let wantsHtml = false;

  const contentType = request.headers.get('content-type') || '';
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

  const mailingList = (env as unknown as Record<string, KVLike | undefined>).MAILING_LIST;
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
