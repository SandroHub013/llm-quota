import { Hono } from "hono";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getProvider, providers } from "./providers/index.js";
import type { QuotaResult } from "./providers/types.js";
import { readConfig, writeConfig } from "./credentials.js";
import { installOfficialBridge, removeOfficialBridge, type OfficialBridgeProvider } from "./official-bridge.js";
import { collectUsage } from "./usage.js";
import { collectGitHubContributions } from "./github-contributions.prototype.js";

const app = new Hono();
const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

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
  return context.json(await usageRequest, 200, { "Cache-Control": "no-store" });
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
  const { key } = await context.req.json<{ key?: string }>().catch(() => ({ key: undefined }));
  const config = await readConfig();
  if (key?.trim()) config.keys[id] = key.trim();
  else delete config.keys[id];
  await writeConfig(config);
  quotaCache = undefined;
  return context.json(await fetchOne(id));
});

// Explicit opt-in: official clients pipe their documented status JSON into a local
// wrapper. Existing custom status-line commands are chained and kept visible.
app.post("/api/official-bridge/:id", async (context) => {
  const id = context.req.param("id");
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

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

app.get("/", async (context) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  return context.html(html);
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
