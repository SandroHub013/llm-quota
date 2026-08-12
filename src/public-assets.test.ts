import { expect, test } from "bun:test";
import { app } from "./server.js";
import { PUBLIC_ASSETS } from "./public-assets.generated.js";
import { INDEX, servable } from "./public-mime.js";
import { collectAssets, render } from "../scripts/generate-public-manifest.js";

const LOCAL = { headers: { host: "localhost:4747" } };

/**
 * The manifest is what the compiled desktop binary ships; public/ is what the
 * repository holds. Adding a font or a provider logo without regenerating would pass
 * every other test and then 404 in the release build only, where nobody is looking.
 */
test("the embedded manifest matches public/", async () => {
  const assets = await collectAssets();
  expect(Object.keys(PUBLIC_ASSETS).sort()).toEqual(assets);
  expect(await Bun.file("src/public-assets.generated.ts").text()).toBe(render(assets));
});

test("every embedded asset is readable and non-empty", async () => {
  for (const [name, path] of Object.entries(PUBLIC_ASSETS)) {
    const file = Bun.file(path);
    expect(await file.exists(), `${name} is missing`).toBe(true);
    expect(file.size, `${name} is empty`).toBeGreaterThan(0);
  }
});

test("only servable extensions are embedded", () => {
  expect(Object.keys(PUBLIC_ASSETS).filter((name) => !servable(name))).toEqual([]);
  expect(PUBLIC_ASSETS[INDEX]).toBeDefined();
});

test("the dashboard and its assets are served", async () => {
  const html = await app.request("/", LOCAL);
  expect(html.status).toBe(200);
  expect(await html.text()).toContain("<!doctype html>");

  const script = await app.request("/app.js", LOCAL);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

  const font = await app.request("/fonts/syne-var-latin.woff2", LOCAL);
  expect(font.status).toBe(200);
  expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
});

/**
 * The route resolved caller-supplied paths against a directory before the manifest
 * replaced it, and the guard that kept those inside public/ went with it. These are
 * the escapes that guard existed for: a key lookup has to keep refusing them.
 */
test("a path that was never shipped is refused", async () => {
  for (const path of [
    "/../package.json",
    "/../../.ssh/id_rsa.png",
    "/..%2f..%2fpackage.json",
    "/logos/../../package.json",
    "/index.html",
    "/api.d.ts",
    "/bklit-ui/bklit.css",
    "/logos/nonexistent.png",
  ]) {
    expect((await app.request(path, LOCAL)).status, `${path} was served`).toBe(404);
  }
});
