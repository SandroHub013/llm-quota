import { expect, test } from "bun:test";
import { loadProvider, loadQuota, loadUsage, requestJson } from "../public/api.js";

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
