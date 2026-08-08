import { expect, test } from "bun:test";
import { installOfficialBridge, loadProvider, loadQuota, loadUsage, loadUsageView, removeOfficialBridge, requestJson, storeUsageView } from "../public/api.js";

test("dashboard refresh loads every provider with one aggregate request", async () => {
  const urls: string[] = [];
  const request = async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ providers: [{ id: "codex" }, { id: "claude" }] });
  };

  const providers = await loadQuota(request);

  expect(urls).toEqual(["/api/quota"]);
  expect(providers.map((provider) => provider.id)).toEqual(["codex", "claude"]);
});

test("dashboard refresh exposes HTTP failures instead of swallowing them", async () => {
  expect(loadQuota(async () => new Response("fail", { status: 503 }))).rejects.toThrow("http_503");
});

test("usage detail validates the aggregate response", async () => {
  const request = async () => Response.json({
    estimatedCostEur: 12.34,
    tokens: { total: 42 },
    rows: [],
    daily: [],
  });

  expect((await loadUsage(request)).estimatedCostEur).toBe(12.34);
  expect(loadUsage(async () => Response.json({ estimatedCostEur: 1 }))).rejects.toThrow(
    "invalid_usage_response",
  );
});

test("single-provider refresh encodes ids and rejects malformed responses", async () => {
  const urls: string[] = [];
  const provider = await loadProvider("open code", async (url) => {
    urls.push(String(url));
    return Response.json({ id: "open code", metrics: [] });
  });
  expect(urls).toEqual(["/api/quota/open%20code"]);
  expect(provider.id).toBe("open code");
  expect(loadProvider("codex", async () => Response.json({ error: "bad" }))).rejects.toThrow("invalid_provider_response");
});

test("JSON requests reject non-JSON responses with a stable error", async () => {
  expect(requestJson("/broken", undefined, async () => new Response("oops"))).rejects.toThrow("invalid_json");
});

test("the shared usage view round-trips through the server endpoints", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string });
    return Response.json({ source: "claude", agent: "main" });
  };

  expect(await loadUsageView(request)).toEqual({ source: "claude", agent: "main" });
  expect(await storeUsageView({ source: "claude", agent: "main" }, request)).toEqual({
    source: "claude",
    agent: "main",
  });
  expect(calls).toEqual([
    { url: "/api/usage-view", method: undefined, body: undefined },
    { url: "/api/usage-view", method: "PUT", body: '{"source":"claude","agent":"main"}' },
  ]);
  expect(loadUsageView(async () => Response.json({ source: 1 }))).rejects.toThrow(
    "invalid_usage_view_response",
  );
});

test("official bridge setup is explicit and provider-scoped", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const result = await installOfficialBridge("claude", async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return Response.json({ id: "claude", metrics: [] });
  });
  expect(calls).toEqual([{ url: "/api/official-bridge/claude", method: "POST" }]);
  expect(result.id).toBe("claude");

  const removed = await removeOfficialBridge("claude", async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return Response.json({ id: "claude", metrics: [] });
  });
  expect(calls.at(-1)).toEqual({ url: "/api/official-bridge/claude", method: "DELETE" });
  expect(removed.id).toBe("claude");
});
