import { expect, test } from "bun:test";
import { mountWidgetButton } from "../public/widget.js";

class FakeButton {
  disabled = false;
  textContent = "▣ Widget";
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
});
