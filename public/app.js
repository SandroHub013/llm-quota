import { beginLogin, loadProvider, loadQuota, saveProviderKey } from "./api.js";
import { escapeHtml } from "./ui.js";

const grid = document.getElementById("grid");
const cards = new Map(); // id -> element
const latest = new Map(); // id -> QuotaResult, the horizon reads from here

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

const STATUS_LABEL = {
  ok: "attivo",
  partial: "parziale",
  rate_limited: "rate limited",
  unauthenticated: "login mancante",
  no_endpoint: "no API quota",
  error: "errore",
};

// Brand look per provider: avatar gradient + card accent + horizon marker colour.
const BRAND = {
  claude: { b1: "#d97757", b2: "#a85438" },
  codex: { b1: "#10a37f", b2: "#0b6e56" },
  zai: { b1: "#4f7cff", b2: "#2b4fb8" },
  "opencode-zen": { b1: "#9b5bff", b2: "#6a2fd0" },
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
  claude: { src: "/logos/claude.png", fill: true },
  codex: { src: "/logos/codex.webp", fill: true },
  zai: { src: "/logos/zai.svg" },
  "opencode-zen": { src: "/logos/opencode-zen.png", fill: true },
  gemini: { src: "/logos/gemini.svg", plate: "#f6f8fc" },
  moonshot: { src: "/logos/moonshot.png", fill: true },
};

// Drawn fallback, used only if a logo file is missing or fails to decode: same 24
// grid, same optical weight, white on the brand field.
const S = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"';
const GLYPH = {
  claude: `<g ${S}><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5M6 6l3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18"/></g>`,
  codex: `<g ${S} stroke-linejoin="round"><path d="M5 7.5 9.5 12 5 16.5"/><path d="M12.5 16.5H19"/></g>`,
  zai: `<path d="M14.5 2.5 6 13.5h4.2L8.5 21.5 18 10h-4.2z" fill="currentColor"/>`,
  "opencode-zen": `<g ${S}><path d="M16.8 5.4a7.6 7.6 0 1 0 2.6 4.4"/></g>`,
  gemini: `<path d="M12 2.2c0 5.4 4.4 9.8 9.8 9.8-5.4 0-9.8 4.4-9.8 9.8 0-5.4-4.4-9.8-9.8-9.8 5.4 0 9.8-4.4 9.8-9.8z" fill="currentColor"/>`,
  moonshot: `<path d="M20.2 14.8A8.6 8.6 0 0 1 9.2 3.8a8.6 8.6 0 1 0 11 11z" fill="currentColor"/>`,
};
const glyph = (id) => GLYPH[id] ?? `<circle cx="12" cy="12" r="7" ${S}/>`;

// Brand mark on its brand field. The drawn glyph sits underneath and only becomes
// visible if the image never loads (the error handler removes the <img>).
function markHtml(id, cls) {
  const b = brand(id);
  const logo = LOGO[id];
  const plate = logo?.plate ? `background:${logo.plate}` : `--b1:${b.b1};--b2:${b.b2}`;
  return `<span class="${cls}${logo?.fill ? " is-full" : ""}" style="${plate}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${glyph(id)}</svg>
    ${logo ? `<img src="${logo.src}" alt="" width="24" height="24" decoding="async" />` : ""}
  </span>`;
}

// Reveal order, matching the static skeletons in index.html. Only used for a
// provider the server returns that has no skeleton waiting for it.
const LINEUP = ["claude", "codex", "zai", "opencode-zen", "gemini", "moonshot"];
const orderOf = (id) => Math.max(0, LINEUP.indexOf(id));

