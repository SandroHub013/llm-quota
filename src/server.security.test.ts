import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_SOURCE_IDS } from "./usage.js";
import { paths } from "./credentials.js";
import { app, internalError, setServerTokenForTests } from "./server.js";

const at = (url: string, init?: RequestInit) => app.request(url, init);

// Pin the inter-process token so authorized requests need no real credential
// directory; the middleware accepts it exactly like the persisted one.
const TEST_TOKEN = "0123456789abcdef".repeat(4);
setServerTokenForTests(TEST_TOKEN);
const AUTHORIZED = { "X-LLM-Quota-Token": TEST_TOKEN };

// The server binds to loopback, which stops other machines but not other pages on this
// one. A site whose name is re-resolved to 127.0.0.1 becomes same-origin with it and
// could otherwise read the plan and local spend history straight out of the API.
test("a rebound hostname cannot reach the API", async () => {
  const response = await at("http://quota.evil.example/api/quota");
  expect(response.status).toBe(403);
});

test("loopback hostnames still pass, with and without a port", async () => {
  for (const origin of ["http://localhost:4747", "http://127.0.0.1:4747", "http://localhost"]) {
    const response = await at(`${origin}/api/providers`);
    expect(response.status).toBe(200);
  }
});

// POST /api/official-bridge/:id needs no body and no custom header, so a browser sends
// it cross-origin with no preflight. The response stays unreadable to the caller, but
// the side effect — a status-line script written, the official client's settings
// rewritten — would already have landed.
test("a cross-origin write is refused before it reaches a handler", async () => {
  for (const method of ["POST", "DELETE"]) {
    const response = await at("http://localhost:4747/api/official-bridge/claude", {
      method,
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross-origin request refused" });
  }
});

// A non-JSON body makes the handler fall back to `key: undefined`, which deletes the
// stored key. That must not be reachable from another origin either.
test("a cross-origin key deletion is refused", async () => {
  const response = await at("http://localhost:4747/api/key/claude", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
    body: "not json",
  });
  expect(response.status).toBe(403);
});

// A stored usage view decides what figure the widget and the dashboard headline
// show, so a cross-origin page must not be able to rewrite it either.
test("a cross-origin usage-view write is refused", async () => {
  const response = await at("http://localhost:4747/api/usage-view", {
    method: "PUT",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: '{"source":"claude","agent":"main"}',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "cross-origin request refused" });
});

// Same-origin read of the shared view always yields a valid shape, whether or
// not the local config already stores one.
test("the usage view endpoint always answers with a normalized view", async () => {
  const response = await at("http://localhost:4747/api/usage-view");
  expect(response.status).toBe(200);
  const view = (await response.json()) as { source: string; agent: string };
  expect(["all", ...USAGE_SOURCE_IDS]).toContain(view.source);
  expect(["all", "main", "subagent"]).toContain(view.agent);
});

test("a non-JSON usage-view body is rejected without touching the config", async () => {
  const response = await at("http://localhost:4747/api/usage-view", {
    method: "PUT",
    headers: { "Content-Type": "text/plain", ...AUTHORIZED },
    body: "not json",
  });
  expect(response.status).toBe(400);
});

test("malformed key bodies are rejected instead of deleting a credential", async () => {
  for (const body of ["not json", "{}", '{"key":null}']) {
    const response = await at("http://localhost:4747/api/key/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTHORIZED },
      body,
    });
    expect(response.status).toBe(400);
  }
});

test("the dashboard's own origin is still allowed to write", async () => {
  const response = await at("http://localhost:4747/api/official-bridge/nope", {
    method: "POST",
    headers: { Origin: "http://localhost:4747", ...AUTHORIZED },
  });
  // Rejected as an unknown bridge by the handler, not blocked by the origin guard.
  expect(response.status).toBe(404);
});

test("same-origin requests that send no Origin header keep working", async () => {
  const response = await at("http://localhost:4747/api/key/unknown-provider", {
    method: "POST",
    headers: AUTHORIZED,
  });
  expect(response.status).toBe(404);
});

// The README calls this a loopback-only backend, and the Host guard above only holds
// while the app is served by its own Bun entry point. A serverless adapter re-exporting
// `app` would publish /api/usage and /api/key to the open internet — which is exactly
// what api/index.ts plus vercel.json did before they were removed.
test("no serverless adapter re-exports the local app", async () => {
  for (const path of ["api/index.ts", "api/index.js", "vercel.json", "netlify.toml"]) {
    expect(await Bun.file(path).exists()).toBe(false);
  }

  const server = await Bun.file("src/server.ts").text();
  expect(server).toContain('hostname: "127.0.0.1"');
});

// The Origin guard cannot see non-browser processes — they simply omit the header —
// so writes also require the token from the 0600 file next to the credentials.
test("a non-GET /api call without the token is unauthorized", async () => {
  const response = await at("http://localhost:4747/api/usage-view", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"source":"claude","agent":"main"}',
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("a non-GET /api call with a wrong token is unauthorized", async () => {
  const response = await at("http://localhost:4747/api/key/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-LLM-Quota-Token": "f".repeat(64) },
    body: '{"key":"sk-test"}',
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("an authorized non-GET /api call reaches the handler", async () => {
  // Redirect the write to a throwaway config: the real one belongs to the user.
  const original = paths.config;
  paths.config = join(await mkdtemp(join(tmpdir(), "llm-quota-test-")), "config.json");
  try {
    const response = await at("http://localhost:4747/api/usage-view", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...AUTHORIZED },
      body: '{"source":"claude","agent":"main"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "claude", agent: "main" });
  } finally {
    paths.config = original;
  }
});

test("GET endpoints stay open to local readers without the token", async () => {
  const response = await at("http://localhost:4747/api/providers");
  expect(response.status).toBe(200);
});

// Internal error strings can carry absolute paths or settings fragments, and the
// client is any local process — so only the server log may see the detail.
test("internal errors are logged server-side, not leaked to the client", async () => {
  const secret = join(tmpdir(), "llm-quota-secret-path", "settings.json");
  const mini = new Hono();
  mini.get("/boom", (context) => internalError(context, new Error(`invalid_settings_json: ${secret}`)));
  const response = await mini.request("http://localhost/boom");
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: "internal error" });
  expect(body).not.toContain(secret);
});

test("the dashboard HTML ships a CSP, nosniff, and the injected token", async () => {
  const response = await at("http://localhost:4747/");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const html = await response.text();
  expect(html).not.toContain("__LLM_QUOTA_TOKEN__");
  expect(html).toContain(`<meta name="llm-quota-token" content="${TEST_TOKEN}" />`);
});
