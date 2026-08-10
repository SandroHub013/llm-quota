import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getProvider, providers } from "./providers/index.js";
import type { QuotaResult } from "./providers/types.js";
import { readConfig, updateConfig } from "./credentials.js";
import { installOfficialBridge, removeOfficialBridge, type OfficialBridgeProvider } from "./official-bridge.js";
import { loadServerToken } from "./server-token.js";
import { collectUsage } from "./usage.js";
import { normalizeUsageView, usageFiltersActive, usageHeadlineCosts } from "./usage-view.js";
import { collectGitHubContributions } from "./github-contributions.prototype.js";

const app = new Hono();
const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

let testToken: string | undefined;
let tokenPromise: Promise<string> | undefined;

/** Tests pin the token so authorized requests need no real credential directory. */
export function setServerTokenForTests(token: string): void {
  testToken = token;
}

function serverToken(): Promise<string> {
  if (testToken) return Promise.resolve(testToken);
  tokenPromise ??= loadServerToken();
  return tokenPromise;
}

/**
 * A local API client is still any process on this machine, so internal error
 * details (absolute paths, settings fragments) stay in the server log and the
 * client only gets a generic message.
 */
export function internalError(context: Context, error: unknown): Response {
  console.error("[llm-quota] internal error:", error);
  return context.json({ error: "internal error" }, 500);
}

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
  context.header("X-Content-Type-Options", "nosniff");

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
        return false;
      }
    })();
    if (!allowed) return context.json({ error: "cross-origin request refused" }, 403);
  }

  // Non-GET /api calls mutate local state (provider keys, official-client settings),
  // and a non-browser process just omits Origin, which the check above treats as
  // same-origin. The token — shared through a 0600 file only this user's processes
  // can read — is what authenticates them. GETs stay open: they expose quota data
  // the local user already owns, and the widget polls them without a pairing step.
  if (
    context.req.method !== "GET" && context.req.method !== "HEAD" &&
    context.req.path.startsWith("/api/")
  ) {
    const presented = Buffer.from(context.req.header("x-llm-quota-token") ?? "");
    const expected = Buffer.from(await serverToken());
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return context.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

async function fetchOne(id: string): Promise<QuotaResult> {
  const provider = getProvider(id)!;
  const config = await readConfig();
  try {
    return await provider.fetch({ userKey: config.keys[id] });
  } catch (error: any) {
    // The card only needs to show failure; the underlying error can carry absolute
    // paths or provider-response fragments, so the detail stays in the server log.
    console.error(`[llm-quota] quota fetch failed for ${provider.id}:`, error);
    return {
      id: provider.id,
      name: provider.name,
      status: "error",
      consoleUrl: provider.consoleUrl,
      metrics: [],
      message: "Internal error",
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
  await updateConfig((config) => ({ ...config, usageView: view }));
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
  await updateConfig((config) => {
    const next = { ...config, keys: { ...config.keys } };
    if (key) next.keys[id] = key;
    else delete next.keys[id];
    return next;
  });
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
    return internalError(context, error);
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
    return internalError(context, error);
  }
});

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

// The served page carries the inter-process token in a meta tag so its own writes
// back to this server authenticate; the CSP keeps an injected payload from reading
// it out to anywhere but this origin. The dashboard uses inline styles only, so
// style-src keeps 'unsafe-inline' while scripts stay strictly self-hosted.
app.get("/", async (context) => {
  const html = (await readFile(join(PUBLIC, "index.html"), "utf8"))
    .replace("__LLM_QUOTA_TOKEN__", await serverToken());
  return context.html(html, 200, {
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
});

app.get("/:a{.+}", async (context) => {
  const relative = context.req.path.slice(1);
  const extension = relative.slice(relative.lastIndexOf("."));
  const type = MIME[extension];
  if (!type) return context.notFound();

  const file = resolve(PUBLIC, relative);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return context.notFound();
  const body = await readFile(file).catch(() => null);
  if (!body) return context.notFound();

  const cache = extension === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache";
  return context.body(body, 200, { "Content-Type": type, "Cache-Control": cache });
});

const port = Number(process.env.PORT ?? 4747);
console.log(`\n  LLM Quota → http://localhost:${port}\n`);

export { app };
export default { hostname: "127.0.0.1", port, idleTimeout: 255, fetch: app.fetch };