// Lineup provider: nome, contesto, effort. Valori dei cataloghi provider/CLI.
const MODELS = {
  claude: [
    { n: "Claude Fable 5", ctx: "1M", eff: "low · medium · high · xhigh · max" },
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
  "opencode-zen": [
    { n: "Claude Fable 5 / Opus 4.8 / Sonnet 5", ctx: "1M", eff: "low · medium · high · xhigh · max" },
    { n: "GPT-5.6 Sol / Terra / Luna", ctx: "1.05M", eff: "varia per gateway" },
    { n: "Gemini 3.1 Pro / 3.5–3.6 Flash", ctx: "1M", eff: "varia per modello" },
    { n: "GLM-5.2 · Kimi K2.7-Code · Grok 4.5 · DeepSeek v4", ctx: "varia", eff: "varia" },
    { n: "+ altri, 58 in totale", ctx: "—", eff: "lista live: opencode.ai/zen/v1/models" },
  ],
  gemini: [
    { n: "Gemini 3.6 Flash", ctx: "1,048,576", eff: "thinking dinamico" },
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
  return n.toLocaleString("it-IT");
}

// "tra 4h 55m" / "tra 39m" — always relative, because the whole product is about
// how much time is left, never about wall-clock instants.
function humanGap(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  const d = Math.floor(h / 24);
  return d + "g " + (h % 24) + "h";
}

function resetText(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  return diff <= 0 ? "reset scaduto" : "reset tra " + humanGap(diff);
}

function donutHtml(pct) {
  const C = 113.1; // 2 * pi * r(18)
  // A true 0% arc draws nothing and the ring reads as broken. Keep a minimum
  // stub so "niente consumato" looks like a state, while the label stays exact.
  const off = (C * (1 - Math.max(pct, 1.6) / 100)).toFixed(1);
  const col = `hsl(${Math.round(140 - pct * 1.4)} 75% 55%)`;
  return `<svg class="donut" viewBox="0 0 44 44" style="--off:${off};--c:${col}" aria-hidden="true">
    <circle class="track" cx="22" cy="22" r="18"></circle>
    <circle class="arc" cx="22" cy="22" r="18"></circle>
    <text class="pct" x="22" y="26" transform="rotate(90 22 22)" data-v="${pct}">0%</text>
  </svg>`;
}

function usedPct(m) {
  if (m.limit && m.used != null) return Math.min(100, Math.round((m.used / m.limit) * 100));
  if (m.unit === "percent" && m.used != null) return m.used;
  return null;
}

function metricHtml(m) {
  const pct = usedPct(m);
  const cls = pct == null ? "" : pct >= 90 ? "crit" : pct >= 70 ? "hot" : "";
  // Say what the number means. "0% / 100%" told the user nothing.
  const right =
    m.remaining != null
      ? fmt(m.remaining, m.unit) + " residui"
      : pct != null
        ? pct + "% usato"
        : m.used != null
          ? fmt(m.used, m.unit)
          : "";
  const reset = m.resetAt ? `<div class="reset">${resetText(m.resetAt)}</div>` : "";
  const head = `<div class="metric-head"><span>${escapeHtml(m.label)}</span><span class="val">${right}</span></div>`;
  if (pct != null) {
    return `<div class="metric">${donutHtml(pct)}<div class="metric-body">${head}${reset}</div></div>`;
  }
  // No percentage to plot (an OAuth token, say). Hold the donut column open anyway
  // so every label in the card starts on the same vertical line.
  return `<div class="metric"><div class="donut-gap" aria-hidden="true"></div>
    <div class="metric-body">${head}
    ${m.used != null ? `<div class="bar ${cls}"><i data-w="0"></i></div>` : ""}${reset}</div></div>`;
}

function cardHtml(p) {
  const st = Object.hasOwn(STATUS_LABEL, p.status) ? p.status : "error";
  const b = brand(p.id);
  const id = escapeHtml(p.id);
  const metrics = (p.metrics || []).map(metricHtml).join("");
  const models = (MODELS[p.id] || [])
    .map((m) => `<div class="mrow"><span>${escapeHtml(m.n)}</span><span class="mi">${escapeHtml(m.ctx)} · ${escapeHtml(m.eff)}</span></div>`)
    .join("");
  const src = p.authSource ? `<span class="src">via ${escapeHtml(p.authSource)}</span>` : "";
  return `
    <div class="card-top">
      ${markHtml(p.id, "avatar")}
      <div class="titles">
        <h2 class="name">${escapeHtml(p.name)}</h2>
        ${p.plan ? `<div class="plan">piano: ${escapeHtml(p.plan)}</div>` : src ? `<div class="plan">${src}</div>` : ""}
      </div>
      <span class="badge b-${st}">${STATUS_LABEL[st] || st}</span>
    </div>
    ${metrics}
    ${models ? `<details class="models"><summary>Modelli · contesto · effort</summary>${models}<div class="mnote">valori indicativi</div></details>` : ""}
    ${p.message ? `<div class="msg">${escapeHtml(p.message)}</div>` : ""}
    ${p.loginUrl ? `<button class="login-btn" data-login="${escapeHtml(p.loginUrl)}" data-provider="${id}">⬢ Accedi con Google</button>` : ""}
    ${p.needsKey ? `<div class="keyrow"><input type="password" placeholder="Incolla API key…" aria-label="API key ${escapeHtml(p.name)}" data-key="${id}" /><button data-save="${id}">Salva</button></div>` : ""}
    <div class="card-foot">
      <a href="${escapeHtml(p.consoleUrl)}" target="_blank" rel="noreferrer">Apri console ↗</a>
      <button class="mini" data-refresh="${id}">↻ aggiorna</button>
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
  const el = cardFor(p.id);
  el.classList.remove("is-skeleton");
  el.innerHTML = cardHtml(p);
  latest.set(p.id, p);
  animate(el);
  drawHorizon();
}

// Count-up donut percentages, grow bars from zero. Under reduced motion the same
// values are written straight to their final state — informative, just still.
function animate(el) {
  const bars = el.querySelectorAll(".bar > i[data-w]");
  const pcts = el.querySelectorAll(".donut .pct[data-v]");
  if (reduced.matches) {
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
   Every reset the six providers will perform, on one non-linear time axis.
   x = sqrt(hours / 168) so the next few hours — the part you can still act on —
   get most of the width, while weekly windows still have a place to sit.
   Stem height = how much of that window you have already burnt.
   ========================================================================== */
const HZ_SPAN_H = 168; // 7 giorni
const hzRail = document.getElementById("hzRail");
const hzNext = document.getElementById("hzNext");
const hzText = document.getElementById("hzText");
const hzTip = document.getElementById("hzTip");

const hzPos = (h) => Math.sqrt(Math.min(Math.max(h, 0), HZ_SPAN_H) / HZ_SPAN_H);
const HZ_TICKS_FULL = [
  { h: 0, label: "ADESSO" },
  { h: 1, label: "1h" },
  { h: 6, label: "6h" },
  { h: 24, label: "24h" },
  { h: 72, label: "3g" },
  { h: 168, label: "7g" },
];
// A narrow rail cannot carry six labels without them colliding, so it carries
// three. The axis is unchanged — only how densely it is annotated.
const HZ_TICKS_NARROW = [
  { h: 0, label: "ADESSO" },
  { h: 6, label: "6h" },
  { h: 168, label: "7g" },
];
const hzTicks = () =>
  hzRail.getBoundingClientRect().width < 520 ? HZ_TICKS_NARROW : HZ_TICKS_FULL;

function horizonEvents() {
  const now = Date.now();
  const out = [];
  for (const p of latest.values()) {
    for (const m of p.metrics || []) {
      if (!m.resetAt) continue;
      const ms = new Date(m.resetAt).getTime() - now;
      if (ms <= 0 || ms > HZ_SPAN_H * 3.6e6) continue;
      out.push({ id: p.id, provider: p.name, label: m.label, ms, pct: usedPct(m) ?? 0 });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function drawHorizon() {
  const events = horizonEvents();

  hzRail.querySelectorAll(".hz-mark, .hz-tick").forEach((n) => n.remove());

  const ticks = hzTicks();
  ticks.forEach((t, i) => {
    const tick = document.createElement("div");
    // Labels are centred on their tick; the first one would hang off the left edge,
    // so it is left-aligned instead.
    tick.className = "hz-tick" + (i === 0 ? " is-first" : "");
    tick.style.left = hzPos(t.h) * 100 + "%";
    tick.innerHTML = `<span>${t.label}</span>`;
    hzRail.append(tick);
  });

  events.forEach((e, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hz-mark" + (i === 0 ? " imminent" : "");
    b.style.left = hzPos(e.ms / 3.6e6) * 100 + "%";
    b.style.setProperty("--c", brand(e.id).b1);
    b.style.setProperty("--h", 22 + e.pct * 0.6 + "%");
    b.style.setProperty("--d", 120 + i * 55 + "ms");
    b.dataset.provider = e.id;
    b.dataset.tip = `${e.provider} · ${e.label}|${e.pct}% usato|tra ${humanGap(e.ms)}`;
    b.setAttribute(
      "aria-label",
      `${e.provider}, ${e.label}: reset tra ${humanGap(e.ms)}, ${e.pct}% usato`,
    );
    // The marker carries the provider's mark, so the rail is readable as a lineup
    // of brands before any hovering happens.
    b.innerHTML = `<span class="hz-stem"></span>${markHtml(e.id, "hz-dot")}`;
    hzRail.append(b);
  });

  if (!events.length) {
    hzNext.textContent = "Nessun reset nei prossimi 7 giorni.";
    hzText.textContent = "";
    return;
  }
  const n = events[0];
  hzNext.innerHTML = `prossimo reset · <b>${escapeHtml(n.provider)}</b> ${escapeHtml(n.label)} <span class="cd">tra ${humanGap(n.ms)}</span>`;
  hzText.textContent =
    `${events.length} reset nei prossimi 7 giorni. ` +
    events.map((e) => `${e.provider} ${e.label} tra ${humanGap(e.ms)}`).join("; ") + ".";
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
    const nodes = card.querySelectorAll(".reset");
    const withReset = (p.metrics || []).filter((m) => m.resetAt);
    nodes.forEach((n, i) => withReset[i] && (n.textContent = resetText(withReset[i].resetAt)));
  }
}, 30000);

/* ---------------------------------------------------------------- data ---- */

async function loadAll() {
  const btn = document.getElementById("refreshAll");
  btn.innerHTML = '<span class="spin">↻</span> Aggiorno…';
  try {
    const providers = await loadQuota();
    providers.forEach(render);
    // Drop skeletons for providers the server no longer returns.
    const live = new Set(providers.map((p) => p.id));
    for (const [id, el] of cards) {
      if (!live.has(id)) { el.remove(); cards.delete(id); latest.delete(id); }
    }
  } catch (error) {
    btn.textContent = `✗ ${error instanceof Error ? error.message : "errore"}`;
    return;
  } finally {
    if (!btn.textContent.startsWith("✗")) btn.textContent = "↻ Aggiorna tutto";
  }
}

async function refreshOne(id) {
  try {
    render(await loadProvider(id));
  } catch (error) {
    showError(id, error);
  }
}

async function saveKey(id) {
  const input = document.querySelector(`input[data-key="${id}"]`);
  const key = input?.value ?? "";
  const btn = document.querySelector(`button[data-save="${id}"]`);
  if (btn) btn.textContent = "…";
  try {
    render(await saveProviderKey(id, key));
  } catch (error) {
    if (btn) btn.textContent = "Riprova";
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
    card.querySelector(".card-foot")?.before(message);
  }
  message.textContent = `Errore richiesta: ${error instanceof Error ? error.message : "errore"}`;
}

// A logo that fails to decode drops out and reveals the drawn glyph beneath it.
for (const root of [grid, hzRail]) {
  root.addEventListener(
    "error",
    (e) => {
      if (e.target instanceof HTMLImageElement) e.target.remove();
    },
    true,
  );
}

grid.addEventListener("click", (e) => {
  const t = e.target.closest("[data-refresh],[data-save],[data-login]");
  if (!t) return;
  if (t.dataset.refresh) refreshOne(t.dataset.refresh);
  if (t.dataset.save) saveKey(t.dataset.save);
  if (t.dataset.login) startLogin(t);
});

// OAuth loopback flow: open Google's consent page; the server catches the redirect
// on localhost:51121 and saves the credentials by itself. We just poll until
// the provider flips out of "unauthenticated".
async function startLogin(btn) {
  const url = btn.dataset.login;
  const provider = btn.dataset.provider;
  btn.disabled = true;
  btn.textContent = "…";
  let j;
  try {
    j = await beginLogin(url);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = `Riprova: ${error instanceof Error ? error.message : "errore"}`;
    return;
  }
  if (j.error || !j.url) {
    btn.disabled = false;
    btn.textContent = "Errore: " + (j.error ?? "no url");
    return;
  }
  window.open(j.url, "_blank");
  btn.textContent = "Completa il login nel browser…";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const p = await loadProvider(provider);
      if (p.status !== "unauthenticated") return render(p);
    } catch {}
  }
  btn.disabled = false;
  btn.textContent = "Riprova login";
  refreshOne(provider);
}

document.getElementById("refreshAll").addEventListener("click", loadAll);

// Let the browser/Windows shell launch Tk on the interactive desktop.
document.getElementById("openWidget").addEventListener("click", (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = "Apro…";
  window.location.href = "llmquota://widget";
  setTimeout(() => {
    b.disabled = false;
    b.textContent = "▣ Widget";
  }, 2500);
});

/* ---------------------------------------------------------------- chrome ---- */

// Split hero title into per-char spans for the staggered reveal, keeping one
// readable accessible name instead of nine separate letters.
const titleEl = document.getElementById("title");
if (titleEl) {
  const text = titleEl.textContent;
  titleEl.setAttribute("aria-label", text);
  titleEl.innerHTML = [...text]
    .map((c, i) => `<span class="ch" aria-hidden="true" style="--i:${i}">${c === " " ? "&nbsp;" : c}</span>`)
    .join("");
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
