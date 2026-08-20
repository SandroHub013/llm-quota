import { installOfficialBridge, loadQuota, loadUsage, loadUsageView, removeOfficialBridge, saveProviderKey, storeUsageView } from "./api.js";
import { dataSignature, escapeHtml } from "./ui.js";
import { mountGitHubContributionPrototype } from "./github-contributions.prototype.js";
import { mountUpdateNotice, tauriBridge } from "./update.js";
import { mountWidgetButton } from "./widget.js";

const grid = document.getElementById("grid");
const cards = new Map(); // id -> element
const latest = new Map(); // id -> QuotaResult, the horizon reads from here
const providerSignatures = new Map();

// Only the desktop shell has an update to offer; in a browser tab this is null and the
// notice never mounts.
const desktopBridge = tauriBridge(window);
mountUpdateNotice(document.getElementById("updateNotice"), desktopBridge);

const usageDialog = document.getElementById("usageDialog");
const usageBody = document.getElementById("usageBody");
const usageAmount = document.getElementById("usageAmount");
const usageButton = document.getElementById("openUsage");
const liveStatus = document.getElementById("liveStatus");
const liveStatusText = document.getElementById("liveStatusText");
let usageLoad;
let quotaLoad;
let usageSignature;
let lastUsageSummary;
let displayedUsageCost = 0;
let hasUsageCost = false;
let usageAmountFrame;
let lastQuotaAttemptAt = 0;
let lastUsageAttemptAt = 0;

// How the usage dialog is being looked at, kept out of the DOM because the poll
// re-renders the whole body every time the underlying figures change.
// source/agent are server-side state shared with the desktop widget; the
// localStorage copy is only an offline fallback until the server answers.
const USAGE_VIEW_KEY = "llmquota.usageView";
const usageView = {
  currency: "eur",
  sortKey: "cost",
  sortDir: "desc",
  source: "all",
  agent: "all",
};
try {
  Object.assign(usageView, JSON.parse(localStorage.getItem(USAGE_VIEW_KEY) || "{}"));
} catch (error) {
  // Deliberate: localStorage throws outright when the browser blocks site data, and
  // the stored value is only a display preference. Booting with the defaults is the
  // right outcome — but say so, or a filter that silently refuses to stick looks
  // like a bug in the dashboard.
  console.warn("llm-quota: ignoring the stored usage view", error);
}

function saveUsageView() {
  try {
    localStorage.setItem(USAGE_VIEW_KEY, JSON.stringify(usageView));
  } catch (error) {
    // Same deliberate fallback as the read above: the source/agent filters live on
    // the server anyway, so only the local display prefs are lost for this session.
    console.warn("llm-quota: could not persist the usage view", error);
  }
}

// The server holds the view of record. On boot it wins over the local copy, so
// a filter chosen here also decides what the desktop widget displays.
async function syncUsageViewFromServer() {
  try {
    const view = await loadUsageView();
    if (view.source === usageView.source && view.agent === usageView.agent) return;
    usageView.source = view.source;
    usageView.agent = view.agent;
    applyUsageView();
  } catch (error) {
    // Server offline: keep the local prefs until it answers.
    console.warn("llm-quota: usage view not synced from the server", error);
  }
}

function pushUsageViewToServer() {
  storeUsageView({ source: usageView.source, agent: usageView.agent }).catch((error) => {
    // Offline server keeps the local choice; the next successful boot resyncs.
    console.warn("llm-quota: usage view not pushed to the server", error);
  });
}

const QUOTA_REFRESH_MS = 60_000;
const USAGE_REFRESH_MS = 5_000;
const liveFailures = new Set();
const liveSources = new Set();

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

function setLiveResult(source, error) {
  liveSources.add(source);
  if (error) liveFailures.add(source);
  else liveFailures.delete(source);

  const failing = [...liveFailures];
  const connected = liveSources.size > 0;
  liveStatus.classList.toggle("is-live", connected && !failing.length);
  liveStatus.classList.toggle("has-error", failing.length > 0);
  liveStatusText.textContent = failing.length ? "Retrying…" : connected ? "Live" : "Connecting…";
  liveStatus.title = failing.length
    ? `Automatic updates are retrying: ${failing.join(", ")}`
    : "Live updates · usage every 5 seconds · quotas every minute";
}

const STATUS_LABEL = {
  ok: "active",
  partial: "partial",
  rate_limited: "rate limited",
  unauthenticated: "not signed in",
  no_endpoint: "no API quota",
  error: "error",
};

// Brand look per provider: avatar gradient + card accent + horizon marker colour.
const BRAND = {
  claude: { b1: "#d97757", b2: "#a85438" },
  codex: { b1: "#10a37f", b2: "#0b6e56" },
  zai: { b1: "#4f7cff", b2: "#2b4fb8" },
  gemini: { b1: "#4285f4", b2: "#9b72cf" },
  moonshot: { b1: "#0ea5e9", b2: "#3b82f6" },
};
const brand = (id) => BRAND[id] ?? { b1: "#5b8cff", b2: "#3a5bbf" };

// Official marks, each pulled from its own provider's site and frozen under
// public/logos — served locally, so the page still contacts nobody.
//
// `fill` marks the icons that already ship composited against their own brand
// background: those cover the plate edge to edge. The rest are bare glyphs and get
// a plate to sit on — the brand gradient, except Gemini, whose sparkle is itself a
// blue-violet gradient and would vanish on ours.
const LOGO = {
  // Anthropic's current A/slash mark is transparent; give it a warm neutral plate
  // instead of the retired orange square Claude starburst.
  claude: { src: "/logos/claude.png", plate: "#f5eee8", foreground: "#181818" },
  codex: { src: "/logos/codex.svg", plate: "#f4f4f1", foreground: "#181818" },
  zai: { src: "/logos/zai.svg" },
  gemini: { src: "/logos/gemini.svg", plate: "#f6f8fc" },
  moonshot: { src: "/logos/moonshot.png", fill: true },
};

