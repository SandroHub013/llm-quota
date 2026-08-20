/**
 * Wires the dashboard button to the desktop widget.
 *
 * A browser delegates the custom URL to the registered desktop handler. The embedded
 * webview cannot do that, so the shell bridge gets the same launch request instead.
 */
const REGISTER_HINT = "No llmquota:// handler yet — run: python widget.py --register-protocol";

export function mountWidgetButton(button, bridge, win = window) {
  const label = button.textContent;
  const hint = button.title;

  button.addEventListener("click", (event) => {
    const b = event.currentTarget;
    b.disabled = true;
    b.textContent = "Opening…";

    const restore = () => {
      b.disabled = false;
      b.textContent = label;
    };

    if (bridge) {
      // The widget is not part of the bundle, so the desktop refuses the URL until
      // `widget.py --register-protocol` has claimed the scheme. Saying so beats a
      // button that goes back to normal and opens nothing.
      bridge.openWidget().then(
        () => {
          b.title = hint;
          restore();
        },
        () => {
          b.title = REGISTER_HINT;
          b.textContent = "Not registered";
          b.disabled = false;
          setTimeout(restore, 2500);
        },
      );
      return;
    }

    const widgetUrl = new URL("llmquota://widget");
    widgetUrl.searchParams.set("server", win.location.origin);
    win.location.href = widgetUrl.toString();
    setTimeout(restore, 2500);
  });
}
