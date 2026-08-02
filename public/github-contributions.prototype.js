/**
 * PROTOTYPE — three developer-activity card variants on the existing dashboard,
 * switchable with ?variant=A|B|C. Rewrite only the selected design for main.
 */
import { loadGitHubContributions, loadUsage } from "./api.js";
import { dataSignature, escapeHtml } from "./ui.js";

const variants = {
  A: "Token spend",
  B: "Dual calendar",
  C: "Monthly correlation",
};
const integers = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const euro = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const CONTRIBUTION_REFRESH_MS = 10 * 60_000;
let contributionData;
let contributionSignature;
let contributionLoad;
let lastContributionAttemptAt = 0;
let usageData;
let usageSignature;
let activityView = "usage";

function currentVariant() {
  const candidate = new URLSearchParams(location.search).get("variant")?.toUpperCase();
  return Object.hasOwn(variants, candidate) ? candidate : "A";
}

function stat(label, value, green = false) {
  return `<div class="gh-stat${green ? " is-green" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(integers.format(value || 0))}</b></div>`;
}

function statText(label, value, green = false, title = "") {
  return `<div class="gh-stat${green ? " is-green" : ""}"><span>${escapeHtml(label)}</span><b${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(value)}</b></div>`;
}

function fmtEur(value) {
  return value > 0 && value < 0.01 ? `< ${euro.format(0.01)}` : euro.format(value || 0);
}

function utcKey(date) {
  return date.toISOString().slice(0, 10);
}

function buildUsageCalendar(summary) {
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(todayUtc);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 52 * 7);
  const byDate = new Map((summary?.daily || []).map((day) => [day.date, day]));
  const flat = [];

  for (let offset = 0; offset < 53 * 7; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    const key = utcKey(date);
    flat.push({
      date: key,
      weekday: date.getUTCDay(),
      future: date > todayUtc,
      usage: byDate.get(key),
    });
  }

  const visible = flat.filter((day) => !day.future && day.usage?.tokens?.total > 0);
  const maximum = Math.max(1, ...visible.map((day) => Number(day.usage.tokens.total) || 0));
  for (const day of flat) {
    const tokens = Number(day.usage?.tokens?.total) || 0;
    day.level = tokens ? Math.max(1, Math.ceil((Math.log1p(tokens) / Math.log1p(maximum)) * 4)) : 0;
  }

  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let costEur = 0;
  let calls = 0;
  let pricedTokens = 0;
  const sources = new Set();
  for (const day of visible) {
    for (const key of Object.keys(totals)) totals[key] += Number(day.usage.tokens[key]) || 0;
    costEur += Number(day.usage.estimatedCostEur) || 0;
    calls += Number(day.usage.calls) || 0;
    pricedTokens += (Number(day.usage.pricingCoveragePct) || 0) / 100 * (Number(day.usage.tokens.total) || 0);
    for (const source of day.usage.sources || []) sources.add(source);
  }
  const context = totals.input + totals.cacheRead + totals.cacheWrite;
  const busiest = visible.reduce((winner, day) => !winner || day.usage.tokens.total > winner.usage.tokens.total ? day : winner, null);

  return {
    weeks: Array.from({ length: 53 }, (_, index) => ({ days: flat.slice(index * 7, index * 7 + 7) })),
    totalTokens: totals.total,
    totals,
    costEur,
    calls,
    activeDays: visible.length,
    busiest,
    contextReusePct: context ? Math.round((totals.cacheRead / context) * 1_000) / 10 : null,
    pricingCoveragePct: totals.total ? Math.round((pricedTokens / totals.total) * 1_000) / 10 : 0,
    sources: [...sources],
  };
}

function dayCell(day) {
  const count = Number(day.count) || 0;
  const noun = count === 1 ? "contribution" : "contributions";
  return `<span class="gh-day l${Math.max(0, Math.min(4, Number(day.level) || 0))}" title="${escapeHtml(`${day.date} · ${count} ${noun}`)}"></span>`;
}

