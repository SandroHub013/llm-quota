/**
 * fetch with a timeout; never throws on timeout — returns a rejected-safe wrapper.
 *
 * `T` is what the caller expects the provider to answer with, and it is a claim rather
 * than a check: nothing here validates it. Naming the shape at the call site is still
 * worth more than `any`, because the fields a caller reads then have to exist somewhere
 * a reader can find them.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12000,
): Promise<{ ok: boolean; status: number; body: T | undefined; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: T | undefined;
    try {
      body = JSON.parse(text) as T;
    } catch {
      // Deliberate: provider errors routinely arrive as an HTML page or a plain
      // string. `text` is returned alongside, so a caller that wants the reason
      // still has it verbatim — nothing is actually lost here.
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch (e) {
    return { ok: false, status: 0, body: undefined, text: String((e as Error | undefined)?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
