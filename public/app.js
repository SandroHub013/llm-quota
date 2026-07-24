import { beginLogin, loadProvider, loadQuota, saveProviderKey } from "./api.js";
import { escapeHtml } from "./ui.js";

const grid = document.getElementById("grid");
const cards = new Map(); // id -> element

const STATUS_LABEL = {
  ok: "attivo",
  partial: "parziale",
  rate_limited: "rate limited",
  unauthenticated: "login mancante",
  no_endpoint: "no API quota",
  error: "errore",
};

// Brand look per provider: avatar gradient + card accent.
const BRAND = {
  claude: { b1: "#d97757", b2: "#a85438" },
  codex: { b1: "#10a37f", b2: "#0b6e56" },
  zai: { b1: "#4f7cff", b2: "#2b4fb8" },
  "opencode-zen": { b1: "#9b5bff", b2: "#6a2fd0" },
  gemini: { b1: "#4285f4", b2: "#9b72cf" },
  moonshot: { b1: "#0ea5e9", b2: "#1e3a8a" },
};
const brand = (id) => BRAND[id] ?? { b1: "#5b8cff", b2: "#3a5bbf" };

// Brand logos ufficiali a colori per ciascun provider.
const LOGO = {
  claude: "https://www.google.com/s2/favicons?domain=claude.ai&sz=64",
  codex: "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64",
  zai: "https://www.google.com/s2/favicons?domain=z.ai&sz=64",
  "opencode-zen": "https://www.google.com/s2/favicons?domain=opencode.ai&sz=64",
  gemini: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
  moonshot: "https://www.google.com/s2/favicons?domain=kimi.com&sz=64",
};

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
  const v = unit === "usd" ? "$" + n.toFixed(2) : unit === "cny" ? "¥" + n.toFixed(2) : n.toLocaleString("it-IT");
  return unit === "percent" ? n + "%" : v;
}

function resetText(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = Date.now();
  const diff = d.getTime() - now;
  if (diff <= 0) return "reset scaduto";
  const h = Math.floor(diff / 3.6e6), m = Math.floor((diff % 3.6e6) / 6e4);
  return "reset tra " + (h ? h + "h " : "") + m + "m";
}

// Animated donut: fills from empty, color shifts green -> red with usage.
function donutHtml(pct) {
  const C = 113.1; // 2 * pi * r(18)
  const off = (C * (1 - pct / 100)).toFixed(1);
  const hue = Math.round(140 - pct * 1.4);
  const col = `hsl(${hue} 75% 55%)`;
  return `<svg class="donut" viewBox="0 0 44 44" style="--off:${off};--c:${col}">
    <circle class="track" cx="22" cy="22" r="18"></circle>
    <circle class="arc" cx="22" cy="22" r="18"></circle>
    <text class="pct" x="22" y="26" transform="rotate(90 22 22)" data-v="${pct}">0%</text>
  </svg>`;
}

function metricHtml(m) {
  const pct =
    m.limit && m.used != null
      ? Math.min(100, Math.round((m.used / m.limit) * 100))
      : m.unit === "percent" && m.used != null
        ? m.used
        : null;
  const cls = pct == null ? "" : pct >= 90 ? "crit" : pct >= 70 ? "hot" : "";
  const right =
    m.remaining != null
      ? fmt(m.remaining, m.unit) + " residui"
      : m.used != null && m.limit != null
        ? fmt(m.used, m.unit) + " / " + fmt(m.limit, m.unit)
        : m.used != null
          ? fmt(m.used, m.unit)
          : "";
  const bar = pct == null ? "" : `<div class="bar ${cls}"><i data-w="${pct}"></i></div>`;
  const reset = m.resetAt ? `<div class="reset">${resetText(m.resetAt)}</div>` : "";
  if (pct != null) {
    return `<div class="metric with-donut">
      ${donutHtml(pct)}
      <div class="metric-body">
        <div class="metric-head"><span>${escapeHtml(m.label)}</span><span class="val">${right}</span></div>
        ${reset}
      </div>
    </div>`;
  }
  return `<div class="metric">
    <div class="metric-head"><span>${escapeHtml(m.label)}</span><span class="val">${right}</span></div>
    ${bar}${reset}
  </div>`;
}

