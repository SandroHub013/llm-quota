import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "../credentials.js";
import type { Provider, ProviderContext, QuotaMetric, QuotaResult } from "./types.js";
import { fetchBytes, nowIso } from "./util.js";

const CONSOLE = "https://grok.com/?_s=usage";
const CONSUMER_QUOTA_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const EMPTY_GRPC_REQUEST = Uint8Array.from([0, 0, 0, 0, 0]);
const RESPONSE_LIMIT = 64 * 1024;

const PRODUCT_NAMES: Record<number, string> = {
  1: "API",
  2: "Grok Build",
  3: "Grok Plugins",
  4: "Chat",
  5: "Imagine",
  6: "Voice",
};

type GrokAuth = { key: string; email?: string };

type VarintField = { field: number; wire: 0; value: bigint };
type BytesField = { field: number; wire: 1 | 2 | 5; value: Uint8Array };
type ProtoField = VarintField | BytesField;

export const grok: Provider = {
  id: "grok",
  name: "Grok Build",
  consoleUrl: CONSOLE,
  fetch: (ctx) => fetchGrokQuota(ctx),
};

export async function fetchGrokQuota(
  _ctx: ProviderContext = {},
  home = homedir(),
): Promise<QuotaResult> {
  const base: QuotaResult = {
    id: "grok",
    name: "Grok Build",
    status: "unauthenticated",
    consoleUrl: CONSOLE,
    sourceKind: "official_client",
    sourceLabel: "Grok Build credits",
    metrics: [],
    updatedAt: nowIso(),
  };

  const auth = await readGrokAuth(home);
  if (!auth) {
    return {
      ...base,
      message: "Run `grok login` so ~/.grok/auth.json holds a session, then reload.",
    };
  }

  const response = await fetchBytes(CONSUMER_QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.key}`,
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
    },
    body: EMPTY_GRPC_REQUEST,
  });

  if (response.status === 401 || response.status === 403) {
    return { ...base, message: "Grok session expired. Run `grok login` and reload." };
  }
  if (response.status === 429) {
    return { ...base, status: "rate_limited", message: "Grok credits endpoint rate limited. Retry shortly." };
  }
  if (!response.ok) {
    return {
      ...base,
      status: "error",
      message: `Grok credits endpoint unavailable (${response.status || "no response"}).`,
    };
  }

  try {
    const metrics = parseGrokCredits(decodeGrpcWeb(response.bytes));
    if (!metrics.length) {
      return { ...base, status: "partial", authSource: "Grok CLI session", message: "Grok returned no credit windows." };
    }
    const exhausted = metrics.some((metric) => (metric.remaining ?? 1) <= 0 || (metric.used ?? 0) >= 100);
    return {
      ...base,
      status: exhausted ? "rate_limited" : "ok",
      plan: auth.email,
      authSource: "Grok CLI session",
      sourceUpdatedAt: nowIso(),
      metrics,
      message: exhausted ? "Grok reports an exhausted credit window." : undefined,
    };
  } catch {
    return { ...base, status: "error", message: "Grok credits response was not readable." };
  }
}

export async function readGrokAuth(home = homedir()): Promise<GrokAuth | undefined> {
  const path =
    process.env.GROK_AUTH_JSON ||
    process.env.GROK_AUTH_PATH ||
    join(process.env.GROK_HOME || join(home, ".grok"), "auth.json");
  const data = await readJson<Record<string, unknown>>(path);
  if (!data || typeof data !== "object") return undefined;
  return pickGrokKey(data);
}

function pickGrokKey(data: Record<string, unknown>): GrokAuth | undefined {
  const direct = credentialFrom(data);
  if (direct) return direct;
  for (const [scope, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    const found = credentialFrom(value as Record<string, unknown>, scope);
    if (found) return found;
  }
  return undefined;
}

function credentialFrom(item: Record<string, unknown>, scope?: string): GrokAuth | undefined {
  const key = typeof item.key === "string" && item.key ? item.key : undefined;
  if (!key) return undefined;
  const lowered = `${scope ?? ""} ${String(item.type ?? "")} ${String(item.kind ?? "")}`.toLowerCase();
  if (lowered.includes("api-key") || lowered.includes("api_key") || lowered.includes("api.x.ai")) return undefined;
  return { key, email: typeof item.email === "string" ? item.email : undefined };
}

export function parseGrokCredits(payload: Uint8Array): QuotaMetric[] {
  const config = firstMessage(scanMessage(payload), 1);
  if (!config) return [];

  const period = firstMessage(config, 8);
  const periodType = varintAt(period, 1);
  const resetsAt = timestampAt(period, 3);
  const metrics: QuotaMetric[] = [];

  const shared = floatAt(config, 1);
  if (shared != null || periodType === 1n || periodType === 2n) {
    metrics.push(percentMetric("Credits", shared ?? 0, resetsAt));
  }

  for (const product of messagesAt(config, 7)) {
    const fields = scanMessage(product);
    const used = floatAt(fields, 2);
    if (used == null) continue;
    const id = Number(varintAt(fields, 1) ?? 0n);
    metrics.push(percentMetric(PRODUCT_NAMES[id] ?? `Product ${id}`, used, resetsAt));
  }

  const prepaid = firstMessage(config, 12);
  const remaining = Number(varintAt(prepaid, 1) ?? -1n);
  if (Number.isSafeInteger(remaining) && remaining >= 0) {
    metrics.push({ label: "Prepaid", remaining, unit: "credits", resetAt: resetsAt });
  }
  return metrics;
}

function percentMetric(label: string, used: number, resetAt?: string): QuotaMetric {
  const clamped = Math.min(100, Math.max(0, used));
  return {
    label,
    used: clamped,
    limit: 100,
    remaining: 100 - clamped,
    unit: "percent",
    resetAt,
  };
}

function decodeGrpcWeb(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) throw new Error("empty");
  if (bytes[0] !== 0 && bytes[0] !== 0x80) return bytes;
  const frames: Uint8Array[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) throw new Error("truncated");
    const flags = bytes[index]!;
    const length = new DataView(bytes.buffer, bytes.byteOffset + index + 1, 4).getUint32(0);
    const start = index + 5;
    const end = start + length;
    if (end > bytes.length || length > RESPONSE_LIMIT) throw new Error("frame");
    if (flags === 0) frames.push(bytes.slice(start, end));
    index = end;
  }
  if (frames.length !== 1) throw new Error("frames");
  return frames[0]!;
}

function scanMessage(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    index = key.index;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const scalar = readVarint(bytes, index);
      fields.push({ field, wire, value: scalar.value });
      index = scalar.index;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      fields.push({ field, wire, value: bytes.slice(index, index + length) });
      index += length;
    } else if (wire === 2) {
      const length = readVarint(bytes, index);
      index = length.index;
      const end = index + Number(length.value);
      fields.push({ field, wire, value: bytes.slice(index, end) });
      index = end;
    } else {
      throw new Error("wire");
    }
  }
  return fields;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; index: number } {
  let value = 0n;
  let index = start;
  for (let shift = 0; shift < 70 && index < bytes.length; shift += 7) {
    const byte = bytes[index++]!;
    value |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) return { value, index };
  }
  throw new Error("varint");
}

function messagesAt(fields: ProtoField[] | undefined, field: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const entry of fields ?? []) {
    if (entry.wire === 2 && entry.field === field) out.push(entry.value);
  }
  return out;
}

function firstMessage(fields: ProtoField[] | undefined, field: number): ProtoField[] | undefined {
  const bytes = messagesAt(fields, field)[0];
  return bytes ? scanMessage(bytes) : undefined;
}

function varintAt(fields: ProtoField[] | undefined, field: number): bigint | undefined {
  for (const entry of fields ?? []) {
    if (entry.wire === 0 && entry.field === field) return entry.value;
  }
  return undefined;
}

function floatAt(fields: ProtoField[] | undefined, field: number): number | undefined {
  for (const entry of fields ?? []) {
    if (entry.wire === 5 && entry.field === field) {
      return new DataView(entry.value.buffer, entry.value.byteOffset, 4).getFloat32(0, true);
    }
  }
  return undefined;
}

function timestampAt(fields: ProtoField[] | undefined, field: number): string | undefined {
  const seconds = Number(varintAt(firstMessage(fields, field), 1) ?? -1n);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
