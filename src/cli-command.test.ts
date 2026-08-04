import { expect, test } from "bun:test";
import { run } from "./cli.js";

const quota = {
  providers: [{
    id: "codex",
    name: "Codex",
    status: "ok",
    metrics: [{ label: "7d", used: 40, limit: 100, unit: "percent" }],
    raw: { secret: "no" },
    updatedAt: "2026-07-24T00:00:00.000Z",
  }],
};

test("status uses one aggregate HTTP call and returns compact output", async () => {
  const urls: string[] = [];
  const request = async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json(quota);
  };

  const result = await run(["status"], request);

  expect(urls).toEqual(["http://localhost:4747/api/quota"]);
  expect(result).toEqual({ output: "codex 60%\nworst codex 60%", code: 0 });
});

test("status --json returns sanitized compact JSON", async () => {
  const result = await run(["status", "--json"], async () => Response.json(quota));

  expect(JSON.parse(result.output)).toEqual({
    providers: [{ id: "codex", status: "ok", remaining: 60 }],
    worst: { id: "codex", remaining: 60 },
  });
  expect(result.output).not.toContain("secret");
});

test("provider fetches only requested provider", async () => {
  const urls: string[] = [];
  const request = async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json(quota.providers[0]);
  };

  const result = await run(["provider", "codex", "--json"], request);

  expect(urls).toEqual(["http://localhost:4747/api/quota/codex"]);
  expect(JSON.parse(result.output).providers).toEqual([{ id: "codex", status: "ok", remaining: 60 }]);
});

test("help performs no HTTP call", async () => {
  let calls = 0;
  const result = await run(["--help"], async () => {
    calls++;
    return Response.json({});
  });

  expect(calls).toBe(0);
  expect(result.code).toBe(0);
  expect(result.output).toContain("llm-quota status [--json]");
});

test("doctor checks server without fetching provider quotas", async () => {
  const urls: string[] = [];
  const result = await run(["doctor"], async (url) => {
    urls.push(String(url));
    return Response.json([{ id: "codex" }, { id: "claude" }]);
  });

  expect(urls).toEqual(["http://localhost:4747/api/providers"]);
  expect(result).toEqual({ output: "ok 2 providers", code: 0 });
});

test("offline server returns exit 3 without throwing", async () => {
  const result = await run(["status"], async () => {
    throw new Error("connection refused");
  });

  expect(result).toEqual({ output: "server offline: connection refused", code: 3 });
});

test("invalid invocations return usage error without HTTP", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json({});
  };

  expect(await run(["wat"], request)).toEqual({ output: "usage: llm-quota --help", code: 3 });
  expect(await run(["provider"], request)).toEqual({ output: "usage: llm-quota provider <id>", code: 3 });
  expect(calls).toBe(0);
});

test("LLM_QUOTA_URL overrides the legacy server environment variable", async () => {
  const previous = { current: process.env.LLM_QUOTA_URL, legacy: process.env.WEBQUOTA_URL };
  process.env.LLM_QUOTA_URL = "http://new-brand.test";
  process.env.WEBQUOTA_URL = "http://legacy.test";
  const urls: string[] = [];
  try {
    await run(["status"], async (url) => {
      urls.push(String(url));
      return Response.json({ providers: [] });
    });
  } finally {
    if (previous.current == null) delete process.env.LLM_QUOTA_URL;
    else process.env.LLM_QUOTA_URL = previous.current;
    if (previous.legacy == null) delete process.env.WEBQUOTA_URL;
    else process.env.WEBQUOTA_URL = previous.legacy;
  }
  expect(urls).toEqual(["http://new-brand.test/api/quota"]);
});

// `args.indexOf(command) + 1` used to take whatever followed the subcommand, so a flag
// written between the two was requested as if it were the provider id.
test("a flag between the subcommand and the id is not mistaken for the id", async () => {
  const urls: string[] = [];
  const request = async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json(quota.providers[0]);
  };

  const result = await run(["provider", "--json", "codex"], request);

  expect(urls).toEqual(["http://localhost:4747/api/quota/codex"]);
  expect(JSON.parse(result.output).providers[0].id).toBe("codex");
});

test("provider with no id at all still reports usage", async () => {
  const result = await run(["provider", "--json"], async () => Response.json(quota));
  expect(result).toEqual({ output: "usage: llm-quota provider <id>", code: 3 });
});