function cardHtml(p) {
  const st = Object.hasOwn(STATUS_LABEL, p.status) ? p.status : "error";
  const b = brand(p.id);
  const id = escapeHtml(p.id);
  const name = escapeHtml(p.name);
  const initial = escapeHtml(String(p.name ?? "?")[0]);
  const metrics = (p.metrics || []).map(metricHtml).join("");
  const logoSrc = LOGO[p.id];
  const avatar = `<div class="avatar" style="--b1:${b.b1};--b2:${b.b2}"><span aria-hidden="true">${initial}</span>${logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="" />` : ""}</div>`;
  const models = (MODELS[p.id] || [])
    .map((m) => `<div class="mrow"><span>${escapeHtml(m.n)}</span><span class="mi">${escapeHtml(m.ctx)} · ${escapeHtml(m.eff)}</span></div>`)
    .join("");
  const keyField = p.needsKey
    ? `<div class="keyrow">
         <input type="password" placeholder="Incolla API key…" data-key="${id}" />
         <button data-save="${id}">Salva</button>
       </div>`
    : "";
  const src = p.authSource ? `<span class="src">via ${escapeHtml(p.authSource)}</span>` : "";
  const msg = p.message ? `<div class="msg">${escapeHtml(p.message)}</div>` : "";
  const login = p.loginUrl
    ? `<button class="login-btn" data-login="${escapeHtml(p.loginUrl)}" data-provider="${id}">⬢ Accedi con Google</button>`
    : "";
  return `
    <div class="card-top">
      ${avatar}
      <div class="titles">
        <div class="name">${name}</div>
        ${p.plan ? `<div class="plan">piano: ${escapeHtml(p.plan)}</div>` : src ? `<div class="plan">${src}</div>` : ""}
      </div>
      <span class="badge b-${st}">${STATUS_LABEL[st] || st}</span>
    </div>
    ${metrics}
    ${models ? `<details class="models"><summary>Modelli · contesto · effort</summary>${models}<div class="mnote">valori indicativi</div></details>` : ""}
    ${msg}
    ${login}
    ${keyField}
    <div class="card-foot">
      <a href="${escapeHtml(p.consoleUrl)}" target="_blank" rel="noreferrer">Apri console ↗</a>
      <button class="mini" data-refresh="${id}">↻ aggiorna</button>
    </div>`;
}

function render(p) {
  let el = cards.get(p.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "card";
    grid.appendChild(el);
    cards.set(p.id, el);
  }
  const b = brand(p.id);
  el.style.setProperty("--brand", b.b1);
  el.style.setProperty("--d", (cards.size - 1) * 70 + "ms");
  el.innerHTML = cardHtml(p);
  animate(el);
}

// Count-up donut percentages, grow bars from 0.
function animate(el) {
  requestAnimationFrame(() => {
    for (const i of el.querySelectorAll(".bar > i[data-w]")) i.style.width = i.dataset.w + "%";
    for (const t of el.querySelectorAll(".donut .pct[data-v]")) {
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

async function loadAll() {
  const btn = document.getElementById("refreshAll");
  btn.innerHTML = '<span class="spin">↻</span> Aggiorno…';
  try {
    const providers = await loadQuota();
    providers.forEach(render);
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

grid.addEventListener("click", (e) => {
  const t = e.target.closest("[data-refresh],[data-save],[data-login]");
  if (!t) return;
  if (t.dataset.refresh) refreshOne(t.dataset.refresh);
  if (t.dataset.save) saveKey(t.dataset.save);
  if (t.dataset.login) startLogin(t);
});

grid.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement && e.target.closest(".avatar")) e.target.remove();
}, true);

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

// ---------- awwwards layer: cursor, title split, marquee, tilt ----------

// Split hero title into per-char spans for staggered reveal.
const titleEl = document.getElementById("title");
if (titleEl) {
  titleEl.innerHTML = [...titleEl.textContent]
    .map((c, i) => `<span class="ch" style="--i:${i}">${c === " " ? "&nbsp;" : c}</span>`)
    .join("");
}

// Marquee: provider list duplicated for seamless loop.
const MARQ_ITEMS = ["Claude", "Codex", "Z.AI", "OpenCode Zen", "Gemini", "Moonshot"];
const marq = document.getElementById("marq");
if (marq) {
  const seq = MARQ_ITEMS.map((n) => `<li><b>◆</b> ${n}</li>`).join("");
  marq.innerHTML = seq + seq;
}

// Custom cursor: dot tracks instantly, ring lerps behind.
const cur = document.querySelector(".cur");
const ring = document.querySelector(".cur-ring");
if (cur && matchMedia("(pointer: fine)").matches) {
  let rx = -100, ry = -100, tx = -100, ty = -100;
  addEventListener("pointermove", (e) => {
    tx = e.clientX; ty = e.clientY;
    cur.style.transform = `translate(${tx - 3.5}px, ${ty - 3.5}px)`;
  });
  (function loop() {
    rx += (tx - rx) * 0.16; ry += (ty - ry) * 0.16;
    ring.style.transform = `translate(${rx - 18}px, ${ry - 18}px)`;
    requestAnimationFrame(loop);
  })();
  // Ring expands over anything clickable.
  addEventListener("pointerover", (e) => {
    ring.classList.toggle("on", !!e.target.closest("button, a, summary, input, .card"));
  });
}

// Card tilt + spotlight: delegation, survives innerHTML re-renders.
grid.addEventListener("pointermove", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  card.style.setProperty("--mx", px * 100 + "%");
  card.style.setProperty("--my", py * 100 + "%");
  card.style.setProperty("--ry", ((px - 0.5) * 5).toFixed(2) + "deg");
  card.style.setProperty("--rx", ((0.5 - py) * 5).toFixed(2) + "deg");
});
grid.addEventListener("pointerout", (e) => {
  const card = e.target.closest(".card");
  if (card && !card.contains(e.relatedTarget)) {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  }
});

loadAll();
