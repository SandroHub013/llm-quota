import { Hono } from "hono";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getProvider, providers } from "./providers/index.js";
import type { QuotaResult } from "./providers/types.js";
import { readConfig, writeConfig, writeGeminiOauth } from "./credentials.js";
import { GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, GEMINI_REDIRECT, GEMINI_SCOPES, GEMINI_TOKEN_URL } from "./gemini-oauth.js";

const app = new Hono();
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

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
      message: `Errore interno: ${String(e?.message ?? e)}`,
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
  console.log("gemini login: credenziali salvate in ~/.gemini/oauth_creds.json");
}

app.get("/api/auth/gemini", async (c) => {
  // Loopback listener richiede Bun in locale: su serverless non esiste localhost dell'utente.
  if (typeof Bun === "undefined") {
    return c.json({ error: "Login OAuth disponibile solo sull'istanza locale (localhost:4747)." }, 501);
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
      else console.error("gemini login negato:", err ?? "nessun codice");
      const msg = code ? "Login ricevuto — puoi chiudere questa scheda." : `Login fallito: ${err ?? "nessun codice"}`;
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

// Static frontend.
app.get("/", async (c) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  return c.html(html);
});
app.get("/app.js", async (c) => {
  const js = await readFile(join(PUBLIC, "app.js"), "utf8");
  return c.body(js, 200, { "Content-Type": "text/javascript" });
});
app.get("/api.js", async (c) => {
  const js = await readFile(join(PUBLIC, "api.js"), "utf8");
  return c.body(js, 200, { "Content-Type": "text/javascript" });
});
app.get("/ui.js", async (c) => {
  const js = await readFile(join(PUBLIC, "ui.js"), "utf8");
  return c.body(js, 200, { "Content-Type": "text/javascript" });
});
app.get("/logo.svg", async (c) => {
  const svg = await readFile(join(PUBLIC, "logo.svg"), "utf8");
  return c.body(svg, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
});

const port = Number(process.env.PORT ?? 4747);
console.log(`\n  LLM Quota → http://localhost:${port}\n`);

export { app };
export default { port, fetch: app.fetch };
