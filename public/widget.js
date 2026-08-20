/**
 * Wires the dashboard button to the desktop widget.
 *
 * A browser delegates the custom URL to the registered desktop handler. The embedded
 * webview cannot do that, so the shell bridge gets the same launch request instead.
 */
export function mountWidgetButton(button, bridge, win = window) {
  button.addEventListener("click", (event) => {
    const b = event.currentTarget;
    b.disabled = true;
    b.textContent = "Opening…";

    if (bridge) {
      bridge.openWidget().finally(() => {
        b.disabled = false;
        b.textContent = "▣ Widget";
      });
      return;
    }

    const widgetUrl = new URL("llmquota://widget");
    widgetUrl.searchParams.set("server", win.location.origin);
    win.location.href = widgetUrl.toString();
    setTimeout(() => {
      b.disabled = false;
      b.textContent = "▣ Widget";
    }, 2500);
  });
}
