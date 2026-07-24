/** fetch with a timeout; never throws on timeout — returns a rejected-safe wrapper. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12000,
): Promise<{ ok: boolean; status: number; body: any; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch (e: any) {
    return { ok: false, status: 0, body: undefined, text: String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
