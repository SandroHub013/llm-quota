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

/**
 * Same contract as `fetchJson`, for bodies that are not JSON — Grok Build answers
 * quota as gRPC-web protobuf. Status 0 means nothing came back; the adapter must
 * not throw.
 */
export async function fetchBytes(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; bytes: Uint8Array; headers: Headers }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { ok: res.ok, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  } catch {
    return { ok: false, status: 0, bytes: new Uint8Array(), headers: new Headers() };
  } finally {
    clearTimeout(t);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The status a card takes while its official bridge is live.
 *
 * Exhausted outranks stale: a window at 100% is the more urgent of the two, and it is
 * also the one that repairs itself, so it must not be hidden behind an age warning.
 */
export function bridgeStatus(exhausted: boolean, stale: boolean): "rate_limited" | "partial" | "ok" {
  if (exhausted) return "rate_limited";
  return stale ? "partial" : "ok";
}

/** A snapshot field a bridge writes only sometimes, and only sometimes as a string. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
