/**
 * The update offer is drawn by the dashboard rather than by the OS, which puts a piece
 * of the desktop shell's behaviour in a page the browser also serves. These cover the
 * two halves that can go wrong quietly: the bridge must be absent outside the shell —
 * a browser tab has no app to update — and the markup must survive whatever the release
 * feed calls a version.
 */
import { expect, test } from "bun:test";
import { RELEASES_URL, tauriBridge, updateNoticeHtml } from "../public/update.js";

const offer = { version: "0.6.1", canInstall: true };

test("a browser tab gets no bridge, and neither does a half-injected one", () => {
  expect(tauriBridge(undefined)).toBeNull();
  expect(tauriBridge({})).toBeNull();
  expect(tauriBridge({ __TAURI__: {} })).toBeNull();
  expect(tauriBridge({ __TAURI__: { core: {} } })).toBeNull();
});

test("the bridge calls the four commands the capability is scoped to", async () => {
  const calls: string[] = [];
  const listened: string[] = [];
  const bridge = tauriBridge({
    __TAURI__: {
      core: { invoke: (name: string) => { calls.push(name); return Promise.resolve(null); } },
      event: { listen: (name: string) => { listened.push(name); return Promise.resolve(() => {}); } },
    },
  })!;

  await Promise.all([bridge.pending(), bridge.install(), bridge.openRelease(), bridge.openWidget()]);
  await bridge.onOffer(() => {});

  expect(calls).toEqual(["pending_update", "install_update", "open_release_page", "open_widget"]);
  expect(listened).toEqual(["update-available"]);
});

test("nothing is drawn without an offer", () => {
  expect(updateNoticeHtml(null)).toBe("");
  expect(updateNoticeHtml({ canInstall: true })).toBe("");
});

test("the offer names the version and says what installing costs", () => {
  const html = updateNoticeHtml(offer);
  expect(html).toContain("LLM Quota 0.6.1");
  expect(html).toContain("Update now");
  expect(html).toContain("Not now");
  // The restart is the part a user is entitled to know before pressing the button.
  expect(html).toContain("restarts the app");
});

// Linux installs from a package. Offering to replace files a package manager owns is a
// promise the updater will not keep, so the button opens the release instead.
test("a copy the updater cannot replace is offered a download", () => {
  const html = updateNoticeHtml({ version: "0.6.1", canInstall: false });
  expect(html).toContain("Open the release");
  expect(html).not.toContain("Update now");
  expect(html).toContain("installed from a package");
});

test("installing shows no buttons to press twice", () => {
  const html = updateNoticeHtml(offer, "installing");
  expect(html).toContain("Downloading and installing");
  expect(html).not.toContain("<button");
});

test("a failed install says why and still offers the download", () => {
  const html = updateNoticeHtml(offer, "failed", "signature mismatch");
  expect(html).toContain("signature mismatch");
  expect(html).toContain("data-update-release");
  expect(html).toContain("is-failed");
});

/**
 * The version comes from a signed feed, not from a user. It is escaped anyway: the
 * value is one refactor away from arriving somewhere less trustworthy, and the cost of
 * escaping a string that never needed it is nothing.
 */
test("the version is escaped rather than trusted", () => {
  const html = updateNoticeHtml({ version: '<img src=x onerror="alert(1)">', canInstall: true });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("the release URL is the project's own", () => {
  expect(RELEASES_URL).toBe("https://github.com/SandroHub013/llm-quota/releases/latest");
});
