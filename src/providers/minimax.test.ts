/**
 * MiniMax Coding Plan, tested against the documented payload rather than against the
 * service — which today answers the documented request with a demand for a browser
 * cookie. The adapter ships unregistered for that reason, and these tests are what makes
 * switching it on a one-line decision instead of a rewrite.
 *
 * The fetch path is exercised against a real server on an ephemeral port, so the two
 * endpoints, the envelope MiniMax wraps failures in, and the upstream bug all run through
 * the same code the card would.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { COOKIE_BUG_MESSAGE, minimax, parseCodingPlan, readCodingPlan } from "./minimax.js";

const RESET = 1_787_000_000;

test("both rolling windows become metrics, with what is left and when it returns", () => {
  const metrics = parseCodingPlan({
    current_interval_usage_count: 120,
    current_interval_total_count: 500,
    current_interval_reset_time: RESET,
    current_week_usage_count: 3_400,
    current_week_total_count: 10_000,
    current_week_reset_time: RESET + 86_400,
  });

  expect(metrics).toEqual([
    {
      label: "Session",
      used: 120,
      limit: 500,
      remaining: 380,
      unit: "requests",
      resetAt: new Date(RESET * 1_000).toISOString(),
    },
    {
      label: "Weekly",
      used: 3_400,
      limit: 10_000,
      remaining: 6_600,
      unit: "requests",
      resetAt: new Date((RESET + 86_400) * 1_000).toISOString(),
    },
  ]);
});

/**
 * A cap of zero is a window this plan does not have. Rendering it as 100% used would put
 * a red card on the dashboard for a limit nobody bought.
 */
test("a window with no cap is left out rather than shown as exhausted", () => {
  const metrics = parseCodingPlan({
    current_interval_usage_count: 10,
    current_interval_total_count: 100,
    current_week_usage_count: 0,
    current_week_total_count: 0,
  });

  expect(metrics.map((metric) => metric.label)).toEqual(["Session"]);
});

test("an empty or absent payload is no metrics, not a crash", () => {
  expect(parseCodingPlan(undefined)).toEqual([]);
  expect(parseCodingPlan({})).toEqual([]);
  expect(parseCodingPlan({ base_resp: { status_code: 1004 } })).toEqual([]);
});

test("a reset time that is not a time is dropped, and the window is still shown", () => {
  const [session] = parseCodingPlan({
    current_interval_usage_count: 1,
    current_interval_total_count: 2,
    current_interval_reset_time: "soon",
  });

  expect(session?.remaining).toBe(1);
  expect(session?.resetAt).toBeUndefined();
});

test("without a key the card asks for one instead of calling MiniMax", async () => {
  const result = await minimax.fetch({});

  expect(result.status).toBe("unauthenticated");
  expect(result.needsKey).toBe(true);
  expect(result.metrics).toEqual([]);
});

/**
 * The live half. MiniMax answers 200 with the failure inside `base_resp`, so a status
 * code alone says nothing — which is exactly how the upstream bug presents.
 */
let server: ReturnType<typeof Bun.serve>;
let mode = "ok";
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization") ?? "");
      if (mode === "cookie") {
        return Response.json({ base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } });
      }
      return Response.json({
        base_resp: { status_code: 0, status_msg: "success" },
        plan_name: "Coding Plan Pro",
        current_interval_usage_count: 500,
        current_interval_total_count: 500,
        current_interval_reset_time: RESET,
      });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

test("the key travels as the bearer token the documentation asks for", async () => {
  seen.length = 0;
  mode = "ok";
  const attempt = await readCodingPlan(`http://127.0.0.1:${server.port}/v1/token_plan/remains`, "mm-test-key");

  expect(seen).toEqual(["Bearer mm-test-key"]);
  expect(attempt.plan).toBe("Coding Plan Pro");
  expect(attempt.metrics[0]).toMatchObject({ label: "Session", used: 500, limit: 500, remaining: 0 });
});

/**
 * The failure that keeps this adapter unregistered. MiniMax answers 200 with the refusal
 * inside `base_resp`, so a status code alone says nothing.
 */
test("a 200 that hides a cookie demand is read as a cookie demand", async () => {
  mode = "cookie";
  const attempt = await readCodingPlan(`http://127.0.0.1:${server.port}/v1/token_plan/remains`, "mm-test-key");

  expect(attempt.cookieDemanded).toBe(true);
  expect(attempt.metrics).toEqual([]);
  expect(attempt.detail).toContain("cookie is missing");
});

/**
 * It has to be reported as what it is — a vendor rejecting its own documented
 * authentication — or someone spends an afternoon regenerating a key that was never the
 * problem. Asserted on the message rather than by calling MiniMax: a test that reaches a
 * vendor's servers fails on their outages, not on this repository's mistakes.
 */
test("the card never blames the key for MiniMax's own bug", () => {
  expect(COOKIE_BUG_MESSAGE).toContain("MiniMax-AI/MiniMax-M2#88");
  expect(COOKIE_BUG_MESSAGE).toContain("session cookie");
  expect(COOKIE_BUG_MESSAGE).not.toMatch(/invalid key|wrong key|check your key/i);
});

test("an exhausted window leaves nothing remaining", () => {
  const metrics = parseCodingPlan({
    current_interval_usage_count: 500,
    current_interval_total_count: 500,
    current_interval_reset_time: RESET,
  });

  expect(metrics[0]!.remaining).toBe(0);
});
