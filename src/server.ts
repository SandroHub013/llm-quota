import { Hono, type Context } from "hono";
import { getProvider, providers } from "./providers/index.js";
import { PUBLIC_ASSETS } from "./public-assets.generated.js";
import { INDEX, mimeFor } from "./public-mime.js";
import type { QuotaResult } from "./providers/types.js";
import { JsonFileUnreadableError, readConfig, updateConfig } from "./credentials.js";
import { installOfficialBridge, removeOfficialBridge, type OfficialBridgeProvider } from "./official-bridge.js";
import { collectUsage } from "./usage.js";
import { normalizeUsageView, usageFiltersActive, usageHeadlineCosts } from "./usage-view.js";
import { collectGitHubContributions } from "./github-contributions.prototype.js";

const app = new Hono();

/**
 * The server binds to loopback, which stops other machines but not other pages on
 * this one. Two gaps stay open without an explicit check:
 *
 *   - DNS rebinding. A site whose name is re-resolved to 127.0.0.1 becomes
 *     same-origin with this server and can then read /api/quota and /api/usage,
 *     which carry the plan and local spend history. Pinning Host closes it.
 *   - CSRF. POST /api/official-bridge/:id needs no body and no custom header, so
 *     it is a "simple request": the browser sends it cross-origin with no preflight
 *     and the side effect lands — a status-line script written and the official
 *     client's settings rewritten. The response is unreadable; the write is not
 *     undone by that. Credential writes additionally reject malformed JSON bodies.
 *
 * Same-origin browser requests either omit Origin or send this server's own.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostAllowed(host: string): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

app.use("*", async (context, next) => {
  // Bun builds request.url from the Host header, so the two agree over real HTTP; the
  // URL is the one that is always populated (HTTP/2 carries :authority instead).
  const host = context.req.header("host") || new URL(context.req.url).host;
  if (!hostAllowed(host)) return context.json({ error: "host not allowed" }, 403);

  const origin = context.req.header("origin");
  if (origin && context.req.method !== "GET" && context.req.method !== "HEAD") {
    const allowed = (() => {
      try {
        return hostAllowed(new URL(origin).host);
      } catch {
        // Deliberate: an Origin this parser rejects is not one of ours, and the
        // safe reading of an unparseable origin on a write is "refuse".
        return false;
      }
    })();
    if (!allowed) return context.json({ error: "cross-origin request refused" }, 403);
  }
  await next();
});

/**
 * A config file that exists but cannot be parsed stops every write: overwriting it
 * would silently drop the API keys it still holds. 409 rather than 500 — nothing is
 * broken here, the request simply conflicts with what is on disk, and only the user
 * can decide whether to repair the file or delete it.
 *
 * Returns undefined for anything else, so an unrelated failure keeps propagating
 * instead of being relabelled as a config problem.
 */
export function configConflictBody(error: unknown): { error: string; detail: string } | undefined {
  if (!(error instanceof JsonFileUnreadableError)) return undefined;
  return {
    error: "config unreadable",
    detail: `${error.path} exists but is not valid JSON. Repair or delete it; the stored keys were left untouched.`,
  };
}

function configConflict(context: Context, error: unknown): Response | undefined {
  const body = configConflictBody(error);
  return body ? context.json(body, 409) : undefined;
}

