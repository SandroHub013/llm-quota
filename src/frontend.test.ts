import { readdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { normaliseLabel } from "./providers/gemini.js";

const read = (path: string) => Bun.file(path).text();

// The footer and the README both promise "zero telemetria · zero CDN". This test is
// what makes that promise true rather than aspirational: the dashboard must not
// reference any host it does not serve itself.
test("the frontend makes no third-party requests", async () => {
  const [html, app, api, ui] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("public/api.js"),
    read("public/ui.js"),
  ]);
  const frontend = [html, app, api, ui].join("\n");

  // Console links arrive from the API at runtime. A literal remote URL in these files
  // can be used by a resource-bearing element, so reject it; the W3C SVG namespace is
  // metadata and causes no request.
  const remote = [...frontend.matchAll(/\bhttps?:\/\/([^\s"'`)]+)/g)]
    .map((m) => m[1])
    .filter((host) => !host.startsWith("www.w3.org"));

  expect(remote).toEqual([]);
  expect(frontend).not.toContain("fonts.googleapis.com");
  expect(frontend).not.toContain("fonts.gstatic.com");
  expect(frontend).not.toContain("s2/favicons");
});

test("the documentation site loads no third-party assets", async () => {
  const site = await read("docs/index.html");
  const resources = [
    ...site.matchAll(/\b(?:src|srcset)\s*=\s*["']([^"']+)/gi),
    ...site.matchAll(/\burl\(\s*["']?([^"')]+)/gi),
    ...site.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)/gi),
  ].map((match) => match[1]).join("\n");
  const remote = [...resources.matchAll(/\bhttps?:\/\/([^\s/"',)]+)/g)]
    .map((match) => match[1])
    .filter((host) => host !== "sandrohub013.github.io" && host !== "www.w3.org");

  expect(remote).toEqual([]);
});

// Official provider marks, but frozen in the repo. Loading them from the provider
// (or from Google's favicon service, as this used to) would tell a third party which
// AI subscriptions the user holds, on every single page load.
test("provider logos are local files with no external references", async () => {
  const logos = {
    claude: "claude.png",
    codex: "codex.webp",
    zai: "zai.svg",
    "opencode-zen": "opencode-zen.png",
    gemini: "gemini.svg",
    moonshot: "moonshot.png",
  };
  const app = await read("public/app.js");

  for (const [id, file] of Object.entries(logos)) {
    expect(app).toContain(`"/logos/${file}"`);
    const asset = Bun.file(`public/logos/${file}`);
    expect(await asset.exists()).toBe(true);
    expect(asset.size).toBeGreaterThan(500);
  }

  // An SVG can pull in a remote image or stylesheet of its own; neither surface may.
  for (const dir of ["public/logos", "docs/logos"]) {
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".svg")) continue;
      const svg = await read(`${dir}/${file}`);
      const remote = [...svg.matchAll(/https?:\/\/[^\s"')]+/g)]
        .map((m) => m[0])
        .filter((u) => !u.startsWith("http://www.w3.org"));
      expect(remote).toEqual([]);
    }
  }
});

test("fonts are served from the repo, not a CDN", async () => {
  const html = await read("public/index.html");
  for (const file of [
    "schibsted-var-latin.woff2",
    "syne-var-latin.woff2",
    "jetbrains-mono-500-latin.woff2",
  ]) {
    expect(html).toContain(`/fonts/${file}`);
    expect(await Bun.file(`public/fonts/${file}`).exists()).toBe(true);
  }
});

// The cards are painted as static skeletons so the deferred module never pushes the
// layout down after first paint. Losing them would bring the layout shift back.
test("every provider ships a static skeleton card", async () => {
  const html = await read("public/index.html");
  for (const id of ["claude", "codex", "zai", "opencode-zen", "gemini", "moonshot"]) {
    expect(html).toContain(`class="card is-skeleton" data-provider="${id}"`);
  }
});

test("gemini quota windows are named like every other provider's", () => {
  expect(normaliseLabel("Gemini Models · Weekly Limit")).toBe("Gemini models · Weekly (7d)");
  expect(normaliseLabel("Claude and GPT models · Five Hour Limit")).toBe(
    "Claude and GPT models · Session (5h)",
  );
  // Anything Google adds later passes through untouched instead of being dropped.
  expect(normaliseLabel("Something New · Hourly Limit")).toBe("Something New · Hourly Limit");
});