function monthLabels(data) {
  const labels = (data.months || []).map((month) => {
    const key = String(month.firstDay).slice(0, 7);
    const index = data.weeks.findIndex((week) => week.days.some((day) => day.date.startsWith(key)));
    return index < 0 ? null : { index, label: String(month.name).slice(0, 3) };
  }).filter(Boolean).filter((item, index, all) => all.findIndex((other) => other.index === item.index) === index);

  return labels.map((item, index) => {
    const next = labels[index + 1]?.index ?? data.weeks.length;
    return `<span style="grid-column:${item.index + 1}/span ${Math.max(1, next - item.index)}">${escapeHtml(item.label)}</span>`;
  }).join("");
}

function legend() {
  return `<div class="gh-legend"><span>Less</span>${[0, 1, 2, 3, 4].map((level) => `<i class="gh-day l${level}"></i>`).join("")}<span>More</span></div>`;
}

function heatmap(data, showLegend = true) {
  const weeks = data.weeks.map((week) => `<div class="gh-week">${week.days.map((day) => dayCell(day)).join("")}</div>`).join("");
  return `<div class="gh-heatmap-scroll" role="img" aria-label="${escapeHtml(`${data.total} GitHub contributions in the last year`)}">
    <div class="gh-heatmap" style="--week-count:${data.weeks.length}">
      <div class="gh-month-labels">${monthLabels(data)}</div>
      <div class="gh-weeks">${weeks}</div>
      ${showLegend ? legend() : ""}
    </div>
  </div>`;
}

function usageMonthLabels(calendar) {
  const labels = [];
  calendar.weeks.forEach((week, weekIndex) => {
    const first = week.days.find((day) => day.date.endsWith("-01"));
    if (!first) return;
    const label = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" })
      .format(new Date(`${first.date}T12:00:00Z`));
    labels.push({ index: weekIndex, label });
  });
  return labels.map((item, index) => {
    const next = labels[index + 1]?.index ?? calendar.weeks.length;
    return `<span style="grid-column:${item.index + 1}/span ${Math.max(1, next - item.index)}">${escapeHtml(item.label)}</span>`;
  }).join("");
}

function usageDayCell(day) {
  if (day.future) return `<span class="gh-day usage-day is-future"></span>`;
  const usage = day.usage;
  const tokens = Number(usage?.tokens?.total) || 0;
  const title = tokens
    ? `${day.date} · ${fmtEur(Number(usage.estimatedCostEur) || 0)} API equivalent · ${integers.format(tokens)} tokens · ${usage.calls || 0} calls · ${usage.pricingCoveragePct || 0}% priced`
    : `${day.date} · no recorded token use`;
  return `<span class="gh-day usage-day l${day.level || 0}" title="${escapeHtml(title)}"></span>`;
}

function usageLegend() {
  return `<div class="gh-legend usage-legend"><span>Tokens</span>${[0, 1, 2, 3, 4].map((level) => `<i class="gh-day usage-day l${level}"></i>`).join("")}</div>`;
}

function usageHeatmap(calendar, showLegend = true) {
  const weeks = calendar.weeks.map((week) => `<div class="gh-week">${week.days.map(usageDayCell).join("")}</div>`).join("");
  return `<div class="gh-heatmap-scroll" role="img" aria-label="${escapeHtml(`${integers.format(calendar.totalTokens)} locally recorded tokens over ${calendar.activeDays} active days`)}">
    <div class="gh-heatmap usage-heatmap" style="--week-count:${calendar.weeks.length}">
      <div class="gh-month-labels">${usageMonthLabels(calendar)}</div>
      <div class="gh-weeks">${weeks}</div>
      ${showLegend ? usageLegend() : ""}
    </div>
  </div>`;
}

function usageSourceLine(summary) {
  const names = (summary?.sources || [])
    .filter((source) => source.status === "ok")
    .map((source) => source.name)
    .filter(Boolean);
  return names.length ? names.join(" · ") : "No local token sources found";
}

function usageHeader(title, summary, kicker = "Local token ledger") {
  return `<div class="gh-head">
    <div><span class="gh-kicker usage-kicker">${escapeHtml(kicker)}</span><h2 class="gh-title">${escapeHtml(title)}</h2><span class="gh-account">${escapeHtml(usageSourceLine(summary))}</span></div>
    <div class="gh-head-actions"><a class="gh-profile" href="#usageDialog" data-open-usage>Ledger</a><button class="gh-view-toggle" type="button" data-activity-view="github">GitHub</button></div>
  </div>`;
}

