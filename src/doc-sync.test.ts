import { expect, test } from "bun:test";
import { providers } from "./providers/index.js";

// Normalised, because git hands the Windows runner CRLF for the commit Linux gets as
// LF. Every assertion in this file matches against file text, and any pattern that
// spans two lines passes on Ubuntu and fails on Windows only.
const read = async (path: string) => (await Bun.file(path).text()).replaceAll("\r\n", "\n");

/**
 * Adding or removing a provider touches the registry, two READMEs, the landing page,
 * the issue template and the frontend lineup. CONTRIBUTING carries that checklist, but
 * a checklist only works when someone remembers to open it — the Kimi and Z.ai removals
 * both left the landing page still advertising a card the product no longer ships.
 */
const REGISTERED = providers.map((provider) => provider.id);

test("the frontend lineup matches the server registry", async () => {
  const app = await read("public/app.js");
  const lineup = app.match(/const LINEUP = \[([^\]]*)\]/)?.[1];
  expect(lineup).toBeDefined();
  const ids = [...lineup!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toEqual(REGISTERED);
});

test("only registered providers reserve a skeleton card", async () => {
  const html = await read("public/index.html");
  const skeletons = [...html.matchAll(/class="card is-skeleton" data-provider="([^"]+)"/g)]
    .map((match) => match[1]);
  expect(skeletons).toEqual(REGISTERED);
});

// A disabled provider may still be named — the tables explain why it is disabled — but
// it must be named as disabled, never rendered as a live source.
test("the landing page does not animate a card the product no longer ships", async () => {
  const site = await read("docs/index.html");
  const demo = site.match(/const EVENTS = \[([\s\S]*?)\];/)?.[1];
  expect(demo).toBeDefined();
  const ids = new Set([...demo!.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]));
  for (const id of ids) expect(REGISTERED).toContain(id);
});

test("the landing page logo strip carries no retired provider", async () => {
  const site = await read("docs/index.html");
  const strip = site.match(/<div class="strip">([\s\S]*?)<\/div>/)?.[1] ?? "";
  for (const retired of ["moonshot", "zai", "opencode-zen"]) {
    expect(strip).not.toContain(`logos/${retired}`);
  }
});

// The Zen adapter, its card scaffolding and its mark are gone; OpenCode stays only as a
// local ledger source, which reads a database and needs no branding of its own.
test("nothing reintroduces the OpenCode Zen gateway", async () => {
  const [app, types] = await Promise.all([read("public/app.js"), read("src/providers/types.ts")]);

  expect(app).not.toContain("opencode-zen");
  expect(types).not.toContain("availability");
  for (const dir of ["public/logos", "docs/logos"]) {
    expect(await Bun.file(`${dir}/opencode-zen.png`).exists()).toBe(false);
  }
});

test("the bug report dropdown offers no retired provider", async () => {
  const template = await read(".github/ISSUE_TEMPLATE/bug_report.yml");
  for (const retired of ["Moonshot", "OpenCode Zen", "z.ai"]) {
    expect(template).not.toContain(`- ${retired}`);
  }
});

// The README is the first file a reader opens and the one that goes stale fastest.
test("both READMEs state the shipped provider count and nothing larger", async () => {
  for (const path of ["README.md", "README.it.md"]) {
    const readme = await read(path);
    expect(readme).not.toMatch(/\b(?:five|cinque)\s+(?:provider|card)/i);
    expect(readme).not.toMatch(/#\s*31\s+test/);
  }
});

test("public and landing metadata do not promise retired provider counts", async () => {
  for (const path of ["public/index.html", "docs/index.html"]) {
    const html = await read(path);
    expect(html).not.toMatch(/\bFive measurable AI quotas\b/i);
    expect(html).not.toMatch(/\bfive quota cards\b/i);
  }
});

/**
 * SignPath Foundation issues its free open-source certificate on the condition that
 * the project publishes a code signing policy carrying the attribution, the team
 * roles and a privacy statement, reachable from the homepage or the download page.
 * A policy that exists but is unreachable — or that loses one of the three required
 * parts to an edit — fails the review, and the review takes weeks to come round
 * again. See CODE_SIGNING.md.
 */
test("the code signing policy carries what the certificate is conditional on", async () => {
  const policy = await read("CODE_SIGNING.md");

  expect(policy).toContain("Free code signing provided by [SignPath.io](https://signpath.io)");
  expect(policy).toContain("[SignPath Foundation](https://signpath.org)");
  // The privacy wording is theirs, quoted rather than paraphrased.
  expect(policy).toContain(
    "will not transfer any information to other networked systems unless specifically\nrequested by the user",
  );
  for (const role of ["Author", "Reviewer", "Approver"]) {
    expect(policy, `the ${role} role is unlisted`).toContain(role);
  }
});

test("the code signing policy is reachable from the site and the READMEs", async () => {
  const site = await read("docs/index.html");
  expect(site).toContain("/blob/main/CODE_SIGNING.md");

  for (const path of ["README.md", "README.it.md"]) {
    expect(await read(path), `${path} does not link the policy`).toContain("(CODE_SIGNING.md)");
  }
});

/**
 * The landing page links straight at release assets so its button downloads rather
 * than opening a page with eleven files on it. A GitHub asset URL carries the version
 * in both the tag and the filename, which means the page goes stale the moment one is
 * cut — silently, as a 404 for every visitor, on the one control the page exists for.
 *
 * Hard-coding those URLs is only defensible with this test holding them to the version
 * the rest of the repository already agrees on.
 */
test("the site's download links point at this version's assets", async () => {
  const version = JSON.parse(await read("package.json")).version;
  const site = await read("docs/index.html");
  const base = `https://github.com/SandroHub013/llm-quota/releases/download/v${version}/`;

  // The names the bundler produces, with the space GitHub turns into a dot.
  for (const asset of [
    `LLM.Quota_${version}_x64_en-US.msi`,
    `LLM.Quota_${version}_aarch64.dmg`,
    `LLM.Quota_${version}_x64.dmg`,
    `LLM.Quota_${version}_amd64.deb`,
  ]) {
    expect(site, `the site does not link ${asset}`).toContain(base + asset);
  }

  // And nothing left pointing at an older release, which would download a version the
  // page does not describe.
  const stale = [...site.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)]
    .map((match) => match[1]!)
    .filter((linked) => linked !== version);
  expect(stale, "the site links assets from another release").toEqual([]);
});

/**
 * The Sponsor link is the one place a reader is asked for money, so a broken one is
 * worse than none: it reads as a project that cannot keep its own links working. It
 * appears in three files and there is nothing to catch a typo in any of them.
 */
test("the sponsor link is the same everywhere it appears", async () => {
  const funding = await read(".github/FUNDING.yml");
  const account = funding.match(/^github:\s*\[?([\w-]+)/m)?.[1];
  expect(account, "FUNDING.yml names no GitHub account").toBeDefined();

  const url = `https://github.com/sponsors/${account}`;
  for (const path of ["README.md", "README.it.md", "docs/index.html"]) {
    expect(await read(path), `${path} does not link ${url}`).toContain(url);
  }
});