// Drawn fallback, used only if a logo file is missing or fails to decode: same 24
// grid and optical weight as the bundled mark, using the plate's foreground color.
const S = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"';
const GLYPH = {
  claude: `<g transform="scale(.09375 .13636)" fill="currentColor"><path d="M147.49 0 217.57 175.78H256L185.92 0z"/><path d="m66.18 106.22 23.98-61.77 23.98 61.77zM70.07 0 0 175.78h39.18l14.33-36.91h73.31l14.33 36.91h39.18L110.25 0z"/></g>`,
  codex: `<path fill="currentColor" d="
    M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0
    0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0
    0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0
    5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022
    12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0
    .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945
    4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0
    .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0
    1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0
    .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1
    2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303
    2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0
    0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409
    9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065
    12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1
    7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998
    2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z
  "/>`,
  zai: `<path d="M14.5 2.5 6 13.5h4.2L8.5 21.5 18 10h-4.2z" fill="currentColor"/>`,
  gemini: `<path d="M12 2.2c0 5.4 4.4 9.8 9.8 9.8-5.4 0-9.8 4.4-9.8 9.8 0-5.4-4.4-9.8-9.8-9.8 5.4 0 9.8-4.4 9.8-9.8z" fill="currentColor"/>`,
  moonshot: `<path d="M20.2 14.8A8.6 8.6 0 0 1 9.2 3.8a8.6 8.6 0 1 0 11 11z" fill="currentColor"/>`,
};
const glyph = (id) => GLYPH[id] ?? `<circle cx="12" cy="12" r="7" ${S}/>`;

// Brand mark on its brand field. The drawn glyph sits underneath and only becomes
// visible if the image never loads (the error handler removes the <img>).
function markHtml(id, cls) {
  const b = brand(id);
  const logo = LOGO[id];
  const plate = logo?.plate
    ? `background:${logo.plate}${logo.foreground ? `;color:${logo.foreground}` : ""}`
    : `--b1:${b.b1};--b2:${b.b2}`;
  const classes = [cls, logo?.fill ? "is-full" : "", logo ? "has-logo" : ""]
    .filter(Boolean)
    .join(" ");
  return `<span class="${classes}" style="${plate}">
    <svg class="mark-fallback" viewBox="0 0 24 24" aria-hidden="true">${glyph(id)}</svg>
    ${logo ? `<img src="${logo.src}" alt="" width="24" height="24" decoding="async" />` : ""}
  </span>`;
}

// Reveal order, matching the static skeletons in index.html. Only used for a
// provider the server returns that has no skeleton waiting for it.
// "moonshot" is absent on purpose: see the comment in src/providers/index.ts.
// Its palette, logo and model list stay below so the card can return unchanged
// once Kimi Code exposes a quota surface a third-party dashboard may read.
const LINEUP = ["claude", "codex", "gemini"];
const VISIBLE_PROVIDERS = new Set(LINEUP);
const orderOf = (id) => Math.max(0, LINEUP.indexOf(id));

// Provider lineup: name, context, effort. Values from the provider/CLI catalogues.
const MODELS = {
  claude: [
    { n: "Claude Fable 5", ctx: "1M", eff: "low · medium · high · xhigh · max" },
    { n: "Claude Opus 5", ctx: "1M", eff: "low · medium · high · xhigh · max" },
    { n: "Claude Opus 4.8", ctx: "1M", eff: "low · medium · high · xhigh · max" },
    { n: "Claude Sonnet 5", ctx: "1M", eff: "low · medium · high · xhigh · max" },
    { n: "Claude Haiku 4.5", ctx: "200K", eff: "extended thinking · no effort" },
  ],
  codex: [
    { n: "GPT-5.6-Sol", ctx: "272K", eff: "low · medium · high · xhigh · max · ultra" },
    { n: "GPT-5.6-Terra", ctx: "272K", eff: "low · medium · high · xhigh · max · ultra" },
    { n: "GPT-5.6-Luna", ctx: "272K", eff: "low · medium · high · xhigh · max" },
    { n: "GPT-5.5", ctx: "272K", eff: "low · medium · high · xhigh" },
    { n: "GPT-5.4", ctx: "272K", eff: "low · medium · high · xhigh" },
    { n: "GPT-5.4-Mini", ctx: "272K", eff: "low · medium · high · xhigh" },
  ],
  zai: [
    { n: "GLM-5.2", ctx: "1M", eff: "high · max" },
    { n: "GLM-5.1", ctx: "200K", eff: "reasoning · no effort levels" },
    { n: "GLM-5-Turbo", ctx: "200K", eff: "reasoning · no effort levels" },
    { n: "GLM-5V-Turbo", ctx: "200K", eff: "reasoning · no effort levels" },
    { n: "GLM-4.7", ctx: "204.8K", eff: "reasoning · no effort levels" },
    { n: "GLM-4.5-Air", ctx: "131K", eff: "reasoning · no effort levels" },
  ],
  gemini: [
    { n: "Gemini 3.6 Flash", ctx: "1,048,576", eff: "dynamic thinking" },
    { n: "Gemini 3.5 Flash", ctx: "1,048,576", eff: "minimal · low · medium · high" },
    { n: "Gemini 3.1 Pro", ctx: "1,048,576", eff: "low · medium · high" },
  ],
  moonshot: [
    { n: "K3", ctx: "1,048,576", eff: "low · high · max" },
    { n: "K2.7 Coding", ctx: "262,144", eff: "always thinking" },
    { n: "K2.7 Coding Highspeed", ctx: "262,144", eff: "always thinking" },
  ],
};

function fmt(n, unit) {
  if (n == null) return "—";
  if (unit === "usd") return "$" + n.toFixed(2);
  if (unit === "cny") return "¥" + n.toFixed(2);
  if (unit === "percent") return n + "%";
  return n.toLocaleString("en-US");
}

const eur = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const exactTokens = new Intl.NumberFormat("en-US");
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const efficiencyFormula = "Cache read / (input + cache read + cache write). Measures context reuse, not answer quality.";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtEur(value) {
  if (value > 0 && value < 0.01) return "< " + eur.format(0.01);
  return eur.format(value || 0);
}

function fmtUsd(value) {
  if (value > 0 && value < 0.01) return "< " + usd.format(0.01);
  return usd.format(value || 0);
}

// The prices are quoted in USD and converted, so both currencies are exact
// figures the API already carries; neither is derived in the browser.
function fmtMoney(value) {
  return usageView.currency === "usd" ? fmtUsd(value) : fmtEur(value);
}

function rowCost(row) {
  return usageView.currency === "usd" ? row.costUsd : row.costEur;
}

