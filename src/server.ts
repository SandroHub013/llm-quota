import { Hono } from "hono";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getProvider, providers } from "./providers/index.js";
import type { QuotaResult } from "./providers/types.js";
import { readConfig, writeConfig, writeGeminiOauth } from "./credentials.js";
import { GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, GEMINI_REDIRECT, GEMINI_SCOPES, GEMINI_TOKEN_URL } from "./gemini-oauth.js";
import { collectUsage } from "./usage.js";
import { collectGitHubContributions } from "./github-contributions.prototype.js";

const app = new Hono();
const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function fetchOne(id: string): Promise<QuotaResult> {
  const p = getProvider(id)!;
  const cfg = await readConfig();
  try {
    return await p.fetch({ userKey: cfg.keys[id] });
  } catch (e: any) {
    return {
      id: p.id,
      name: p.name,
      status: "error",
      consoleUrl: p.consoleUrl,
      metrics: [],
      message: `Internal error: ${String(e?.message ?? e)}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

// Provider id list (cards load one by one so a slow provider never blocks the rest).
app.get("/api/providers", (c) => c.json(providers.map((p) => ({ id: p.id, name: p.name }))));

// All providers at once.
app.get("/api/quota", async (c) => {
  const results = await Promise.all(providers.map((p) => fetchOne(p.id)));
  return c.json({ providers: results, generatedAt: new Date().toISOString() });
});

// Local CLI histories expose token detail that quota endpoints do not. Compute this
// lazily: the first dashboard visit scans the histories, then per-file metadata keeps
// subsequent requests cheap. Concurrent tabs share the same in-flight scan.
let usageRequest: Promise<Awaited<ReturnType<typeof collectUsage>>> | undefined;
app.get("/api/usage", async (c) => {
  usageRequest ??= collectUsage().finally(() => { usageRequest = undefined; });
  return c.json(await usageRequest, 200, { "Cache-Control": "no-store" });
});

// PROTOTYPE: read the authenticated viewer's one-year contribution calendar through
// the official GitHub CLI. No token reaches this process or the browser.
app.get("/api/prototype/github-contributions", async (c) => {
  return c.json(await collectGitHubContributions(), 200, { "Cache-Control": "no-store" });
});

// Single provider (used by per-card refresh).
app.get("/api/quota/:id", async (c) => {
  const id = c.req.param("id");
  if (!getProvider(id)) return c.json({ error: "unknown provider" }, 404);
  return c.json(await fetchOne(id));
});

// Save / clear a user API key for a provider.
app.post("/api/key/:id", async (c) => {
  const id = c.req.param("id");
  if (!getProvider(id)) return c.json({ error: "unknown provider" }, 404);
  const { key } = await c.req.json<{ key?: string }>().catch(() => ({ key: undefined }));
  const cfg = await readConfig();
  if (key && key.trim()) cfg.keys[id] = key.trim();
  else delete cfg.keys[id];
  await writeConfig(cfg);
  return c.json(await fetchOne(id));
});

// --- Gemini OAuth loopback flow ---
// The antigravity client only allows redirect_uri=http://localhost:51121/oauth-callback,
// so during login we spin a throwaway listener on port 51121, catch the code,
// exchange it (with PKCE), write ~/.gemini/oauth_creds.json and shut down.
let loginServer: { stop: (closeActiveConnections?: boolean) => void } | null = null;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function exchangeGeminiCode(code: string, verifier: string) {
  const res = await fetch(GEMINI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: GEMINI_REDIRECT,
      code_verifier: verifier,
    }),
  });
  const body: any = await res.json().catch(() => undefined);
  if (!res.ok || !body?.access_token) {
    console.error("gemini login exchange failed:", body?.error ?? `http_${res.status}`);
    return;
  }
  await writeGeminiOauth({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: body.id_token,
    scope: body.scope,
    token_type: body.token_type,
    expiry_date: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  });
  console.log("gemini login: credentials saved to ~/.gemini/oauth_creds.json");
}

app.get("/api/auth/gemini", async (c) => {
  // The loopback listener needs Bun locally: on serverless there is no user localhost.
  if (typeof Bun === "undefined") {
    return c.json({ error: "OAuth login is only available on the local instance (localhost:4747)." }, 501);
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  loginServer?.stop(true);
  const srv = Bun.serve({
    port: 51121,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/oauth-callback") return new Response("not found", { status: 404 });
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      setTimeout(() => srv.stop(true), 1000);
      if (code) exchangeGeminiCode(code, verifier);
      else console.error("gemini login denied:", err ?? "no code");
      const msg = code ? "Login received — you can close this tab." : `Login failed: ${err ?? "no code"}`;
      return new Response(`<h1 style="font-family:sans-serif">${msg}</h1>`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  loginServer = srv;
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GEMINI_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(GEMINI_REDIRECT)}&response_type=code` +
    `&scope=${encodeURIComponent(GEMINI_SCOPES.join(" "))}` +
    `&access_type=offline&prompt=consent` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  return c.json({ url });
});

// Static frontend. Everything the dashboard needs is served from ./public — no CDN,
// so the page makes zero third-party requests.
const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

app.get("/", async (c) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  return c.html(html);
});

// Single static route. `resolve` + prefix check keeps `..` from escaping ./public,
// and only the extensions above are ever served.
app.get("/:a{.+}", async (c) => {
  const rel = c.req.path.slice(1);
  const ext = rel.slice(rel.lastIndexOf("."));
  const type = MIME[ext];
  if (!type) return c.notFound();

  const file = resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return c.notFound();

  const body = await readFile(file).catch(() => null);
  if (!body) return c.notFound();

  // Fonts never change under their name, so they can be cached hard. Code and images
  // must revalidate — with max-age the browser silently serves a stale bundle after
  // every edit, which is wrong for a dashboard you run from a checkout.
  const cache = ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache";
  return c.body(body, 200, { "Content-Type": type, "Cache-Control": cache });
});

const port = Number(process.env.PORT ?? 4747);
console.log(`\n  LLM Quota → http://localhost:${port}\n`);

export { app };
export default { port, fetch: app.fetch };