function githubToggleHeader(data) {
  const account = data?.status === "ok" ? `${data.name || data.login} · @${data.login}` : "GitHub activity unavailable";
  return `<div class="gh-head">
    <div><span class="gh-kicker">GitHub · authenticated viewer</span><h2 class="gh-title">Contribution calendar</h2><span class="gh-account">${escapeHtml(account)}</span></div>
    <div class="gh-head-actions">${data?.status === "ok" ? `<a class="gh-profile" href="${escapeHtml(data.profileUrl)}" target="_blank" rel="noreferrer">Profile ↗</a>` : ""}<button class="gh-view-toggle" type="button" data-activity-view="usage">Token spend</button></div>
  </div>`;
}

function dualHeader(data) {
  const account = data?.status === "ok"
    ? `${data.name || data.login} · @${data.login}`
    : "Local usage · GitHub unavailable";
  return `<div class="gh-head">
    <div><span class="gh-kicker dual-kicker">Local usage + GitHub</span><h2 class="gh-title">Developer activity</h2><span class="gh-account">${escapeHtml(account)}</span></div>
    <a class="gh-profile" href="#usageDialog" data-open-usage>Full ledger ↗</a>
  </div>`;
}

function usageBreakdown(calendar) {
  const items = [
    [calendar.totals.input, "input"],
    [calendar.totals.cacheRead, "cache"],
    [calendar.totals.output, "output"],
    [calendar.totals.reasoning, "reasoning"],
  ];
  return `<p class="gh-breakdown usage-breakdown" aria-label="Token breakdown">${items.map(([value, label]) => `<span><b title="${escapeHtml(`${integers.format(value)} tokens`)}">${escapeHtml(compact.format(value || 0))}</b> ${label}</span>`).join("")}</p>`;
}

function breakdownLine(data) {
  const items = [
    [data.breakdown.commits, "commits"],
    [data.breakdown.pullRequests, "PRs"],
    [data.breakdown.issues, "issues"],
    [data.breakdown.reviews, "reviews"],
  ];
  return `<p class="gh-breakdown" aria-label="Contribution breakdown">${items.map(([value, label]) => `<span><b>${escapeHtml(integers.format(value || 0))}</b> ${label}</span>`).join("")}</p>`;
}

function variantAGithub(data) {
  const available = data?.status === "ok";
  return `<article class="gh-card gh-card-a" data-github-variant="A" data-activity-view="github">
    ${githubToggleHeader(data)}
    ${available ? `<div class="gh-a-summary">
      <div class="gh-total-number">${escapeHtml(integers.format(data.total))}<small>contributions in the last year</small></div>
      ${heatmap(data)}
    </div>
    <div class="gh-stat-grid">${stat("Active days", data.activeDays, true)}${stat("Longest streak", data.longestStreak, true)}${stat("Current streak", data.currentStreak)}${stat("Private marks", data.breakdown.restricted)}</div>
    ${breakdownLine(data)}` : `<div class="gh-inline-unavailable">${escapeHtml(data?.message || "GitHub activity unavailable")}</div>`}
    <p class="gh-source">Authenticated GitHub GraphQL · contribution counts follow profile visibility</p>
  </article>`;
}

function variantA(data, usage) {
  if (activityView === "github") return variantAGithub(data);
  const calendar = buildUsageCalendar(usage);
  const busiest = calendar.busiest?.usage?.tokens?.total || 0;
  return `<article class="gh-card gh-card-a" data-github-variant="A" data-activity-view="usage">
    ${usageHeader("Token spend calendar", usage)}
    <div class="gh-a-summary">
      <div class="gh-total-number usage-total-number">${escapeHtml(fmtEur(calendar.costEur))}<small>API equivalent · ${escapeHtml(compact.format(calendar.totalTokens))} tokens</small></div>
      ${usageHeatmap(calendar)}
    </div>
    <div class="gh-stat-grid">${stat("Active days", calendar.activeDays, true)}${statText("Busiest day", compact.format(busiest), true, calendar.busiest?.date || "")}${statText("Cache reuse", calendar.contextReusePct == null ? "—" : `${calendar.contextReusePct}%`)}${statText("Priced", `${calendar.pricingCoveragePct}%`)}</div>
    ${usageBreakdown(calendar)}
    <p class="gh-source">Daily timestamps from local CLI logs · API-equivalent estimate</p>
  </article>`;
}