function fmtToken(value) {
  return compactTokens.format(value || 0);
}

function tokenTitle(value) {
  return `${exactTokens.format(value || 0)} tokens`;
}

function fmtPct(value) {
  return value == null ? "—" : `${oneDecimal.format(value)}%`;
}

function usageAmountText(value) {
  return "≈ " + fmtMoney(value);
}

const USAGE_SORTS = {
  model: (row) => `${row.sourceName} ${row.model} ${row.effort}`.toLowerCase(),
  input: (row) => row.input || 0,
  cache: (row) => (row.cacheRead || 0) + (row.cacheWrite || 0),
  output: (row) => row.output || 0,
  efficiency: (row) => row.contextReusePct,
  cost: (row) => rowCost(row),
};

// Rows without a public price sort last in both directions: they carry no figure
// to rank, and burying them under a descending sort would hide them entirely.
function compareUsageRows(a, b) {
  const read = USAGE_SORTS[usageView.sortKey] ?? USAGE_SORTS.cost;
  const left = read(a);
  const right = read(b);
  if (left == null || right == null) {
    if (left == null && right == null) return 0;
    return left == null ? 1 : -1;
  }
  const order = typeof left === "string" ? left.localeCompare(right) : left - right;
  return usageView.sortDir === "asc" ? order : -order;
}

function visibleUsageRows(summary) {
  return (summary.rows || [])
    .filter((row) => row.total > 0)
    .filter((row) => usageView.source === "all" || row.source === usageView.source)
    .filter((row) => usageView.agent === "all" || row.agent === usageView.agent)
    .sort(compareUsageRows);
}

// Button and dialog headline must always show the same figure: once the table is
// narrowed by filters, both read the filtered sum, not the untouched grand total.
function usageFiltersActive() {
  return usageView.source !== "all" || usageView.agent !== "all";
}

function usageHeadlineTotal(summary) {
  if (usageFiltersActive()) {
    return visibleUsageRows(summary).reduce((sum, row) => sum + (rowCost(row) ?? 0), 0);
  }
  return usageView.currency === "usd" ? summary.estimatedCostUsd : summary.estimatedCostEur;
}

function usageSortHead(key, label, cls = "") {
  const active = usageView.sortKey === key;
  const ascending = usageView.sortDir === "asc";
  const arrow = active ? (ascending ? "▲" : "▼") : "";
  const next = active && !ascending ? "ascending" : "descending";
  // Read by a screen reader, so it says the direction this column is sorted in rather
  // than the one clicking it would apply.
  const sorted = active ? (ascending ? "ascending" : "descending") : "none";
  return `<th class="${cls}" aria-sort="${sorted}">
    <button type="button" class="usage-sort${active ? " is-active" : ""}" data-sort="${key}"
      title="Sort by ${escapeHtml(label)}, ${next}">${escapeHtml(label)}<span aria-hidden="true">${arrow}</span></button>
  </th>`;
}

// Animate from the number currently on screen, not from zero on every poll. A new
// total arriving mid-animation simply takes over from the interpolated value.
function animateUsageAmount(value) {
  const target = Math.max(0, Number(value) || 0);
  const startValue = hasUsageCost ? displayedUsageCost : 0;
  hasUsageCost = true;
  cancelAnimationFrame(usageAmountFrame);

  const finish = () => {
    displayedUsageCost = target;
    usageAmount.textContent = usageAmountText(target);
    usageAmount.setAttribute("aria-live", "polite");
    usageButton.setAttribute("aria-label", `Open local token usage, estimated ${fmtMoney(target)}`);
  };

  if (reduced.matches || usageAmountText(startValue) === usageAmountText(target)) {
    finish();
    return;
  }

  const startedAt = performance.now();
  const duration = 900;
  usageAmount.setAttribute("aria-live", "off");
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    displayedUsageCost = startValue + (target - startValue) * eased;
    usageAmount.textContent = usageAmountText(displayedUsageCost);
    if (progress < 1) usageAmountFrame = requestAnimationFrame(step);
    else finish();
  };
  usageAmountFrame = requestAnimationFrame(step);
}

function usageStat(label, value, cls = "") {
  return `<div class="usage-stat ${cls}" title="${escapeHtml(tokenTitle(value))}">
    <span>${escapeHtml(label)}</span><b>${escapeHtml(fmtToken(value))}</b>
  </div>`;
}

function usageEfficiencyStat(value) {
  const title = value == null ? "No input context recorded." : efficiencyFormula;
  return `<div class="usage-stat efficiency" title="${escapeHtml(title)}">
    <span>Token efficiency</span><b>${escapeHtml(fmtPct(value))}</b>
  </div>`;
}

