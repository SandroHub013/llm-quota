/**
 * PROTOTYPE — three GitHub contribution-card variants on the existing dashboard,
 * switchable with ?variant=A|B|C. Rewrite only the selected design for main.
 */
import { loadGitHubContributions } from "./api.js";
import { escapeHtml } from "./ui.js";

const variants = {
  A: "Calendar first",
  B: "Activity split",
  C: "Monthly mosaic",
};
const integers = new Intl.NumberFormat("en");
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
let contributionData;

function currentVariant() {
  const candidate = new URLSearchParams(location.search).get("variant")?.toUpperCase();
  return Object.hasOwn(variants, candidate) ? candidate : "A";
}

function stat(label, value, green = false) {
  return `<div class="gh-stat${green ? " is-green" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(integers.format(value || 0))}</b></div>`;
}

function dayCell(day, firstColumn = false) {
  const count = Number(day.count) || 0;
  const noun = count === 1 ? "contribution" : "contributions";
  const style = firstColumn ? ` style="grid-column:${Number(day.weekday) + 1}"` : "";
  return `<span class="gh-day l${Math.max(0, Math.min(4, Number(day.level) || 0))}"${style} title="${escapeHtml(`${day.date} · ${count} ${noun}`)}"></span>`;
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

function heatmap(data) {
  const weeks = data.weeks.map((week) => `<div class="gh-week">${week.days.map((day) => dayCell(day)).join("")}</div>`).join("");
  return `<div class="gh-heatmap-scroll" role="img" aria-label="${escapeHtml(`${data.total} GitHub contributions in the last year`)}">
    <div class="gh-heatmap" style="--week-count:${data.weeks.length}">
      <div class="gh-month-labels">${monthLabels(data)}</div>
      <div class="gh-weeks">${weeks}</div>
      ${legend()}
    </div>
  </div>`;
}

function header(data, title) {
  return `<div class="gh-head">
    <div><span class="gh-kicker">GitHub · authenticated viewer</span><h2 class="gh-title">${escapeHtml(title)}</h2><span class="gh-account">${escapeHtml(data.name || data.login)} · @${escapeHtml(data.login)}</span></div>
    <a class="gh-profile" href="${escapeHtml(data.profileUrl)}" target="_blank" rel="noreferrer">View profile ↗</a>
  </div>`;
}

function allStats(data) {
  return `${stat("Commits", data.breakdown.commits)}${stat("Pull requests", data.breakdown.pullRequests)}${stat("Issues", data.breakdown.issues)}${stat("Reviews", data.breakdown.reviews)}${stat("Active days", data.activeDays, true)}${stat("Longest streak", data.longestStreak, true)}${stat("Current streak", data.currentStreak)}${stat("Private marks", data.breakdown.restricted)}`;
}

function sourceNote(data) {
  const from = shortDate.format(new Date(`${data.startedAt.slice(0, 10)}T12:00:00`));
  const to = shortDate.format(new Date(`${data.endedAt.slice(0, 10)}T12:00:00`));
  const text = `${from} – ${to} · ${data.source} · cached in memory for 10 minutes. Private counts depend on the GitHub token scope and profile settings.`;
  return `<p class="gh-source">${escapeHtml(text)}</p>`;
}

function variantA(data) {
  return `<article class="gh-card gh-card-a" data-github-variant="A">
    ${header(data, "Contribution calendar")}
    <div class="gh-a-summary">
      <div class="gh-total-number">${escapeHtml(integers.format(data.total))}<small>contributions in the last year</small></div>
      ${heatmap(data)}
    </div>
    <div class="gh-stat-grid">${allStats(data)}</div>
    ${sourceNote(data)}
  </article>`;
}

function variantB(data) {
  return `<article class="gh-card gh-card-b" data-github-variant="B">
    <aside class="gh-b-score">
      <span class="gh-kicker">GitHub pulse</span>
      <div class="gh-total-number">${escapeHtml(integers.format(data.total))}<small>yearly contributions</small></div>
      <div class="gh-b-streaks">${stat("Active days", data.activeDays, true)}${stat("Longest streak", data.longestStreak, true)}${stat("Current streak", data.currentStreak)}${stat("Private marks", data.breakdown.restricted)}</div>
    </aside>
    <div class="gh-b-calendar">
      ${header(data, "Developer activity")}
      <div class="gh-stat-grid">${stat("Commits", data.breakdown.commits)}${stat("Pull requests", data.breakdown.pullRequests)}${stat("Issues", data.breakdown.issues)}${stat("Reviews", data.breakdown.reviews)}</div>
      ${heatmap(data)}
      ${sourceNote(data)}
    </div>
  </article>`;
}

function monthCards(data) {
  const groups = new Map();
  for (const day of data.weeks.flatMap((week) => week.days)) {
    const key = day.date.slice(0, 7);
    const days = groups.get(key) || [];
    days.push(day);
    groups.set(key, days);
  }

  return [...groups.entries()].map(([key, days]) => {
    const total = days.reduce((sum, day) => sum + day.count, 0);
    const label = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(new Date(`${key}-15T12:00:00`));
    return `<section class="gh-month-card"><h3>${escapeHtml(label)}<span>${escapeHtml(integers.format(total))}</span></h3><div class="gh-mini-grid">${days.map((day, index) => dayCell(day, index === 0)).join("")}</div></section>`;
  }).join("");
}

function variantC(data) {
  const busiest = data.busiestDay ? `${data.busiestDay.count} · ${data.busiestDay.date}` : "—";
  return `<article class="gh-card gh-card-c" data-github-variant="C">
    ${header(data, "A year in months")}
    <div class="gh-c-summary">
      <div class="gh-total-number">${escapeHtml(integers.format(data.total))}<small>contributions across the calendar</small></div>
      <div class="gh-stat-grid">${stat("Commits", data.breakdown.commits)}${stat("Pull requests", data.breakdown.pullRequests)}${stat("Active days", data.activeDays, true)}<div class="gh-stat"><span>Busiest day</span><b title="${escapeHtml(busiest)}">${escapeHtml(data.busiestDay?.count || 0)}</b></div></div>
    </div>
    <div class="gh-month-cards">${monthCards(data)}</div>
    ${sourceNote(data)}
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

function render(data) {
  const host = document.getElementById("githubContributionsPrototype");
  if (!host || !data) return;
  contributionData = data;
  document.querySelector(".gh-prototype-switcher")?.remove();
  host.setAttribute("aria-busy", "false");
  if (data.status !== "ok") {
    host.innerHTML = `<div class="gh-unavailable"><div><b>GitHub activity unavailable</b><br /><span>${escapeHtml(data.message)}</span></div></div>`;
    return;
  }
  const key = currentVariant();
  const renderer = key === "B" ? variantB : key === "C" ? variantC : variantA;
  host.innerHTML = renderer(data);
  document.body.insertAdjacentHTML("beforeend", switcher(key));
}

function selectVariant(next) {
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  history.replaceState({}, "", url);
  render(contributionData);
}

export async function mountGitHubContributionPrototype() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-gh-variant]");
    if (button) selectVariant(button.dataset.ghVariant);
  });
  addEventListener("keydown", (event) => {
    if (!new URLSearchParams(location.search).has("variant") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    if (event.target.closest?.("input, textarea, [contenteditable]")) return;
    const keys = Object.keys(variants);
    const index = keys.indexOf(currentVariant());
    selectVariant(keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length]);
  });

  try {
    render(await loadGitHubContributions());
  } catch (error) {
    render({ status: "unavailable", message: error instanceof Error ? error.message : "Could not read GitHub activity." });
  }
}
