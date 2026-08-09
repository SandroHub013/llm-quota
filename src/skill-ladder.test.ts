import { expect, test } from "bun:test";

const SKILL = ".agents/skills/llmquota/SKILL.md";
const LADDER = ".agents/skills/llmquota/references/ladder.json";

// A Windows checkout converts these files to CRLF, so every assertion below
// reads them with the line endings normalised rather than anchoring on "\n".
const read = async (path: string) => (await Bun.file(path).text()).replace(/\r\n/g, "\n");

test("the skill declares frontmatter a loader can key on", async () => {
  const text = await read(SKILL);
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  expect(frontmatter).toBeDefined();
  expect(frontmatter).toContain("name: llmquota");
  expect(frontmatter).toContain("description:");
});

// The ladder is generated. A hand-edit or a half-failed refresh has to fail here
// rather than reach a routing decision.
test("the generated ladder carries the fields routing reads", async () => {
  const ladder = await Bun.file(LADDER).json();
  expect(Number.isFinite(Date.parse(ladder.refreshedAt))).toBe(true);
  expect(ladder.primary.source.url).toContain("deepswe");
  expect(ladder.primary.configs.length).toBeGreaterThan(20);

  for (const config of ladder.primary.configs) {
    expect(typeof config.model).toBe("string");
    expect(typeof config.effort).toBe("string");
    expect(config.passAt1).toBeGreaterThan(0);
    expect(config.outputTokens).toBeGreaterThan(0);
    expect(typeof config.dominated).toBe("boolean");
    expect(typeof config.topBand).toBe("boolean");
  }
});

test("dominance and the top band are internally consistent", async () => {
  const { primary } = await Bun.file(LADDER).json();
  const configs = primary.configs;

  // Pareto: a dominated config must actually have a dominator on both axes.
  for (const config of configs.filter((entry: any) => entry.dominated)) {
    const better = configs.some((other: any) =>
      other !== config
      && other.passAt1 >= config.passAt1
      && other.outputTokens <= config.outputTokens
      && (other.passAt1 > config.passAt1 || other.outputTokens < config.outputTokens));
    expect(better).toBe(true);
  }

  // The leader is on the frontier and in its own band, and the band is a real
  // subset — a ladder where everything overlaps the leader would rank nothing.
  const leader = configs.reduce((best: any, entry: any) => (entry.passAt1 > best.passAt1 ? entry : best));
  expect(leader.dominated).toBe(false);
  expect(leader.topBand).toBe(true);
  const band = configs.filter((entry: any) => entry.topBand);
  expect(band.length).toBeGreaterThan(0);
  expect(band.length).toBeLessThan(configs.length);
  for (const entry of band) expect(entry.ciHi).toBeGreaterThanOrEqual(leader.ciLo);
});

// The two boards report different units. The refresh normalises Terminal-Bench to
// per-trial so nothing downstream compares an aggregate to a median.
test("Terminal-Bench rows are normalised per trial", async () => {
  const { secondary } = await Bun.file(LADDER).json();
  if ("error" in secondary) return;
  for (const row of secondary.rows) {
    if (row.outputTokensPerTrial == null) continue;
    expect(row.outputTokensPerTrial).toBeLessThan(1_000_000);
  }
  expect(secondary.rows.some((row: any) => row.rewardHacks != null)).toBe(true);
});

// The skill must not reintroduce the two things that made the earlier draft wrong.
test("the skill routes only to registered providers and keeps unobserved workers separate", async () => {
  const { providers } = await import("./providers/index.js");
  const text = await read(SKILL);
  const observed = text.slice(text.indexOf("**Observed**"), text.indexOf("**Unobserved**"));
  for (const provider of providers) expect(observed).toContain(`\`${provider.id}\``);
  for (const retired of ["moonshot", "zai", "opencode-zen", "openrouter"]) {
    expect(observed).not.toContain(`\`${retired}\``);
  }
  expect(text).toContain("never the default absorber");
});

// The CLI is the thing that calls /api/quota, so telling the skill to curl the
// same endpoint when the CLI reports the server offline is a loop, not a fallback.
test("the skill does not advertise the circular HTTP fallback", async () => {
  // Prose wraps, so match on the text with runs of whitespace collapsed.
  const text = (await read(SKILL)).replace(/\s+/g, " ");
  expect(text).toContain("the CLI *is* that call");
});