async function fetchOne(id: string): Promise<QuotaResult> {
  const provider = getProvider(id)!;
  const config = await readConfig();
  try {
    return await provider.fetch({ userKey: config.keys[id] });
  } catch (error: any) {
    return {
      id: provider.id,
      name: provider.name,
      status: "error",
      consoleUrl: provider.consoleUrl,
      metrics: [],
      message: `Internal error: ${String(error?.message ?? error)}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

app.get("/api/providers", (context) => context.json(providers.map((provider) => ({
  id: provider.id,
  name: provider.name,
}))));

// Concurrent visible tabs share one official-source refresh.
const QUOTA_CACHE_MS = 55_000;
let quotaRequest: Promise<QuotaResult[]> | undefined;
let quotaCache: { expiresAt: number; results: QuotaResult[] } | undefined;
app.get("/api/quota", async (context) => {
  const cached = quotaCache && quotaCache.expiresAt > Date.now() ? quotaCache.results : undefined;
  if (!cached) {
    quotaRequest ??= Promise.all(providers.map((provider) => fetchOne(provider.id))).then((results) => {
      quotaCache = { results, expiresAt: Date.now() + QUOTA_CACHE_MS };
      return results;
    }).finally(() => {
      quotaRequest = undefined;
    });
  }
  return context.json(
    { providers: cached ?? await quotaRequest!, generatedAt: new Date().toISOString() },
    200,
    { "Cache-Control": "no-store" },
  );
});

// Token detail remains local: no provider credential or transcript reaches the browser.
let usageRequest: Promise<Awaited<ReturnType<typeof collectUsage>>> | undefined;
app.get("/api/usage", async (context) => {
  usageRequest ??= collectUsage().finally(() => { usageRequest = undefined; });
  const summary = await usageRequest;
  const view = normalizeUsageView((await readConfig()).usageView);
  const headline = usageHeadlineCosts(summary, view);
  return context.json(
    {
      ...summary,
      usageView: view,
      usageFiltered: usageFiltersActive(view),
      headlineCostEur: headline.eur,
      headlineCostUsd: headline.usd,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

// The usage view is shared state: the widget has no filter UI of its own, so it
// follows whatever the dashboard last stored here.
app.get("/api/usage-view", async (context) => {
  const view = normalizeUsageView((await readConfig()).usageView);
  return context.json(view, 200, { "Cache-Control": "no-store" });
});

app.put("/api/usage-view", async (context) => {
  const body = await context.req.json<Record<string, unknown>>().catch(() => undefined);
  if (body == null || typeof body !== "object") return context.json({ error: "invalid view" }, 400);
  const view = normalizeUsageView(body);
  try {
    await updateConfig((config) => ({ ...config, usageView: view }));
  } catch (error) {
    const conflict = configConflict(context, error);
    if (conflict) return conflict;
    throw error;
  }
  return context.json(view, 200, { "Cache-Control": "no-store" });
});

app.get("/api/prototype/github-contributions", async (context) => {
  return context.json(await collectGitHubContributions(), 200, { "Cache-Control": "no-store" });
});

app.get("/api/quota/:id", async (context) => {
  const id = context.req.param("id");
  if (!getProvider(id)) return context.json({ error: "unknown provider" }, 404);
  return context.json(await fetchOne(id), 200, { "Cache-Control": "no-store" });
});

// Keys stored here are explicitly supplied by the user for documented provider APIs.
app.post("/api/key/:id", async (context) => {
  const id = context.req.param("id");
  if (!getProvider(id)) return context.json({ error: "unknown provider" }, 404);
  const body = await context.req.json<unknown>().catch(() => undefined);
  if (
    body == null || typeof body !== "object" || Array.isArray(body) ||
    !Object.hasOwn(body, "key") || typeof (body as { key?: unknown }).key !== "string"
  ) {
    return context.json({ error: "invalid key" }, 400);
  }
  const key = (body as { key: string }).key.trim();
  try {
    await updateConfig((config) => {
      const next = { ...config, keys: { ...config.keys } };
      if (key) next.keys[id] = key;
      else delete next.keys[id];
      return next;
    });
  } catch (error) {
    const conflict = configConflict(context, error);
    if (conflict) return conflict;
    throw error;
  }
  quotaCache = undefined;
  return context.json(await fetchOne(id));
});

// Explicit opt-in: official clients pipe their documented status JSON into a local
// wrapper. Existing custom status-line commands are chained and kept visible.
app.post("/api/official-bridge/:id", async (context) => {
  const id = context.req.param("id");
  // Z.ai is absent on purpose: its adapter is unregistered, so fetchOne has no
  // provider to report with. See src/providers/index.ts.
  if (id !== "claude" && id !== "gemini") {
    return context.json({ error: "unsupported bridge" }, 404);
  }
  try {
    await installOfficialBridge(id as OfficialBridgeProvider);
    quotaCache = undefined;
    return context.json(await fetchOne(id), 200, { "Cache-Control": "no-store" });
  } catch (error: any) {
    return context.json({ error: String(error?.message ?? error) }, 500);
  }
});

app.delete("/api/official-bridge/:id", async (context) => {
  const id = context.req.param("id");
  // Z.ai is absent on purpose: its adapter is unregistered, so fetchOne has no
  // provider to report with. See src/providers/index.ts.
  if (id !== "claude" && id !== "gemini") {
    return context.json({ error: "unsupported bridge" }, 404);
  }
  try {
    await removeOfficialBridge(id as OfficialBridgeProvider);
    quotaCache = undefined;
    return context.json(await fetchOne(id), 200, { "Cache-Control": "no-store" });
  } catch (error: any) {
    return context.json({ error: String(error?.message ?? error) }, 500);
  }
});

app.get("/", async (context) => {
  return context.html(await Bun.file(PUBLIC_ASSETS[INDEX]!).text());
});

app.get("/:a{.+}", async (context) => {
  const relative = context.req.path.slice(1);
  const type = mimeFor(relative);
  // The manifest is generated from public/, so a name that is not a key was never
  // shipped — which is also why no traversal guard is needed here any more. Nothing
  // in this route touches a caller-supplied path.
  const asset = PUBLIC_ASSETS[relative];
  if (!type || !asset) return context.notFound();

  // Deliberate: any read failure is a 404 to the browser. Reporting which one would
  // describe the server's own layout to the page.
  const body = await Bun.file(asset).bytes().catch(() => null);
  if (!body) return context.notFound();

  const cache = relative.endsWith(".woff2") ? "public, max-age=31536000, immutable" : "no-cache";
  return context.body(body, 200, { "Content-Type": type, "Cache-Control": cache });
});

const port = Number(process.env.PORT ?? 4747);
console.log(`\n  LLM Quota → http://localhost:${port}\n`);

export { app };
export default { hostname: "127.0.0.1", port, idleTimeout: 255, fetch: app.fetch };
