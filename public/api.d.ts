import type { QuotaResult } from "../src/providers/types.js";
import type { UsageSummary } from "../src/usage.js";
import type { UsageView } from "../src/usage-view.js";
import type { GitHubContributionsResult } from "../src/github-contributions.prototype.js";

type RequestFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function requestJson<T = unknown>(path: string, options?: RequestInit, request?: RequestFn): Promise<T>;
export function loadQuota(request?: RequestFn): Promise<QuotaResult[]>;
export function loadUsage(request?: RequestFn): Promise<UsageSummary>;
export function loadGitHubContributions(request?: RequestFn): Promise<GitHubContributionsResult>;
export function loadUsageView(request?: RequestFn): Promise<UsageView>;
export function storeUsageView(view: UsageView, request?: RequestFn): Promise<UsageView>;
export function loadProvider(id: string, request?: RequestFn): Promise<QuotaResult>;
export function saveProviderKey(id: string, key: string, request?: RequestFn): Promise<QuotaResult>;
export function installOfficialBridge(id: string, request?: RequestFn): Promise<QuotaResult>;
export function removeOfficialBridge(id: string, request?: RequestFn): Promise<QuotaResult>;
