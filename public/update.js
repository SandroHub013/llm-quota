/**
 * The desktop shell's update offer, drawn by the dashboard instead of by the OS.
 *
 * The shell used to raise a native message box. It works, but it arrives looking like
 * a Windows system dialog in front of an app that looks like nothing else on Windows —
 * and it steals focus to say something that is never urgent. The shell now hands the
 * page the offer and the page draws it in its own type, colour and radius scale.
 *
 * The page is served over loopback by the sidecar, so it reaches the shell through the
 * one narrow bridge the capability grants it: listen for the offer, ask to install it,
 * open the release page, and hand the widget launch to the desktop. Everything else
 * stays on the Rust side.
 */
import { escapeHtml } from "./ui.js";

/** Where a release the updater cannot install itself is fetched by hand. */
export const RELEASES_URL = "https://github.com/SandroHub013/llm-quota/releases/latest";

/**
 * The bridge, or null in a browser tab — the dashboard is the same page in both, and
 * outside the desktop shell there is no shell to update.
 */
export function tauriBridge(win) {
  const api = win && win.__TAURI__;
  const invoke = api && api.core && api.core.invoke;
  if (typeof invoke !== "function") return null;
  return {
    pending: () => api.core.invoke("pending_update"),
    install: () => api.core.invoke("install_update"),
    openRelease: () => api.core.invoke("open_release_page"),
    openWidget: () => api.core.invoke("open_widget"),
    onOffer: (handler) => {
      if (!api.event || typeof api.event.listen !== "function") return Promise.resolve(() => {});
      return api.event.listen("update-available", (event) => handler(event && event.payload));
    },
  };
}

/**
 * Linux installs from a package, so the shell will not replace files a package manager
 * owns. The offer is the same; the action behind the button is a download.
 */
const acceptLabel = (offer) => (offer && offer.canInstall ? "Update now" : "Open the release");

const noteFor = (offer) =>
  offer && offer.canInstall
    ? "Installing restarts the app. The local server stops with it and comes back on the other side."
    : "This copy was installed from a package, so the update is a download rather than something this window can apply.";

/**
 * `version` comes from a signed release feed rather than from a user, and is still
 * escaped: a value that is never attacker-controlled today is one refactor away from
 * being pasted somewhere it is.
 */
export function updateNoticeHtml(offer, phase = "idle", error = "") {
  if (!offer || !offer.version) return "";
  const heading = `<span class="update-kicker">Update available</span>
    <p class="update-title">LLM Quota ${escapeHtml(offer.version)}</p>`;

  if (phase === "installing") {
    return `<div class="update-card" role="status">
      ${heading}
      <p class="update-note">Downloading and installing. The window closes and comes back on its own.</p>
      <div class="update-bar" aria-hidden="true"><span></span></div>
    </div>`;
  }

  if (phase === "failed") {
    return `<div class="update-card is-failed" role="alert">
      ${heading}
      <p class="update-note">The update could not be installed: ${escapeHtml(error)}</p>
      <div class="update-actions">
        <button type="button" class="primary" data-update-release>Open the release</button>
        <button type="button" data-update-dismiss>Close</button>
      </div>
    </div>`;
  }

  return `<div class="update-card" role="status">
    ${heading}
    <p class="update-note">${escapeHtml(noteFor(offer))}</p>
    <div class="update-actions">
      <button type="button" class="primary" data-update-accept>${escapeHtml(acceptLabel(offer))}</button>
      <button type="button" data-update-dismiss>Not now</button>
    </div>
  </div>`;
}

/**
 * Wires the notice to the bridge. Dismissing hides it for this run only: the shell
 * keeps its own memory of what it has offered, and a release it has already shown is
 * not raised again until the app restarts or someone asks from the tray.
 */
export function mountUpdateNotice(node, bridge) {
  if (!node || !bridge) return;
  let offer = null;

  const draw = (phase = "idle", error = "") => {
    node.innerHTML = updateNoticeHtml(offer, phase, error);
    node.hidden = !node.innerHTML;
  };

  const show = (payload) => {
    if (!payload || !payload.version) return;
    offer = payload;
    draw();
  };

  node.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-update-dismiss]")) {
      offer = null;
      draw();
      return;
    }
    if (target.closest("[data-update-release]")) {
      bridge.openRelease().catch(() => {});
      return;
    }
    if (!target.closest("[data-update-accept]")) return;
    if (!offer.canInstall) {
      bridge.openRelease().catch(() => {});
      return;
    }
    draw("installing");
    try {
      // The shell restarts the app on success, so nothing here runs after it.
      await bridge.install();
    } catch (error) {
      draw("failed", error && error.message ? error.message : String(error));
    }
  });

  bridge.onOffer(show);
  // The offer can land while the splash screen is still up, before this page exists.
  bridge.pending().then(show).catch(() => {});
}