function variantB(data, usage) {
  const calendar = buildUsageCalendar(usage);
  const githubOk = data?.status === "ok";
  return `<article class="gh-card gh-card-b" data-github-variant="B">
    ${dualHeader(data)}
    <section class="activity-half usage-half">
      <div class="activity-label"><span>Token spend</span><b>${escapeHtml(fmtEur(calendar.costEur))}<small>${escapeHtml(compact.format(calendar.totalTokens))} tokens</small></b></div>
      ${usageHeatmap(calendar, false)}
    </section>
    <section class="activity-half github-half">
      <div class="activity-label"><span>GitHub contributions</span><b>${escapeHtml(integers.format(githubOk ? data.total : 0))}<small>${githubOk ? `${data.activeDays} active days` : "unavailable"}</small></b></div>
      ${githubOk ? heatmap(data, false) : `<div class="gh-inline-unavailable">${escapeHtml(data?.message || "GitHub activity unavailable")}</div>`}
    </section>
    <p class="gh-breakdown dual-breakdown"><span><b>${calendar.activeDays}</b> token days</span><span><b>${calendar.contextReusePct == null ? "—" : `${calendar.contextReusePct}%`}</b> cache reuse</span><span><b>${githubOk ? data.longestStreak : 0}</b> GitHub streak</span></p>
    <p class="gh-source">Local CLI logs + authenticated GitHub GraphQL · hover any day for detail</p>
  </article>`;
}

function correlationMonthCards(data, calendar) {
  const contributions = new Map();
  if (data?.status === "ok") {
    for (const day of data.weeks.flatMap((week) => week.days)) contributions.set(day.date, Number(day.count) || 0);
  }
  const groups = new Map();
  for (const day of calendar.weeks.flatMap((week) => week.days)) {
    if (day.future) continue;
    const key = day.date.slice(0, 7);
    const month = groups.get(key) || { tokens: 0, costEur: 0, contributions: 0 };
    month.tokens += Number(day.usage?.tokens?.total) || 0;
    month.costEur += Number(day.usage?.estimatedCostEur) || 0;
    month.contributions += contributions.get(day.date) || 0;
    groups.set(key, month);
  }
  const maximum = Math.max(1, ...[...groups.values()].map((month) => month.tokens));

  return [...groups.entries()].map(([key, month]) => {
    const date = new Date(`${key}-15T12:00:00Z`);
    const label = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date);
    const fullLabel = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
    const level = month.tokens ? Math.max(1, Math.ceil((Math.log1p(month.tokens) / Math.log1p(maximum)) * 4)) : 0;
    const title = `${fullLabel}: ${integers.format(month.tokens)} tokens, ${fmtEur(month.costEur)} API equivalent, ${integers.format(month.contributions)} GitHub contributions`;
    return `<section class="gh-month-card correlation-month l${level}" title="${escapeHtml(title)}"><h3>${escapeHtml(label)}</h3><b>${escapeHtml(fmtEur(month.costEur))}</b><span>${escapeHtml(compact.format(month.tokens))} tok</span><small>${escapeHtml(integers.format(month.contributions))} GitHub</small></section>`;
  }).join("");
}

function variantC(data, usage) {
  const calendar = buildUsageCalendar(usage);
  const githubOk = data?.status === "ok";
  return `<article class="gh-card gh-card-c" data-github-variant="C">
    ${dualHeader(data)}
    <div class="gh-c-summary">
      <div class="gh-total-number usage-total-number">${escapeHtml(fmtEur(calendar.costEur))}<small>${escapeHtml(compact.format(calendar.totalTokens))} tokens · ${escapeHtml(integers.format(githubOk ? data.total : 0))} GitHub</small></div>
      <div class="gh-stat-grid">${stat("Token days", calendar.activeDays, true)}${stat("GitHub days", githubOk ? data.activeDays : 0, true)}${statText("Cache reuse", calendar.contextReusePct == null ? "—" : `${calendar.contextReusePct}%`)}${statText("Priced", `${calendar.pricingCoveragePct}%`)}</div>
    </div>
    <div class="gh-month-cards correlation-months">${correlationMonthCards(data, calendar)}</div>
    <p class="gh-source">Monthly token cost and GitHub activity in the same cells · hover for exact totals</p>
  </article>`;
}

