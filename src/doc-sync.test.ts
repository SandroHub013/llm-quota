import { expect, test } from "bun:test";
import { providers } from "./providers/index.js";

const read = (path: string) => Bun.file(path).text();

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
  for (const retired of ["moonshot", "zai"]) {
    expect(strip).not.toContain(`logos/${retired}`);
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
