import { expect, test } from "bun:test";
import { app } from "./server.js";

const at = (url: string, init?: RequestInit) => app.request(url, init);

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

test("the dashboard's own origin is still allowed to write", async () => {
  const response = await at("http://localhost:4747/api/official-bridge/nope", {
    method: "POST",
    headers: { Origin: "http://localhost:4747" },
  });
  // Rejected as an unknown bridge by the handler, not blocked by the origin guard.
  expect(response.status).toBe(404);
});

test("same-origin requests that send no Origin header keep working", async () => {
  const response = await at("http://localhost:4747/api/key/unknown-provider", { method: "POST" });
  expect(response.status).toBe(404);
});
