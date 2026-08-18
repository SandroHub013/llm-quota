/**
 * Every provider reaches the network through `fetchJson`, and its whole contract is a
 * negative one: it never throws. A provider adapter that has to guard its own fetch
 * would eventually forget to, and one unhandled rejection there takes down the quota
 * route for every other provider on the page.
 *
 * Tested against a real server on an ephemeral port rather than a stubbed `fetch`: the
 * cases that matter are a body that is not JSON, a connection that is refused and a
 * response that never comes, and none of those are interesting when they are faked at
 * the call site.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fetchJson, nowIso } from "./util.js";

let server: ReturnType<typeof Bun.serve>;
let origin: string;
/** Held open so the timeout case has something to wait on rather than a closed socket. */
let pending: ((value: Response) => void) | undefined;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/json") {
        return Response.json({ ok: true, quota: 42 });
      }
      if (pathname === "/html") {
        return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      }
      if (pathname === "/echo") {
        return Response.json({ auth: request.headers.get("authorization"), method: request.method });
      }
      if (pathname === "/hang") {
        return new Promise<Response>((resolve) => { pending = resolve; });
      }
      return new Response("no", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  pending?.(new Response("done"));
  await server.stop(true);
});

test("a JSON answer arrives parsed, with the text it was parsed from", async () => {
  const result = await fetchJson(`${origin}/json`);

  expect(result.ok).toBe(true);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true, quota: 42 });
  expect(JSON.parse(result.text)).toEqual({ ok: true, quota: 42 });
});

/**
 * Providers answer errors with an HTML page more often than with JSON. The body is
 * undefined and the text is kept verbatim, which is what lets a card say what the
 * provider actually said instead of "unknown error".
 */
test("a body that is not JSON is not an exception", async () => {
  const result = await fetchJson(`${origin}/html`);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(502);
  expect(result.body).toBeUndefined();
  expect(result.text).toContain("502 Bad Gateway");
});

test("what the caller sends is what arrives", async () => {
  const result = await fetchJson(`${origin}/echo`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });

  expect(result.body).toEqual({ auth: "Bearer test-token", method: "POST" });
});

/**
 * The case this function exists for. A provider that stops answering must cost one card
 * its data and the wait, not the whole request: status 0 is the shape every adapter
 * reads as "nothing came back".
 */
test("a response that never comes gives up, without throwing", async () => {
  const started = Date.now();
  const result = await fetchJson(`${origin}/hang`, {}, 150);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
  expect(result.body).toBeUndefined();
  expect(result.text).toBeTruthy();
  // Gave up on its own clock rather than on the server's.
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("a refused connection is the same shape as a timeout", async () => {
  // Port 1 on loopback: nothing listens, and the refusal is immediate.
  const result = await fetchJson("http://127.0.0.1:1/anything", {}, 2_000);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
  expect(result.body).toBeUndefined();
  expect(typeof result.text).toBe("string");
});

test("a malformed URL is a failed result, not a thrown one", async () => {
  const result = await fetchJson("not-a-url", {}, 2_000);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
});

test("timestamps are ISO-8601 in UTC, which is what every card compares against", () => {
  expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
