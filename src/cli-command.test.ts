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

test("unknown flags and extra operands return usage without HTTP", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json(quota);
  };

  expect(await run(["status", "--bogus"], request)).toEqual({ output: "usage: llm-quota --help", code: 3 });
  expect(await run(["provider", "codex", "--bogus"], request)).toEqual({ output: "usage: llm-quota --help", code: 3 });
  expect(await run(["status", "codex"], request)).toEqual({ output: "usage: llm-quota --help", code: 3 });
  expect(await run(["doctor", "--json"], request)).toEqual({ output: "usage: llm-quota --help", code: 3 });
  expect(calls).toBe(0);
});

// Antigravity splits its plan into separate pools. Collapsing the provider to its
// worst metric makes a drained third-party bucket reject a Gemini bucket that is
// full — and full is exactly what a vision task needs to see.
const pooled = {
  providers: [{
    id: "gemini",
    name: "Gemini",
    status: "ok",
    sourceKind: "official_client",
    plan: "Google AI Pro",
    metrics: [
      { label: "Gemini models · Session (5h)", used: 10, limit: 100, unit: "percent", resetAt: "2026-08-09T18:00:00.000Z" },
      { label: "Third-party · Weekly (7d)", used: 95, limit: 100, unit: "percent", resetAt: "2026-08-14T00:00:00.000Z" },
    ],
    updatedAt: "2026-08-09T12:00:00.000Z",
  }],
};

test("snapshot exposes every window while status still reports only the binding one", async () => {
  const request = async () => Response.json(pooled);

  const compact = JSON.parse((await run(["status", "--json"], request)).output);
  expect(compact.providers).toEqual([
    { id: "gemini", status: "ok", remaining: 5, resetAt: "2026-08-14T00:00:00.000Z" },
  ]);

  const snap = JSON.parse((await run(["snapshot", "--json"], request)).output);
  expect(snap.providers[0].windows).toEqual([
    { label: "Gemini models · Session (5h)", remaining: 90, resetAt: "2026-08-09T18:00:00.000Z" },
    { label: "Third-party · Weekly (7d)", remaining: 5, resetAt: "2026-08-14T00:00:00.000Z" },
  ]);
  expect(snap.providers[0].binding.remaining).toBe(5);
  expect(snap.providers[0].plan).toBe("Google AI Pro");
});

test("snapshot text marks which window binds", async () => {
  const result = await run(["snapshot"], async () => Response.json(pooled));
  expect(result.output).toContain("Gemini models · Session (5h): 90% left");
  expect(result.output).toContain("Third-party · Weekly (7d): 5% left");
  expect(result.output).toContain("<- binding");
  // Same exit-code semantics as status, so a script can key on either.
  expect(result.code).toBe(1);
});

test("reserve is denied on the binding window, not the healthiest one", async () => {
  const result = await run(["reserve", "gemini", "--json"], async () => Response.json(pooled));
  const body = JSON.parse(result.output);
  expect(body.granted).toBe(false);
  expect(body.reason).toBe("floor");
  expect(body.binding.remaining).toBe(5);
  expect(result.code).toBe(1);
});

test("reserve rejects a provider the snapshot does not carry", async () => {
  const result = await run(["reserve", "moonshot"], async () => Response.json(pooled));
  expect(result).toEqual({ output: "unknown provider: moonshot", code: 3 });
});

test("usage reports measured spend per model and effort, labelled as API-equivalent", async () => {
  const urls: string[] = [];
  const request = async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({
      generatedAt: "2026-08-09T12:00:00.000Z",
      estimatedCostEur: 12.5,
      rows: [{
        source: "claude", model: "claude-opus-5", effort: "high", agent: "main",
        calls: 40, total: 250_000, output: 30_000, costEur: 9.25, contextReusePct: 68,
      }],
    });
  };

  const json = JSON.parse((await run(["usage", "--json"], request)).output);
  expect(urls).toEqual(["http://localhost:4747/api/usage"]);
  expect(json.costBasis).toBe("api_equivalent");
  expect(json.rows[0]).toMatchObject({ model: "claude-opus-5", effort: "high", outputTokens: 30_000 });

  const text = (await run(["usage"], request)).output;
  expect(text).toContain("claude claude-opus-5 high main 40 calls 250k tok");
  expect(text).toContain("not plan debit");
});