function renderUsage(summary) {
  const usageShell = usageBody.closest(".usage-shell");
  const previousScroll = usageShell?.scrollTop ?? 0;
  const coverage = `${summary.pricingCoveragePct.toLocaleString("en-US", { maximumFractionDigits: 1 })}% priced`;
  const sourceChips = (summary.sources || []).map((source) => {
    const detail = source.message || (source.files != null ? `${source.files} local file${source.files === 1 ? "" : "s"}` : source.status);
    return `<span class="source-chip is-${escapeHtml(source.status)}" title="${escapeHtml(detail)}">
      ${escapeHtml(source.name)}
    </span>`;
  }).join("");
  const visibleRows = visibleUsageRows(summary);
  const rows = visibleRows.map((row) => {
    const cache = row.cacheWrite
      ? `${fmtToken(row.cacheRead)} / ${fmtToken(row.cacheWrite)}`
      : fmtToken(row.cacheRead);
    const cacheDetail = row.cacheWrite
      ? `${tokenTitle(row.cacheRead)} read, ${tokenTitle(row.cacheWrite)} written`
      : `${tokenTitle(row.cacheRead)} read`;
    const reasoning = row.reasoning
      ? `<small title="${escapeHtml(tokenTitle(row.reasoning))}">${escapeHtml(fmtToken(row.reasoning))} reasoning</small>`
      : "";
    const efficiency = row.contextReusePct == null
      ? `<span title="No input context recorded">—</span>`
      : `<span title="${escapeHtml(efficiencyFormula)}">${escapeHtml(fmtPct(row.contextReusePct))}</span>`;
    const cost = rowCost(row) == null
      ? `<span title="No public price found">—</span>`
      : `<span title="${escapeHtml(row.costBasis === "recorded" ? "Recorded by the CLI" : "Public API list price")}">${escapeHtml(fmtMoney(rowCost(row)))}</span>`;
    return `<tr>
      <td class="usage-model"><strong title="${escapeHtml(row.model)}">${escapeHtml(row.model)}</strong><span>${escapeHtml(row.sourceName)}</span></td>
      <td class="usage-mode"><span>${escapeHtml(row.effort)}</span><br /><span class="agent-pill${row.agent === "subagent" ? " is-subagent" : ""}">${escapeHtml(row.agent)}</span></td>
      <td title="${escapeHtml(tokenTitle(row.input))}">${escapeHtml(fmtToken(row.input))}</td>
      <td title="${escapeHtml(cacheDetail)}">${escapeHtml(cache)}</td>
      <td title="${escapeHtml(tokenTitle(row.output))}">${escapeHtml(fmtToken(row.output))}${reasoning}</td>
      <td class="usage-efficiency">${efficiency}</td>
      <td class="usage-cost">${cost}</td>
    </tr>`;
  }).join("");
  // Options come from the rows themselves, so a source that stops reporting
  // disappears from the filter instead of leaving a dead choice behind.
  const countedRows = (summary.rows || []).filter((row) => row.total > 0);
  const sourceNames = new Map(countedRows.map((row) => [row.source, row.sourceName]));
  const sourceOptions = [["all", "All sources"], ...sourceNames]
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${usageView.source === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const agentOptions = [["all", "All agents"], ["main", "main"], ["subagent", "subagent"]]
    .map(([value, label]) => `<option value="${value}"${usageView.agent === value ? " selected" : ""}>${label}</option>`)
    .join("");

  const unpriced = summary.unpricedModels?.length
    ? `<br /><b>Not priced:</b> ${escapeHtml(summary.unpricedModels.join(", "))}. Their tokens remain in every token total.`
    : "";

  // The headline follows the filters: once the table is narrowed to one source,
  // the number worth reading is what that source costs, not the untouched total.
  const filtered = usageFiltersActive();
  const total = usageHeadlineTotal(summary);

  usageBody.innerHTML = `
    <section class="usage-total">
      <div>
        <span class="usage-total-label">${filtered ? "Estimated API equivalent, filtered" : "Estimated API equivalent"}</span>
        <strong>${escapeHtml(fmtMoney(total))}</strong>
        <small>${escapeHtml(summary.pricing.note)}</small>
      </div>
      <span class="coverage-pill">${escapeHtml(coverage)}</span>
    </section>
    <div class="usage-stats">
      ${usageStat("All tokens", summary.tokens.total)}
      ${usageEfficiencyStat(summary.contextReusePct)}
      ${usageStat("Input", summary.tokens.input)}
      ${usageStat("Cache read", summary.tokens.cacheRead)}
      ${usageStat("Cache write", summary.tokens.cacheWrite)}
      ${usageStat("Output", summary.tokens.output)}
      ${usageStat("Reasoning", summary.tokens.reasoning, "reasoning")}
    </div>
    <div class="usage-section-head usage-coverage-head"><h3>Local coverage</h3><div class="source-chips">${sourceChips}</div></div>
    <div class="usage-section-head"><h3>Models &amp; effort</h3><span>reasoning is included in output</span></div>
    <div class="usage-controls">
      <div class="usage-currency" role="group" aria-label="Currency">
        <button type="button" data-currency="eur"${usageView.currency === "eur" ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>EUR</button>
        <button type="button" data-currency="usd"${usageView.currency === "usd" ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>USD</button>
      </div>
      <label class="usage-filter">Source
        <select data-filter="source">${sourceOptions}</select>
      </label>
      <label class="usage-filter">Agent
        <select data-filter="agent">${agentOptions}</select>
      </label>
      <span class="usage-rowcount">${visibleRows.length} of ${countedRows.length} rows</span>
    </div>
    <div class="usage-table-wrap">
      <table class="usage-table">
        <thead><tr>
          ${usageSortHead("model", "Model / source")}
          <th>Effort / agent</th>
          ${usageSortHead("input", "Input")}
          ${usageSortHead("cache", "Cache R / W")}
          ${usageSortHead("output", "Output")}
          ${usageSortHead("efficiency", "Efficiency", "usage-efficiency")}
          ${usageSortHead("cost", "Estimate", "usage-cost")}
        </tr></thead>
        <tbody>${rows || `<tr><td class="usage-model" colspan="7">${filtered ? "No rows match these filters." : "No local token records found."}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="usage-note">
      <b>Token efficiency</b> = cache read / (input + cache read + cache write). It measures context reuse only;
      it does not rate answer quality, and reasoning does not lower the score.<br />
      Current public API list prices as of <b>${escapeHtml(summary.pricing.asOf)}</b>.
      USD converted with the ECB reference rate <b>1 EUR = ${escapeHtml(summary.pricing.usdPerEur)} USD</b>
      (${escapeHtml(summary.pricing.fxAsOf)}). Subscription fees, taxes, discounts and provider credits are not included.${unpriced}
    </p>`;
  if (usageShell) usageShell.scrollTop = previousScroll;
}

async function loadUsageSummary() {
  if (usageLoad) return usageLoad;
  const isInitialLoad = usageSignature == null;
  lastUsageAttemptAt = Date.now();
  if (isInitialLoad) usageButton.classList.add("is-loading");
  usageLoad = (async () => {
    try {
      const summary = await loadUsage();
      dispatchEvent(new CustomEvent("llmquota:usage", { detail: summary }));
      lastUsageSummary = summary;
      const nextSignature = dataSignature(summary);
      if (nextSignature !== usageSignature) {
        renderUsage(summary);
        usageSignature = nextSignature;
      }
      animateUsageAmount(usageHeadlineTotal(summary));
      usageButton.title = `Open local token usage · ${summary.pricingCoveragePct}% priced${usageFiltersActive() ? " · filters active" : ""}`;
      setLiveResult("usage", null);
    } catch (error) {
      setLiveResult("usage", error);
      // Keep the last good total and dialog visible through a transient failure.
      if (usageSignature == null) {
        usageAmount.textContent = usageView.currency === "usd" ? "$ ?" : "€ ?";
        usageBody.innerHTML = `<div class="usage-loading usage-error"><div>Could not read local token usage. Retrying automatically.<br /><small>${escapeHtml(error instanceof Error ? error.message : "error")}</small></div></div>`;
      }
    } finally {
      usageButton.classList.remove("is-loading");
      usageLoad = undefined;
    }
  })();
  return usageLoad;
}

// "in 4h 55m" / "in 39m" — always relative, because the whole product is about
// how much time is left, never about wall-clock instants.
function humanGap(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  const d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

function resetText(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  return diff <= 0 ? "reset due" : "resets in " + humanGap(diff);
}

function donutHtml(remainingPct) {
  const C = 113.1; // 2 * pi * r(18)
  // The card answers the dashboard's primary question: how much quota remains.
  // Keep a minimum arc so an exhausted allowance still reads as a measured state.
  const off = (C * (1 - Math.max(remainingPct, 1.6) / 100)).toFixed(1);
  const col = `hsl(${Math.round(remainingPct * 1.4)} 75% 55%)`;
  return `<svg class="donut" viewBox="0 0 44 44" style="--off:${off};--c:${col}" aria-hidden="true">
    <circle class="track" cx="22" cy="22" r="18"></circle>
    <circle class="arc" cx="22" cy="22" r="18"></circle>
    <text class="pct" x="22" y="26" transform="rotate(90 22 22)" data-v="${remainingPct}">0%</text>
  </svg>`;
}

function usedPct(m) {
  if (m.limit && m.used != null) return Math.min(100, Math.round((m.used / m.limit) * 100));
  if (m.unit === "percent" && m.used != null) return m.used;
  return null;
}

// `index` ties the rendered countdown back to the metric it belongs to. Matching the
// two by DOM position instead would drift: a metric carrying a resetAt does not always
// render a .reset node (see expiredUnused below), so a gap would shift every later row
// onto the wrong metric.
/**
 * What the right-hand side of a metric row says, in the order the sources can answer.
 *
 * A provider that reports what is left says it outright; one that reports a percentage
 * used has the remainder computed for it; one that reports only a raw count shows the
 * count. Nothing left to say is an empty string rather than a zero, which would read as
 * a quota that is gone.
 */
function metricValueLabel(m, remainingPct) {
  if (m.remaining != null) return fmt(m.remaining, m.unit) + " left";
  if (remainingPct != null) return remainingPct + "% left";
  if (m.used != null) return fmt(m.used, m.unit);
  return "";
}

function metricHtml(m, index) {
  const used = usedPct(m);
  const remainingPct = used == null ? null : Math.max(0, 100 - used);
  const cls = used == null ? "" : used >= 90 ? "crit" : used >= 70 ? "hot" : "";
  // Say what the number means. "0% / 100%" told the user nothing.
  const right = metricValueLabel(m, remainingPct);
  const expiredUnused = remainingPct === 100 && m.resetAt && new Date(m.resetAt).getTime() <= Date.now();
  const reset = m.resetAt && !expiredUnused
    ? `<div class="reset" data-reset="${index}">${resetText(m.resetAt)}</div>`
    : "";
  const head = `<div class="metric-head"><span>${escapeHtml(m.label)}</span><span class="val">${right}</span></div>`;
  if (remainingPct != null) {
    return `<div class="metric">${donutHtml(remainingPct)}<div class="metric-body">${head}${reset}</div></div>`;
  }
  // No percentage to plot (a currency balance, say). Hold the donut column open anyway
  // so every label in the card starts on the same vertical line.
  return `<div class="metric"><div class="donut-gap" aria-hidden="true"></div>
    <div class="metric-body">${head}
    ${m.used != null ? `<div class="bar ${cls}"><i data-w="0"></i></div>` : ""}${reset}</div></div>`;
}

function cardHtml(p) {
  const st = Object.hasOwn(STATUS_LABEL, p.status) ? p.status : "error";
  const id = escapeHtml(p.id);
  const metrics = (p.metrics || []).map(metricHtml).join("");
  const models = (MODELS[p.id] || [])
    .map((m) => `<div class="mrow"><span>${escapeHtml(m.n)}</span><span class="mi">${escapeHtml(m.ctx)} · ${escapeHtml(m.eff)}</span></div>`)
    .join("");
  const source = p.sourceLabel || p.authSource;
  const context = [p.plan ? `plan: ${p.plan}` : "", source ? `via ${source}` : ""].filter(Boolean).join(" · ");
  return `
    <div class="card-top">
      ${markHtml(p.id, "avatar")}
      <div class="titles">
        <h2 class="name">${escapeHtml(p.name)}</h2>
        ${context ? `<div class="plan"${p.sourceUpdatedAt ? ` title="Official source updated ${escapeHtml(p.sourceUpdatedAt)}"` : ""}>${escapeHtml(context)}</div>` : ""}
      </div>
      <span class="badge b-${st}">${STATUS_LABEL[st] || st}</span>
    </div>
    ${metrics}
    ${models ? `<details class="models"><summary>Models · context · effort</summary>${models}<div class="mnote">indicative values</div></details>` : ""}
    ${p.message ? `<div class="msg">${escapeHtml(p.message)}</div>` : ""}
    ${p.setupUrl ? `<button class="integration-btn" data-setup="${escapeHtml(p.setupUrl)}" data-provider="${id}">${escapeHtml(p.setupLabel || "Enable official integration")}</button>` : ""}
    ${p.needsKey ? `<div class="keyrow"><input type="password" placeholder="Paste API key…" aria-label="API key ${escapeHtml(p.name)}" data-key="${id}" /><button data-save="${id}">Save</button></div>` : ""}
    <div class="card-foot">
      <a href="${escapeHtml(p.consoleUrl)}" target="_blank" rel="noreferrer">Open console ↗</a>
      ${p.teardownUrl ? `<button class="mini" data-teardown="${escapeHtml(p.teardownUrl)}" data-provider="${id}">${escapeHtml(p.teardownLabel || "Disable integration")}</button>` : ""}
    </div>`;
}

// Adopts the static skeleton already in the HTML when there is one, so the card
// keeps its place and its height instead of being appended after first paint.
function cardFor(id) {
  let el = cards.get(id);
  if (!el) {
    el = grid.querySelector(`.card[data-provider="${CSS.escape(id)}"]`);
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "card";
    el.dataset.provider = id;
    el.style.setProperty("--d", orderOf(id) * 70 + "ms");
    el.style.setProperty("--brand", brand(id).b1);
    grid.appendChild(el);
  }
  cards.set(id, el);
  return el;
}

function render(p) {
  if (!VISIBLE_PROVIDERS.has(p.id)) return;
  const el = cardFor(p.id);
  const nextSignature = dataSignature(p);
  const firstRender = !providerSignatures.has(p.id);
  const modelsWereOpen = el.querySelector(".models")?.open ?? false;
  latest.set(p.id, p);

  // A fresh updatedAt timestamp alone must not replace the card. Leaving the DOM
  // in place preserves open details, focus and hover without a visible refresh.
  if (nextSignature === providerSignatures.get(p.id)) return false;

  el.classList.remove("is-skeleton");
  el.innerHTML = cardHtml(p);
  if (modelsWereOpen) el.querySelector(".models")?.setAttribute("open", "");
  providerSignatures.set(p.id, nextSignature);
  animate(el, firstRender);
  return true;
}

// Count-up donut percentages, grow bars from zero. Under reduced motion the same
// values are written straight to their final state — informative, just still.
function animate(el, withMotion = true) {
  const bars = el.querySelectorAll(".bar > i[data-w]");
  const pcts = el.querySelectorAll(".donut .pct[data-v]");
  if (!withMotion || reduced.matches) {
    if (!withMotion) {
      for (const arc of el.querySelectorAll(".donut .arc")) arc.style.animation = "none";
    }
    for (const i of bars) i.style.transform = `scaleX(${Number(i.dataset.w) / 100})`;
    for (const t of pcts) t.textContent = t.dataset.v + "%";
    return;
  }
  requestAnimationFrame(() => {
    for (const i of bars) i.style.transform = `scaleX(${Number(i.dataset.w) / 100})`;
    for (const t of pcts) {
      const target = Number(t.dataset.v);
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 1000);
        t.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + "%";
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  });
}

/* ============================================================================
   THE HORIZON
   Every currently measurable provider reset, on one non-linear time axis.
   x = sqrt(hours / 168) so the next few hours — the part you can still act on —
   get most of the width, while weekly windows still have a place to sit.
   Stem height = how much of that window you have already burnt.
   ========================================================================== */
const HZ_SPAN_H = 168; // seven days
const hzRail = document.getElementById("hzRail");
const hzNext = document.getElementById("hzNext");
const hzText = document.getElementById("hzText");
const hzTip = document.getElementById("hzTip");

const hzPos = (h) => Math.sqrt(Math.min(Math.max(h, 0), HZ_SPAN_H) / HZ_SPAN_H);
const HZ_TICKS_FULL = [
  { h: 0, label: "NOW" },
  { h: 1, label: "1h" },
  { h: 6, label: "6h" },
  { h: 24, label: "24h" },
  { h: 72, label: "3d" },
  { h: 168, label: "7d" },
];
// A narrow rail cannot carry six labels without them colliding, so it carries
// three. The axis is unchanged — only how densely it is annotated.
const HZ_TICKS_NARROW = [
  { h: 0, label: "NOW" },
  { h: 6, label: "6h" },
  { h: 168, label: "7d" },
];
const hzTicks = () =>
  hzRail.getBoundingClientRect().width < 520 ? HZ_TICKS_NARROW : HZ_TICKS_FULL;
const horizonMarks = new Map();
let horizonTickSignature = "";

function horizonEvents() {
  const now = Date.now();
  const out = [];
  for (const p of latest.values()) {
    for (const [index, m] of (p.metrics || []).entries()) {
      if (!m.resetAt) continue;
      const ms = new Date(m.resetAt).getTime() - now;
      if (ms <= 0 || ms > HZ_SPAN_H * 3.6e6) continue;
      out.push({
        key: `${p.id}\u0000${index}\u0000${m.label}`,
        id: p.id,
        provider: p.name,
        label: m.label,
        ms,
        pct: usedPct(m) ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function drawHorizon() {
  const events = horizonEvents();
  const ticks = hzTicks();
  const nextTickSignature = ticks.map((tick) => `${tick.h}:${tick.label}`).join("|");
  if (nextTickSignature !== horizonTickSignature) {
    hzRail.querySelectorAll(".hz-tick").forEach((node) => node.remove());
    ticks.forEach((tickData, index) => {
      const tick = document.createElement("div");
      // Labels are centred on their tick; the first one would hang off the left edge,
      // so it is left-aligned instead.
      tick.className = "hz-tick" + (index === 0 ? " is-first" : "");
      tick.style.left = hzPos(tickData.h) * 100 + "%";
      tick.innerHTML = `<span>${tickData.label}</span>`;
      hzRail.append(tick);
    });
    horizonTickSignature = nextTickSignature;
  }

  const liveKeys = new Set();
  events.forEach((e, i) => {
    liveKeys.add(e.key);
    let b = horizonMarks.get(e.key);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "hz-mark";
      b.innerHTML = `<span class="hz-stem"></span>${markHtml(e.id, "hz-dot")}`;
      hzRail.append(b);
      horizonMarks.set(e.key, b);
    }
    b.classList.toggle("imminent", i === 0);
    b.style.left = hzPos(e.ms / 3.6e6) * 100 + "%";
    b.style.setProperty("--c", brand(e.id).b1);
    b.style.setProperty("--h", 22 + e.pct * 0.6 + "%");
    b.style.setProperty("--d", 120 + i * 55 + "ms");
    b.dataset.provider = e.id;
    b.dataset.tip = `${e.provider} · ${e.label}|${e.pct}% used|in ${humanGap(e.ms)}`;
    b.setAttribute(
      "aria-label",
      `${e.provider}, ${e.label}: resets in ${humanGap(e.ms)}, ${e.pct}% used`,
    );
  });
  for (const [key, mark] of horizonMarks) {
    if (liveKeys.has(key)) continue;
    mark.remove();
    horizonMarks.delete(key);
    hzTip.classList.remove("on");
  }

  if (!events.length) {
    hzNext.textContent = "No resets in the next 7 days.";
    hzText.textContent = "";
    return;
  }
  const n = events[0];
  hzNext.innerHTML = `next reset · <b>${escapeHtml(n.provider)}</b> ${escapeHtml(n.label)} <span class="cd">in ${humanGap(n.ms)}</span>`;
  hzText.textContent =
    `${events.length} resets in the next 7 days. ` +
    events.map((e) => `${e.provider} ${e.label} in ${humanGap(e.ms)}`).join("; ") + ".";
}

// Marker ⇄ card. Pointing at either end lights the other: that is the whole idea
// of the horizon made touchable.
function link(id, on) {
  cards.get(id)?.classList.toggle("linked", on);
  for (const m of hzRail.querySelectorAll(`.hz-mark[data-provider="${CSS.escape(id)}"]`)) {
    m.classList.toggle("linked", on);
  }
}

function showTip(markEl) {
  const [title, use, when] = markEl.dataset.tip.split("|");
  hzTip.innerHTML = `<div>${escapeHtml(title)}</div><div class="tp">${escapeHtml(use)} · <span class="tc">${escapeHtml(when)}</span></div>`;
  const r = markEl.getBoundingClientRect();
  hzTip.style.left = r.left + r.width / 2 + "px";
  hzTip.style.top = r.top - 10 + "px";
  hzTip.classList.add("on");
}

function markEnter(el) {
  link(el.dataset.provider, true);
  showTip(el);
}
function markLeave(el) {
  link(el.dataset.provider, false);
  hzTip.classList.remove("on");
}

hzRail.addEventListener("pointerover", (e) => {
  const m = e.target.closest(".hz-mark");
  if (m) markEnter(m);
});
hzRail.addEventListener("pointerout", (e) => {
  const m = e.target.closest(".hz-mark");
  if (m && !m.contains(e.relatedTarget)) markLeave(m);
});
hzRail.addEventListener("focusin", (e) => {
  const m = e.target.closest(".hz-mark");
  if (m) markEnter(m);
});
hzRail.addEventListener("focusout", (e) => {
  const m = e.target.closest(".hz-mark");
  if (m) markLeave(m);
});
hzRail.addEventListener("click", (e) => {
  const m = e.target.closest(".hz-mark");
  if (!m) return;
  cards.get(m.dataset.provider)?.scrollIntoView({
    behavior: reduced.matches ? "auto" : "smooth",
    block: "nearest",
  });
});

// Tick density depends on the rail's width, so it is re-decided on resize.
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawHorizon, 150);
});

grid.addEventListener("pointerover", (e) => {
  const c = e.target.closest(".card");
  if (c?.dataset.provider) link(c.dataset.provider, true);
});
grid.addEventListener("pointerout", (e) => {
  const c = e.target.closest(".card");
  if (c?.dataset.provider && !c.contains(e.relatedTarget)) link(c.dataset.provider, false);
});

// Countdowns are the content here, so they cannot go stale while the tab is open.
setInterval(() => {
  if (document.hidden || !latest.size) return;
  drawHorizon();
  for (const [id, p] of latest) {
    const card = cards.get(id);
    if (!card) continue;
    for (const node of card.querySelectorAll(".reset[data-reset]")) {
      const metric = (p.metrics || [])[Number(node.dataset.reset)];
      if (metric?.resetAt) node.textContent = resetText(metric.resetAt);
    }
  }
}, 30000);

/* ---------------------------------------------------------------- data ---- */

async function loadAll() {
  if (quotaLoad) return quotaLoad;
  lastQuotaAttemptAt = Date.now();
  quotaLoad = (async () => {
    try {
      const providers = (await loadQuota()).filter((provider) => VISIBLE_PROVIDERS.has(provider.id));
      let horizonChanged = false;
      for (const provider of providers) horizonChanged = render(provider) || horizonChanged;

      const live = new Set(providers.map((provider) => provider.id));
      for (const [id, el] of cards) {
        if (live.has(id)) continue;
        el.remove();
        cards.delete(id);
        latest.delete(id);
        providerSignatures.delete(id);
        horizonChanged = true;
      }
      if (horizonChanged) drawHorizon();
      setLiveResult("quotas", null);
    } catch (error) {
      setLiveResult("quotas", error);
      // An initial connection failure should not leave an endless shimmer behind.
      // The same cards are reused automatically as soon as a retry succeeds.
      if (!latest.size) {
        for (const el of grid.querySelectorAll(".card[data-provider]")) {
          cards.set(el.dataset.provider, el);
          el.classList.remove("is-skeleton");
          el.innerHTML = `<div class="msg request-error">Could not load quotas. Retrying automatically.<br /><small>${escapeHtml(error instanceof Error ? error.message : "error")}</small></div>`;
        }
      }
    } finally {
      quotaLoad = undefined;
    }
  })();
  return quotaLoad;
}

async function saveKey(id) {
  const input = document.querySelector(`input[data-key="${id}"]`);
  const key = input?.value ?? "";
  const btn = document.querySelector(`button[data-save="${id}"]`);
  if (btn) btn.textContent = "…";
  try {
    if (render(await saveProviderKey(id, key))) drawHorizon();
  } catch (error) {
    if (btn) btn.textContent = "Retry";
    showError(id, error);
  }
}

function showError(id, error) {
  const card = cards.get(id);
  if (!card) return;
  let message = card.querySelector(".request-error");
  if (!message) {
    message = document.createElement("div");
    message.className = "msg request-error";
    const footer = card.querySelector(".card-foot");
    if (footer) footer.before(message);
    else card.append(message);
  }
  message.textContent = `Request error: ${error instanceof Error ? error.message : "error"}`;
}

// A logo that fails to decode drops out and reveals the drawn glyph beneath it.
for (const root of [grid, hzRail]) {
  root.addEventListener(
    "error",
    (e) => {
      if (e.target instanceof HTMLImageElement) {
        e.target.closest(".has-logo")?.classList.remove("has-logo");
        e.target.remove();
      }
    },
    true,
  );
}

grid.addEventListener("click", (e) => {
  const t = e.target.closest("[data-save],[data-setup],[data-teardown]");
  if (!t) return;
  if (t.dataset.save) saveKey(t.dataset.save);
  if (t.dataset.setup) setupOfficialBridge(t);
  if (t.dataset.teardown) teardownOfficialBridge(t);
});

async function setupOfficialBridge(btn) {
  const provider = btn.dataset.provider;
  btn.disabled = true;
  btn.textContent = "Installing…";
  try {
    if (render(await installOfficialBridge(provider))) drawHorizon();
  } catch (error) {
    btn.disabled = false;
    btn.textContent = `Retry: ${error instanceof Error ? error.message : "error"}`;
  }
}

async function teardownOfficialBridge(btn) {
  const provider = btn.dataset.provider;
  btn.disabled = true;
  btn.textContent = "Restoring…";
  try {
    if (render(await removeOfficialBridge(provider))) drawHorizon();
  } catch (error) {
    btn.disabled = false;
    btn.textContent = `Retry: ${error instanceof Error ? error.message : "error"}`;
  }
}

// The body is rebuilt on every poll, so the controls are handled by delegation
// and re-rendered from usageView rather than read back out of the DOM.
function applyUsageView() {
  saveUsageView();
  if (lastUsageSummary) {
    renderUsage(lastUsageSummary);
    animateUsageAmount(usageHeadlineTotal(lastUsageSummary));
  }
}

usageBody.addEventListener("click", (event) => {
  const currency = event.target.closest("[data-currency]");
  if (currency) {
    usageView.currency = currency.dataset.currency;
    applyUsageView();
    return;
  }
  const sort = event.target.closest("[data-sort]");
  if (sort) {
    const key = sort.dataset.sort;
    // Re-picking the active column flips it; a new column starts descending,
    // which is what "who costs most" wants on every numeric column.
    if (usageView.sortKey === key) usageView.sortDir = usageView.sortDir === "desc" ? "asc" : "desc";
    else { usageView.sortKey = key; usageView.sortDir = key === "model" ? "asc" : "desc"; }
    applyUsageView();
  }
});

usageBody.addEventListener("change", (event) => {
  const filter = event.target.closest("[data-filter]");
  if (!filter) return;
  usageView[filter.dataset.filter] = filter.value;
  applyUsageView();
  pushUsageViewToServer();
});

usageButton.addEventListener("click", () => usageDialog.showModal());
document.getElementById("closeUsage").addEventListener("click", () => usageDialog.close());
usageDialog.addEventListener("click", (event) => {
  if (event.target === usageDialog) usageDialog.close();
});

function refreshDueData(force = false) {
  if (document.hidden) return;
  const now = Date.now();
  if (force || now - lastQuotaAttemptAt >= QUOTA_REFRESH_MS) loadAll();
  if (force || now - lastUsageAttemptAt >= USAGE_REFRESH_MS) loadUsageSummary();
}

// Timers do no work in a background tab. Returning to the dashboard catches up
// immediately instead of waiting for the next interval boundary.
setInterval(() => refreshDueData(), USAGE_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDueData();
});
addEventListener("focus", () => refreshDueData());
addEventListener("online", () => refreshDueData(true));

// The browser delegates the protocol to the desktop; the embedded webview uses the
// shell bridge so it does not replace the dashboard with its own URI error page.
mountWidgetButton(document.getElementById("openWidget"), desktopBridge, window);

/* ---------------------------------------------------------------- chrome ---- */

// Split hero title into per-char spans for the staggered reveal, keeping one
// readable accessible name instead of nine separate letters.
const titleEl = document.getElementById("title");
if (titleEl) {
  const text = titleEl.textContent;
  titleEl.setAttribute("aria-label", text);

  // Built through the DOM rather than by concatenating innerHTML. The text is this
  // page's own heading and carries no user input today, but the shape of the code is
  // what a reader copies: a template string that interpolates DOM text into markup is
  // the exact pattern that becomes an injection the day the source changes.
  const spans = document.createDocumentFragment();
  [...text].forEach((c, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.setAttribute("aria-hidden", "true");
    span.style.setProperty("--i", String(i));
    // A non-breaking space, so a space keeps its width once each character is a span.
    span.textContent = c === " " ? " " : c;
    spans.append(span);
  });
  titleEl.replaceChildren(spans);
}

// Custom cursor: dot tracks instantly, ring lerps behind.
//
// One rAF frame owns every pointer-driven write on the page — the cursor dot, the ring,
// and the card spotlight. A high-polling mouse fires `pointermove` several times per
// frame, so handling it inline meant a style write (and a forced layout read, for the
// spotlight's getBoundingClientRect) per *event* rather than per *frame*.
//
// The loop also stops. It used to call itself unconditionally: 60 frames a second for
// the whole session, still writing a transform long after the ring had caught up with a
// cursor that was not moving.
const cur = document.querySelector(".cur");
const ring = document.querySelector(".cur-ring");
const fine = matchMedia("(pointer: fine)").matches;

let px = -100, py = -100;      // latest pointer position
let rx = -100, ry = -100;      // ring position, chasing it
let spotCard = null;           // card under the pointer, if any
let queued = false;

function frame() {
  queued = false;

  if (cur) cur.style.transform = `translate(${px - 3.5}px, ${py - 3.5}px)`;

  if (ring) {
    // The trailing ring is the motion; under reduced motion it snaps instead, which
    // also means the loop converges in one frame rather than a dozen.
    const k = reduced.matches ? 1 : 0.16;
    rx += (px - rx) * k;
    ry += (py - ry) * k;
    ring.style.transform = `translate(${rx - 27}px, ${ry - 27}px)`;
  }

  if (spotCard) {
    const r = spotCard.getBoundingClientRect();
    spotCard.style.setProperty("--mx", ((px - r.left) / r.width) * 100 + "%");
    spotCard.style.setProperty("--my", ((py - r.top) / r.height) * 100 + "%");
    spotCard = null;
  }

  // Keep going only while the ring still has ground to cover. Sub-pixel is done.
  if (Math.abs(px - rx) > 0.1 || Math.abs(py - ry) > 0.1) schedule();
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(frame);
}

if (fine) {
  addEventListener("pointermove", (e) => {
    px = e.clientX;
    py = e.clientY;
    // Delegated, so it survives the innerHTML re-render that rebuilds the cards.
    spotCard = e.target.closest?.(".card") ?? null;
    schedule();
  }, { passive: true });

  addEventListener("pointerover", (e) => {
    ring?.classList.toggle("on", !!e.target.closest("button, a, summary, input, .card"));
  });
}

loadAll();
syncUsageViewFromServer();
loadUsageSummary();
mountGitHubContributionPrototype();
