import { expect, test } from "bun:test";
import { mountWidgetButton } from "../public/widget.js";

class FakeButton {
  disabled = false;
  textContent = "▣ Widget";
  title = "Open the desktop widget";
  #listener?: (event: { currentTarget: FakeButton }) => void;

  addEventListener(_type: string, listener: (event: { currentTarget: FakeButton }) => void) {
    this.#listener = listener;
  }

  click() {
    this.#listener?.({ currentTarget: this });
  }
}

test("the desktop widget button invokes the shell without navigating the dashboard", async () => {
  const button = new FakeButton();
  const location = { origin: "http://localhost:4747", href: "http://localhost:4747/" };
  const calls: string[] = [];
  const bridge = {
    openWidget: () => {
      calls.push("open_widget");
      return Promise.resolve();
    },
  };

  mountWidgetButton(button, bridge, { location });
  button.click();
  await Promise.resolve();

  expect(location.href).toBe("http://localhost:4747/");
  expect(calls).toEqual(["open_widget"]);
  expect(button.textContent).toBe("▣ Widget");
  expect(button.disabled).toBe(false);
});

// The widget is not in the bundle, so a packaged install that never ran
// `widget.py --register-protocol` has nothing to hand the URL to. The shell rejects,
// and a button that quietly goes back to normal reads as "opened, somewhere else".
test("a desktop launch the shell refuses says so on the button", async () => {
  const button = new FakeButton();
  const location = { origin: "http://localhost:4747", href: "http://localhost:4747/" };
  const bridge = { openWidget: () => Promise.reject(new Error("no handler")) };

  mountWidgetButton(button, bridge, { location });
  button.click();
  await Promise.resolve();

  expect(location.href).toBe("http://localhost:4747/");
  expect(button.textContent).toBe("Not registered");
  expect(button.title).toContain("--register-protocol");
  expect(button.disabled).toBe(false);
});

test("the browser widget button still delegates the registered protocol", () => {
  const button = new FakeButton();
  const location = { origin: "http://localhost:4747", href: "http://localhost:4747/" };

  mountWidgetButton(button, null, { location });
  button.click();

  expect(location.href).toBe("llmquota://widget?server=http%3A%2F%2Flocalhost%3A4747");
});
