import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forwardToKit, kitFormNameFrom, type KVLike } from '../../lib/kit';

/**
 * POST /api/backfill-kit — replay KV subscribers that never reached Kit.
 *
 * Exists for outages like 2026-09-28, when a Kit-side misconfiguration meant
 * signups landed in KV (with kitError set) but were never forwarded, so no
 * confirmation emails went out. Each backfilled subscriber goes through the
 * normal form add, which triggers the form's double opt-in confirmation.
 *
 * Protected by the BACKFILL_TOKEN secret (Worker → Settings → Variables and
 * Secrets). Without that secret set, the endpoint refuses everything.
 *
 * Batch protocol: each call processes up to BATCH unsynced records and
 * reports progress; keep calling until {"done": true}. Records that fail
 * MAX_ATTEMPTS times are parked (kitBackfillAttempts) and listed so they can
 * be looked at by hand rather than retried forever.
 *
 *   curl -s -X POST https://soupergreens.com/api/backfill-kit \
 *     -H "Authorization: Bearer $BACKFILL_TOKEN" -H "Content-Type: application/json"
 */

export const prerender = false;

const BATCH = 15;
const MAX_ATTEMPTS = 3;
const PACE_MS = 120; // stay well under Kit's API rate limits

type SubscriberRecord = {
  email: string;
  kitSyncedAt?: string;
  kitError?: string;
  kitSkipped?: string;
  kitBackfillAttempts?: number;
  [key: string]: unknown;
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const bindings = env as unknown as Record<string, unknown>;

  const token = typeof bindings.BACKFILL_TOKEN === 'string' ? bindings.BACKFILL_TOKEN : '';
  const auth = request.headers.get('authorization') ?? '';
  if (!token || auth !== `Bearer ${token}`) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const kv = bindings.MAILING_LIST as KVLike | undefined;
  if (!kv || typeof kv.list !== 'function') {
    return json({ ok: false, error: 'MAILING_LIST binding unavailable' }, 500);
  }
  const kitApiKey = typeof bindings.KIT_API_KEY === 'string' ? bindings.KIT_API_KEY : '';
  if (!kitApiKey) {
    return json({ ok: false, error: 'KIT_API_KEY secret is not set' }, 500);
  }
  const formName = kitFormNameFrom(bindings);

  // Collect every subscriber key up front (a few hundred fits one page,
  // but page anyway).
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'subscriber:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let synced = 0;
  let alreadySynced = 0;
  let parked = 0;
  let processed = 0;
  const failures: Array<{ email: string; error: string; attempts: number }> = [];

  for (const key of keys) {
    if (processed >= BATCH) break;
    const raw = await kv.get(key);
    if (!raw) continue;
    let rec: SubscriberRecord;
    try {
      rec = JSON.parse(raw) as SubscriberRecord;
    } catch {
      continue;
    }
    if (rec.kitSyncedAt) {
      alreadySynced++;
      continue;
    }
    const attempts = rec.kitBackfillAttempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      parked++;
      continue;
    }

    processed++;
    try {
      await forwardToKit(rec.email, kitApiKey, kv, formName);
      rec.kitSyncedAt = new Date().toISOString();
      delete rec.kitError;
      delete rec.kitSkipped;
      synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rec.kitError = message.slice(0, 300);
      failures.push({ email: rec.email, error: message.slice(0, 120), attempts: attempts + 1 });
    }
    rec.kitBackfillAttempts = attempts + 1;
    try {
      await kv.put(key, JSON.stringify(rec));
    } catch {
      // the forward already happened; losing the annotation is recoverable
    }
    await new Promise((resolve) => setTimeout(resolve, PACE_MS));
  }

  return json({
    ok: true,
    done: processed === 0,
    totalSubscribers: keys.length,
    alreadySynced,
    syncedThisRun: synced,
    failedThisRun: failures.length,
    parkedAfterMaxAttempts: parked,
    failures: failures.slice(0, 5),
    note: processed === 0
      ? 'Nothing left to backfill (parked records, if any, need a human look).'
      : 'Run again until done is true.',
  });
};

export const ALL: APIRoute = () =>
  json({ ok: false, error: 'Method not allowed.' }, 405);