function switcher(current) {
  if (!new URLSearchParams(location.search).has("variant")) return "";
  const keys = Object.keys(variants);
  const index = keys.indexOf(current);
  const previous = keys[(index - 1 + keys.length) % keys.length];
  const next = keys[(index + 1) % keys.length];
  return `<div class="gh-prototype-switcher" role="group" aria-label="GitHub card prototype variants">
    <button type="button" data-gh-variant="${previous}" aria-label="Previous variant">←</button>
    <span>${escapeHtml(`${current} — ${variants[current]}`)}</span>
    <button type="button" data-gh-variant="${next}" aria-label="Next variant">→</button>
  </div>`;
}

function render(data = contributionData, usage = usageData) {
  const host = document.getElementById("githubContributionsPrototype");
  if (!host || (!data && !usage)) return;
  if (data) contributionData = data;
  if (usage) usageData = usage;
  document.querySelector(".gh-prototype-switcher")?.remove();
  host.setAttribute("aria-busy", "false");
  const key = currentVariant();
  const renderer = key === "B" ? variantB : key === "C" ? variantC : variantA;
  host.innerHTML = renderer(contributionData, usageData);
  document.body.insertAdjacentHTML("beforeend", switcher(key));
}

function selectVariant(next) {
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  history.replaceState({}, "", url);
  render();
}

function acceptUsage(data) {
  const nextSignature = dataSignature(data);
  if (nextSignature === usageSignature) return;
  usageSignature = nextSignature;
  usageData = data;
  render();
}

async function refreshUsageCalendar() {
  try {
    acceptUsage(await loadUsage());
  } catch {
    // The main usage dialog owns retry/error UI. Keep GitHub or the last good
    // calendar visible here through a transient local scan failure.
  }
}

async function refreshContributions() {
  if (contributionLoad) return contributionLoad;
  lastContributionAttemptAt = Date.now();
  contributionLoad = (async () => {
    try {
      const data = await loadGitHubContributions();
      const nextSignature = dataSignature(data);
      if (nextSignature !== contributionSignature) {
        contributionSignature = nextSignature;
        contributionData = data;
        render();
      }
    } catch (error) {
      // A transient refresh failure must not replace good data already on screen.
      if (!contributionData) {
        const unavailable = {
          status: "unavailable",
          message: error instanceof Error ? error.message : "Could not read GitHub activity.",
        };
        contributionSignature = dataSignature(unavailable);
        contributionData = unavailable;
        render();
      }
    } finally {
      contributionLoad = undefined;
    }
  })();
  return contributionLoad;
}

export async function mountGitHubContributionPrototype() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-gh-variant]");
    if (button) selectVariant(button.dataset.ghVariant);
    const view = event.target.closest?.("[data-activity-view]");
    if (view) {
      activityView = view.dataset.activityView === "github" ? "github" : "usage";
      render();
    }
    const ledger = event.target.closest?.("[data-open-usage]");
    if (ledger) {
      event.preventDefault();
      const dialog = document.getElementById("usageDialog");
      if (dialog && !dialog.open) dialog.showModal();
    }
  });
  addEventListener("llmquota:usage", (event) => acceptUsage(event.detail));
  addEventListener("keydown", (event) => {
    if (!new URLSearchParams(location.search).has("variant") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    if (event.target.closest?.("input, textarea, [contenteditable]")) return;
    const keys = Object.keys(variants);
    const index = keys.indexOf(currentVariant());
    selectVariant(keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length]);
  });

  await Promise.all([refreshContributions(), refreshUsageCalendar()]);
  setInterval(() => {
    if (!document.hidden) refreshContributions();
  }, CONTRIBUTION_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastContributionAttemptAt >= CONTRIBUTION_REFRESH_MS) {
      refreshContributions();
    }
  });
}
