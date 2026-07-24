import type { QuotaResult } from "../src/providers/types.js";

type RequestFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function requestJson<T = unknown>(path: string, options?: RequestInit, request?: RequestFn): Promise<T>;
export function loadQuota(request?: RequestFn): Promise<QuotaResult[]>;
export function loadProvider(id: string, request?: RequestFn): Promise<QuotaResult>;
export function saveProviderKey(id: string, key: string, request?: RequestFn): Promise<QuotaResult>;
export function beginLogin<T = Record<string, unknown>>(path: string, request?: RequestFn): Promise<T>;
