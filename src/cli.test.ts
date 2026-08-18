import { describe, expect, test } from "bun:test";
import type { QuotaResult } from "./providers/types.js";
import { exitCode, formatStatus, summarize } from "./cli-core.js";

const result = (data: Partial<QuotaResult> & Pick<QuotaResult, "id" | "status">): QuotaResult => ({
  name: data.id,
  metrics: [],
  updatedAt: "2026-07-24T00:00:00.000Z",
  ...data,
});

describe("CLI summary", () => {
  test("keeps only compact safe fields and finds worst remaining quota", () => {
    const input = [
      result({
        id: "codex",
        status: "ok",
        metrics: [{ label: "7d", used: 41, limit: 100, unit: "percent", resetAt: "2026-07-30T00:00:00.000Z" }],
        raw: { secret: "must-not-leak" },
      }),
      result({
        id: "zai",
        status: "ok",
        metrics: [
          { label: "5h", used: 10, limit: 100, unit: "percent" },
          { label: "month", used: 95, limit: 100, unit: "percent", resetAt: "2026-07-25T00:00:00.000Z" },
        ],
      }),
    ];

    expect(summarize(input)).toEqual({
      providers: [
        { id: "codex", status: "ok", remaining: 59, resetAt: "2026-07-30T00:00:00.000Z" },
        { id: "zai", status: "ok", remaining: 5, resetAt: "2026-07-25T00:00:00.000Z" },
      ],
      worst: { id: "zai", remaining: 5 },
    });
  });

  test("formats one terse line per provider plus worst line", () => {
    const summary = summarize([
      result({ id: "codex", status: "ok", metrics: [{ label: "7d", used: 41, limit: 100, unit: "percent", resetAt: "2026-07-30T00:00:00.000Z" }] }),
      result({ id: "claude", status: "rate_limited" }),
    ]);

    expect(formatStatus(summary, new Date("2026-07-24T00:00:00.000Z"))).toBe(
      "codex 59% reset 6d\nclaude rate_limited\nworst codex 59%",
    );
  });

  test("uses exit 2 for provider errors and exit 1 for critical quota", () => {
    expect(exitCode(summarize([result({ id: "x", status: "error" })]))).toBe(2);
    expect(exitCode(summarize([result({ id: "x", status: "partial" })]))).toBe(2);
    expect(exitCode(summarize([result({ id: "x", status: "ok", metrics: [{ label: "q", used: 80, limit: 100 }] })]))).toBe(1);
    expect(exitCode(summarize([result({ id: "x", status: "ok", metrics: [{ label: "q", used: 79, limit: 100 }] })]))).toBe(0);
  });

  test("does not mislabel currency balance as a percentage", () => {
    expect(summarize([
      result({
        id: "moonshot",
        status: "ok",
        metrics: [{ label: "balance", remaining: 12.5, unit: "cny" }],
      }),
    ])).toEqual({ providers: [{ id: "moonshot", status: "ok" }] });
  });

  test("stats command fetches npm and github download stats", async () => {
    const { run } = await import("./cli.js");
    const mockRequest = async (url: string | URL | Request) => {
      const u = String(url);
      // Matched on the host rather than on a substring of the URL: `npmjs.org` also
      // appears inside `npmjs.org.example.com` and inside a path, so a mock keyed on
      // `includes` answers for requests the real code never meant to make — and a
      // test that cannot tell those apart cannot catch the day one is introduced.
      const host = URL.canParse(u) ? new URL(u).host : "";
      if (host === "api.npmjs.org") return Response.json({ downloads: 150 });
      if (host === "api.github.com") return Response.json([{ assets: [{ download_count: 42 }] }]);
      return new Response("not found", { status: 444 });
    };

    const res = await run(["stats"], mockRequest);
    expect(res.code).toBe(0);
    expect(res.output).toContain("NPM Downloads (last 30d): 150");
    expect(res.output).toContain("GitHub Release Downloads: 42");
  });
});
