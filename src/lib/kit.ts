/**
 * Kit (kit.com) forwarding, shared by the live signup route and the backfill.
 *
 * KV is always the durable record; Kit is best-effort on top. Adding a
 * subscriber to the form via the API triggers the form's double opt-in, so
 * people confirm by email before going active.
 *
 * The target form is found by name (case-insensitive), configured via the
 * KIT_FORM_NAME var in wrangler.jsonc. If the account has exactly one form,
 * that form is used regardless of name. Incident note (2026-09-28): a second
 * form appearing in the account disabled the only-form fallback and every
 * signup failed with 'form "landing page" not found among 2 forms' — keep
 * the Kit form's name and KIT_FORM_NAME in sync.
 */

export type KVLike = {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

const KIT_API_BASE = 'https://api.kit.com/v4';
export const DEFAULT_KIT_FORM_NAME = 'landing page';

function kitFetch(path: string, apiKey: string, init?: { method?: string; body?: string }): Promise<Response> {
  return fetch(KIT_API_BASE + path, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': apiKey },
    signal: AbortSignal.timeout(5000),
  });
}

async function resolveKitFormId(apiKey: string, kv: KVLike, formName: string): Promise<string> {
  const wanted = formName.trim().toLowerCase();
  const cacheKey = `kit:form_id:${wanted}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  const res = await kitFetch('/forms', apiKey);
  if (!res.ok) throw new Error(`Kit GET /forms responded ${res.status}`);
  const data = (await res.json()) as { forms?: Array<{ id: number | string; name?: string }> };
  const forms = data.forms ?? [];
  const match =
    forms.find((f) => (f.name ?? '').trim().toLowerCase() === wanted) ??
    (forms.length === 1 ? forms[0] : undefined);
  if (!match) {
    const names = forms.map((f) => `"${f.name ?? '?'}"`).join(', ');
    throw new Error(`Kit form "${formName}" not found among ${forms.length} forms (${names})`);
  }

  const id = String(match.id);
  await kv.put(cacheKey, id, { expirationTtl: 86400 });
  return id;
}

export async function forwardToKit(email: string, apiKey: string, kv: KVLike, formName: string): Promise<void> {
  const formId = await resolveKitFormId(apiKey, kv, formName);
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

/** The configured form name, read from bindings with a safe default. */
export function kitFormNameFrom(bindings: Record<string, unknown>): string {
  const v = bindings.KIT_FORM_NAME;
  return typeof v === 'string' && v.trim() !== '' ? v : DEFAULT_KIT_FORM_NAME;
}
