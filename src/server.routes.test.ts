/**
 * The routes, exercised through the app rather than through a port.
 *
 * This is the project's public contract: the dashboard, the widget, the CLI and a
 * wezterm status line all read it, and half of it had never been executed by a test.
 * Nothing here is allowed to touch the network, spawn a provider CLI or write to
 * `~/.llm-quota` — so what is covered is what answers from the process alone: the
 * static route that serves every asset the page loads, the registry, the read side of
 * the usage view, and the refusals that come before any handler does work. The write
 * routes appear only with bodies that must be refused before the write — a test that
 * stores something would be storing it in the config of whoever ran it.
 *
 * `server.security.test.ts` covers the same surface from the other direction: who is
 * allowed to ask. This covers what comes back when they are.
 */
import { expect, test } from "bun:test";
import { app } from "./server.js";
import { MIME, servable } from "./public-mime.js";
import { PUBLIC_ASSETS } from "./public-assets.generated.js";
import { providers } from "./providers/index.js";

const at = (path: string, init?: RequestInit) => app.request(`http://localhost:4747${path}`, init);

test("the dashboard is served at the root, as HTML", async () => {
  const response = await at("/");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  const body = await response.text();
  expect(body).toContain("<title>");
  // The page loads this as a module; serving an index that does not reference it means
  // a dashboard that renders and then does nothing.
  expect(body).toContain("/app.js");
});

test("every asset the manifest carries is servable, with the type the page expects", async () => {
  for (const relative of Object.keys(PUBLIC_ASSETS)) {
    if (relative === "index.html") continue;
    const response = await at(`/${relative.replaceAll("\\", "/")}`);

    expect(response.status, `${relative} is in the manifest but not served`).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(MIME[relative.slice(relative.lastIndexOf("."))]!);
  }
});

/**
 * Fonts are fingerprinted by nothing — they are served under a stable name — so they
 * are cached forever and everything else is revalidated. A dashboard that caches its
 * own JavaScript for a year is a dashboard that lies for a year after an update.
 */
test("fonts are immutable and code is not", async () => {
  const font = Object.keys(PUBLIC_ASSETS).find((name) => name.endsWith(".woff2"))!;
  const fontResponse = await at(`/${font.replaceAll("\\", "/")}`);
  expect(fontResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

  const script = await at("/app.js");
  expect(script.headers.get("Cache-Control")).toBe("no-cache");
});

/**
 * The static route answers from a generated manifest rather than from disk, so a name
 * that was never shipped has nothing to resolve to — traversal included. These are the
 * shapes that would have mattered when the route read the filesystem.
 */
test("a name that was never shipped is a 404, whatever shape it arrives in", async () => {
  for (const path of [
    "/nothing-here.js",
    "/../package.json",
    "/..%2Fpackage.json",
    "/src/server.ts",
    "/.env",
    "/logo.svg.map",
  ]) {
    const response = await at(path);
    expect(response.status, `${path} was answered`).toBe(404);
  }
});

// The manifest and the served set are generated from the same list; a file in one and
// not the other is a file shipped inside the binary that the server would refuse.
test("the manifest carries nothing the route would refuse", () => {
  for (const relative of Object.keys(PUBLIC_ASSETS)) {
    expect(servable(relative), `${relative} is shipped but not servable`).toBe(true);
  }
});

test("the provider registry is what the frontend lines up against", async () => {
  const response = await at("/api/providers");
  expect(response.status).toBe(200);

  const listed = await response.json();
  expect(listed).toEqual(providers.map((provider) => ({ id: provider.id, name: provider.name })));
  // Ids are what the page keys its cards by; a nameless one renders an empty card.
  for (const entry of listed as { id: string; name: string }[]) {
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBeTruthy();
  }
});

/**
 * An unknown id is refused before the handler reaches a provider, which is what keeps
 * `/api/quota/:id` from becoming a way to make this process do work on request.
 */
test("an unknown provider is refused without asking anyone", async () => {
  for (const path of ["/api/quota/not-a-provider", "/api/key/not-a-provider"]) {
    const response = await at(path, path.startsWith("/api/key") ? { method: "POST" } : undefined);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown provider" });
  }
});

/**
 * Same-origin and malformed. The cross-origin case is refused earlier and covered in
 * the security suite; this is the one that reaches the handler, and it must answer 400
 * rather than fall through to `key: undefined`, which deletes the stored credential.
 */
test("a malformed key body is a 400, not a deletion", async () => {
  const known = providers[0]!.id;
  for (const body of ["not json", JSON.stringify(["key"]), JSON.stringify({ key: 42 }), JSON.stringify(null)]) {
    const response = await at(`/api/key/${known}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status, `${body} was accepted`).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid key" });
  }
});

/**
 * The widget and the dashboard share this filter through the server, so its shape is
 * load-bearing in two clients at once: a missing field is a filter that silently
 * changes what one of them totals.
 */
test("the usage view always answers in the shape both clients read", async () => {
  const response = await at("/api/usage-view");
  expect(response.status).toBe(200);

  const view = await response.json();
  expect(view).toMatchObject({ source: expect.any(String), agent: expect.any(String) });
});

test("a usage-view body that is not an object is refused", async () => {
  for (const body of ["[]", '"all"', "null", "not json"]) {
    const response = await at("/api/usage-view", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status, `${body} was accepted`).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid view" });
  }
});
