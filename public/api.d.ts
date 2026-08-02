import type { QuotaResult } from "../src/providers/types.js";
import type { UsageSummary } from "../src/usage.js";

type RequestFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function requestJson<T = unknown>(path: string, options?: RequestInit, request?: RequestFn): Promise<T>;
export function loadQuota(request?: RequestFn): Promise<QuotaResult[]>;
export function loadUsage(request?: RequestFn): Promise<UsageSummary>;
export function loadProvider(id: string, request?: RequestFn): Promise<QuotaResult>;
export function saveProviderKey(id: string, key: string, request?: RequestFn): Promise<QuotaResult>;
export function beginLogin<T = Record<string, unknown>>(path: string, request?: RequestFn): Promise<T>;
