export type QuotaStatus =
  | "ok" // live data fetched
  | "partial" // some info (e.g. plan / token expiry) but no live usage
  | "unauthenticated" // no credential found; user must log in / add a key
  | "rate_limited" // provider throttled us; retry later
  | "no_endpoint" // provider exposes no readable quota; link to console
  | "error"; // unexpected failure

export interface QuotaMetric {
  label: string; // e.g. "5h window", "Balance", "Requests today"
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: "requests" | "tokens" | "usd" | "cny" | "percent" | "credits";
  resetAt?: string; // ISO timestamp when the window resets
}

export interface QuotaResult {
  id: string;
  name: string;
  status: QuotaStatus;
  plan?: string;
  authSource?: string; // where the credential came from (file / user key)
  metrics: QuotaMetric[];
  message?: string; // human explanation, esp. for non-ok statuses
  consoleUrl?: string; // where to check/top-up manually
  needsKey?: boolean; // frontend should render a key-entry field
  loginUrl?: string; // frontend renders an OAuth login button (top-level navigation)
  raw?: unknown; // raw provider payload for debugging
  updatedAt: string;
}

export interface ProviderContext {
  /** User-entered key for this provider, if any (from ~/.llm-quota/config.json). */
  userKey?: string;
}

export interface Provider {
  id: string;
  name: string;
  consoleUrl: string;
  /** Fetch normalized quota. Must never throw — return a QuotaResult with status "error". */
  fetch(ctx: ProviderContext): Promise<QuotaResult>;
}
