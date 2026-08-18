/**
 * Compares this repository's price list against models.dev, and reports what disagrees.
 *
 * The ledger's headline figure is built entirely on the table in `src/usage.ts`, and a
 * vendor changing a rate is invisible from here: nothing breaks, nothing warns, the euro
 * total is simply wrong from that day on. The table carries a date for exactly that
 * reason, and a date is a reminder, not a check.
 *
 * models.dev publishes an open, per-provider database of model prices. It is used here
 * as a second opinion at development time and nowhere else: the shipped app reads no
 * third-party catalogue, because a number people are asked to believe should not depend
 * on a service neither they nor this project control. When this script and the table
 * disagree, the answer comes from the vendor's own documentation — which is how the
 * first run of it found GPT-5.6 Terra priced 25% high and Luna five times high.
 *
 * Run: bun run prices:check
 */
import { PRICES_FOR_AUDIT, PRICING_AS_OF } from "../src/usage.js";

const SOURCE = "https://models.dev/api.json";

/**
 * The providers whose own prices this ledger quotes. Everything else on models.dev is a
 * reseller or a gateway, and a gateway's markup is not the list price of the model.
 */
const FIRST_PARTY = ["anthropic", "openai", "google", "moonshotai", "zhipuai", "zai"];

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

type ModelsDev = Record<string, { models?: Record<string, { cost?: ModelsDevCost }> }>;

/**
 * Where this repository and models.dev name the same model differently. The ledger keeps
 * the name the vendor prints on its pricing page; models.dev keeps the API id, which for
 * a model still in preview carries the suffix.
 */
const ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
};

/**
 * Differences that are answers rather than questions. Each one is a decision recorded in
 * `src/usage.ts`, and re-reading it every run would train whoever runs this to skim.
 */
const EXPECTED: Record<string, string> = {
  "gemini-3.6-flash": "promotional rate through 2026-12-31; models.dev lists the rate after it",
  "gemini-3.7-flash": "promotional rate through 2026-12-31; models.dev lists the rate after it",
};

/**
 * Google, Moonshot and Z.ai do not bill cache writes per token — caching is implicit, or
 * charged by storage time. This table keeps the input rate in that column so the maths
 * stays uniform, and those sources never fill it. models.dev leaves it empty instead.
 */
const cacheWriteIsConvention = (ours: number, theirs: number | undefined, input: number) =>
  (theirs == null || theirs === 0) && ours === input;

const fmt = (value: number | undefined) => (value == null ? "—" : String(value));

const catalogue = (await fetch(SOURCE).then((response) => {
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  return response.json();
})) as ModelsDev;

const index = new Map<string, { provider: string; cost: ModelsDevCost }>();
for (const provider of FIRST_PARTY) {
  for (const [id, model] of Object.entries(catalogue[provider]?.models ?? {})) {
    if (!index.has(id) && model.cost) index.set(id, { provider, cost: model.cost });
  }
}

let disagreements = 0;
let absent = 0;
let matched = 0;

for (const [id, ours] of Object.entries(PRICES_FOR_AUDIT)) {
  const hit = index.get(ALIASES[id] ?? id);
  if (!hit) {
    absent += 1;
    console.log(`  ?  ${id}: not published by a first-party provider on models.dev`);
    continue;
  }

  const theirs = hit.cost;
  const fields: [string, number, number | undefined][] = [
    ["input", ours.input, theirs.input],
    ["cache read", ours.cacheRead, theirs.cache_read],
    ["cache write", ours.cacheWrite, theirs.cache_write],
    ["output", ours.output, theirs.output],
  ];
  const off = fields.filter(([name, mine, other]) =>
    mine !== other && !(name === "cache write" && cacheWriteIsConvention(mine, other, ours.input))
  );

  if (!off.length) {
    matched += 1;
    continue;
  }
  if (EXPECTED[id]) {
    console.log(`  =  ${id}: ${EXPECTED[id]}`);
    continue;
  }

  disagreements += 1;
  console.log(`  !  ${id} [${hit.provider}]`);
  for (const [name, mine, other] of off) {
    console.log(`       ${name}: this repo ${fmt(mine)}, models.dev ${fmt(other)}`);
  }
}

console.log(
  `\n${matched} agree, ${disagreements} disagree, ${absent} unpublished. ` +
  `The table says it was checked on ${PRICING_AS_OF}.`,
);
if (disagreements) {
  console.log(
    "\nA disagreement is not a verdict: check the vendor's own pricing page and change\n" +
    "whichever is wrong. models.dev is a second opinion, not the source.",
  );
  process.exit(1);
}
