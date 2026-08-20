export interface WidgetBridge {
  openWidget(): Promise<void>;
}

export interface WidgetButton {
  addEventListener(type: string, listener: (event: { currentTarget: WidgetButton }) => void): void;
  disabled: boolean;
  textContent: string;
}

export interface WidgetWindow {
  location: { origin: string; href: string };
}

export function mountWidgetButton(
  button: WidgetButton,
  bridge: WidgetBridge | null,
  win?: WidgetWindow,
): void;
