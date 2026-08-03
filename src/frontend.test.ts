import { readdir } from "node:fs/promises";
import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

// The footer and the README both promise "zero telemetry · zero CDN". This test is
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
test("every visible quota provider ships a static skeleton card", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);
  for (const id of ["claude", "codex", "zai", "gemini", "moonshot"]) {
    expect(html).toContain(`class="card is-skeleton" data-provider="${id}"`);
  }
  expect(html).not.toContain('class="card is-skeleton" data-provider="opencode-zen"');
  expect(app).toContain('const LINEUP = ["claude", "codex", "zai", "gemini", "moonshot"]');
});

test("local token usage sits beside the widget and opens an accessible dialog", async () => {
  const [html, app, api] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("public/api.js"),
  ]);
  const widget = html.indexOf('id="openWidget"');
  const usage = html.indexOf('id="openUsage"');
  const live = html.indexOf('id="liveStatus"');

  expect(widget).toBeGreaterThan(-1);
  expect(usage).toBeGreaterThan(widget);
  expect(live).toBeGreaterThan(usage);
  expect(html).toContain('<dialog class="usage-dialog" id="usageDialog"');
  expect(html).not.toContain('id="refreshAll"');
  expect(html).not.toContain('id="refreshUsage"');
  expect(app).toContain("usageDialog.showModal()");
  expect(api).toContain('requestJson("/api/usage"');
  expect(app).toContain("summary.contextReusePct");
  expect(app).toContain("row.contextReusePct");
  expect(app).toContain("cache read + cache write");
});

test("dashboard data refreshes silently and the spend total counts to each new value", async () => {
  const [html, app, github] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("public/github-contributions.prototype.js"),
  ]);

  expect(html).toContain('id="liveStatus" role="status"');
  expect(app).toContain("const QUOTA_REFRESH_MS = 60_000");
  expect(app).toContain("const USAGE_REFRESH_MS = 5_000");
  expect(app).toContain('document.addEventListener("visibilitychange"');
  expect(app).toContain("animateUsageAmount(summary.estimatedCostEur)");
  expect(app).toContain("nextSignature === providerSignatures.get(p.id)");
  expect(github).toContain("const CONTRIBUTION_REFRESH_MS = 10 * 60_000");
  expect(github).toContain('data-activity-view="github"');
  expect(github).toContain('data-activity-view="usage"');
  expect(github).toContain("buildUsageCalendar");
  expect(github).toContain('source.status === "ok"');
  expect(github).toContain('names.join(" · ")');
  expect(github).not.toContain("Codex · Claude Code · OpenCode · Kimi Code");
  expect(html).toContain("column-span: all");
  expect(html).toContain("transform: translate3d(-100px, -100px, 0)");
});

test("personal activity comes from each downloader's local sessions", async () => {
  const [backend, frontend] = await Promise.all([
    read("src/github-contributions.prototype.ts"),
    read("public/github-contributions.prototype.js"),
  ]);

  expect(backend).toContain("viewer {");
  expect(backend).toContain('["gh", "api", "graphql"');
  expect(backend).not.toContain("SandroHub013");
  expect(frontend).not.toContain("SandroHub013");
});

test("runtime and marketing surfaces stay English and describe synthetic previews", async () => {
  const [app, dashboard, site, widget, credentials, generator] = await Promise.all([
    read("public/app.js"),
    read("public/index.html"),
    read("docs/index.html"),
    read("widget.py"),
    read("src/credentials.ts"),
    read("scripts/capture_previews.py"),
  ]);
  const surfaces = [app, dashboard, site, widget, credentials, generator].join("\n");

  expect(surfaces).not.toContain('"it-IT"');
  expect(surfaces).not.toMatch(/\b(?:modalità|caratteristiche|giorni|dinamico|fallita|telemetria|spesa|avviso)\b/i);
  expect(site).toContain("Current interface rendered with synthetic sample data.");
  expect(site).toContain("Live without reloads");
  expect(site).not.toContain("Six providers");
  expect(site).not.toContain("Six cards");
  expect(generator).toContain("It never reads the developer's credentials");
  expect(generator).not.toContain("SandroHub013");
});

test("social preview copies stay identical and within GitHub's upload limit", async () => {
  const [sitePreview, appPreview] = [Bun.file("docs/og.jpg"), Bun.file("public/og.jpg")];
  expect(sitePreview.size).toBeGreaterThan(100_000);
  expect(sitePreview.size).toBeLessThan(1_000_000);
  expect(appPreview.size).toBe(sitePreview.size);
  expect(Buffer.from(await appPreview.arrayBuffer()).equals(Buffer.from(await sitePreview.arrayBuffer()))).toBe(true);
});
