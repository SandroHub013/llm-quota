"""PROTOTYPE — three liquid-glass widget directions, switchable with Left/Right.

Question: which transparent Windows-native layout should replace the current widget surface?
Run with: py widget_liquid_glass_prototype.py --demo
"""

import argparse
import ctypes
import ctypes.wintypes as wintypes
import threading
import tkinter as tk

import widget


VARIANTS = (
    {
        "key": "A",
        "name": "Frosted Stack",
        "size": (390, 430),
        "background": "#08131f",
        "glass": "#10283b",
        "card": "#15344b",
        "border": "#7dd3fc",
        "accent": "#67e8f9",
        "text": "#f5fbff",
        "muted": "#9db8ca",
        "tint": "#0b2639",
        "tint_alpha": 150,
        "opacity": 0.93,
    },
    {
        "key": "B",
        "name": "Prism Grid",
        "size": (480, 374),
        "background": "#100d24",
        "glass": "#211842",
        "card": "#2b2054",
        "border": "#c4b5fd",
        "accent": "#a78bfa",
        "text": "#fbf9ff",
        "muted": "#c4b9de",
        "tint": "#241346",
        "tint_alpha": 135,
        "opacity": 0.91,
    },
    {
        "key": "C",
        "name": "Clear Lens Dock",
        "size": (884, 134),
        "background": "#070b11",
        "glass": "#111a25",
        "card": "#172330",
        "border": "#d9f4ff",
        "accent": "#a5f3fc",
        "text": "#f7fcff",
        "muted": "#91a5b5",
        "tint": "#08131e",
        "tint_alpha": 105,
        "opacity": 0.86,
    },
)


DEMO_PROVIDERS = [
    {
        "id": "claude",
        "name": "Claude",
        "status": "ok",
        "remaining": 68,
        "reset_sec": 62 * 60,
        "reset_str": "1h 2m",
    },
    {
        "id": "codex",
        "name": "Codex",
        "status": "ok",
        "remaining": 42,
        "reset_sec": 3 * 3600 + 12 * 60,
        "reset_str": "3h 12m",
    },
    {
        "id": "zai",
        "name": "z.ai",
        "status": "ok",
        "remaining": 84,
        "reset_sec": 20 * 3600,
        "reset_str": "20h",
    },
    {
        "id": "gemini",
        "name": "Gemini",
        "status": "ok",
        "remaining": 76,
        "reset_sec": 2 * 86400 + 8 * 3600,
        "reset_str": "2d 8h",
    },
    {
        "id": "moonshot",
        "name": "Moonshot",
        "status": "ok",
        "remaining": 91,
        "reset_sec": 5 * 86400,
        "reset_str": "5d",
    },
]


class AccentPolicy(ctypes.Structure):
    _fields_ = (
        ("accent_state", ctypes.c_int),
        ("accent_flags", ctypes.c_int),
        ("gradient_color", ctypes.c_uint),
        ("animation_id", ctypes.c_int),
    )


class WindowCompositionAttributeData(ctypes.Structure):
    _fields_ = (
        ("attribute", ctypes.c_int),
        ("data", ctypes.c_void_p),
        ("size", ctypes.c_size_t),
    )


def native_handle(window):
    """Return the real Win32 handle behind Tk's wrapper window."""
    user32 = ctypes.windll.user32
    user32.GetParent.argtypes = (wintypes.HWND,)
    user32.GetParent.restype = wintypes.HWND
    return user32.GetParent(window.winfo_id()) or window.winfo_id()


def abgr_color(hex_color, alpha):
    red = int(hex_color[1:3], 16)
    green = int(hex_color[3:5], 16)
    blue = int(hex_color[5:7], 16)
    return (alpha << 24) | (blue << 16) | (green << 8) | red


def apply_native_acrylic(window, tint, alpha):
    """Ask DWM for acrylic blur; Tk alpha remains the visual fallback."""
    try:
        hwnd = native_handle(window)
        policy = AccentPolicy(4, 2, abgr_color(tint, alpha), 0)
        data = WindowCompositionAttributeData(
            19,
            ctypes.cast(ctypes.pointer(policy), ctypes.c_void_p),
            ctypes.sizeof(policy),
        )
        setter = ctypes.windll.user32.SetWindowCompositionAttribute
        setter.argtypes = (wintypes.HWND, ctypes.POINTER(WindowCompositionAttributeData))
        setter.restype = wintypes.BOOL
        applied = bool(setter(hwnd, ctypes.byref(data)))

        dwm = ctypes.windll.dwmapi
        dark = ctypes.c_int(1)
        corner = ctypes.c_int(2)  # DWMWCP_ROUND
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(dark), ctypes.sizeof(dark))
        dwm.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(corner), ctypes.sizeof(corner))
        return applied
    except (AttributeError, OSError, ValueError):
        return False


def rounded_rectangle(canvas, x1, y1, x2, y2, radius=18, **options):
    points = (
        x1 + radius, y1,
        x2 - radius, y1,
        x2, y1,
        x2, y1 + radius,
        x2, y2 - radius,
        x2, y2,
        x2 - radius, y2,
        x1 + radius, y2,
        x1, y2,
        x1, y2 - radius,
        x1, y1 + radius,
        x1, y1,
    )
    return canvas.create_polygon(points, smooth=True, splinesteps=24, **options)


def provider_color(provider):
    return widget.BRAND.get(provider["id"], ("#67e8f9", "?"))[0]


def provider_initial(provider):
    return widget.BRAND.get(provider["id"], ("#67e8f9", provider["name"][:1]))[1]


def percent_text(provider):
    remaining = provider.get("remaining")
    if remaining is not None:
        return f"{remaining}%"
    return widget.STATUS_LABEL.get(provider.get("status"), "N/A").upper()


def reset_text(provider):
    return provider.get("reset_str") or "no reset"


class LiquidGlassPrototype(tk.Tk):
    def __init__(self, variant_key="A", demo=False, selftest=False):
        super().__init__()
        self.title("LLM Quota Liquid Glass Prototype")
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.demo = demo
        self.providers = [dict(provider) for provider in DEMO_PROVIDERS]
        self.cost = 18.42
        self.source = "DEMO"
        self.native_glass = False
        self.variant_index = next(
            (index for index, variant in enumerate(VARIANTS) if variant["key"] == variant_key),
            0,
        )
        self.drag_origin = None
        self._user_positioned = False

        self.bind("<Escape>", lambda _event: self.destroy())
        self.bind("<ButtonPress-3>", lambda _event: self.destroy())
        self.bind("<Left>", lambda event: self._keyboard_cycle(event, -1))
        self.bind("<Right>", lambda event: self._keyboard_cycle(event, 1))
        self.bind("<ButtonPress-1>", self._drag_start, add="+")
        self.bind("<B1-Motion>", self._drag, add="+")

        self.render()
        if not demo:
            self.after(100, self.refresh_data)
        if selftest:
            self.after(2500, self.destroy)

    @property
    def variant(self):
        return VARIANTS[self.variant_index]

    def _keyboard_cycle(self, event, direction):
        if isinstance(event.widget, (tk.Entry, tk.Text)):
            return
        self.cycle(direction)

    def cycle(self, direction):
        self.variant_index = (self.variant_index + direction) % len(VARIANTS)
        self._user_positioned = False
        self.render()

    def _drag_start(self, event):
        if isinstance(event.widget, tk.Button):
            return
        self.drag_origin = (event.x_root, event.y_root, self.winfo_x(), self.winfo_y())

    def _drag(self, event):
        if not self.drag_origin:
            return
        self._user_positioned = True
        press_x, press_y, origin_x, origin_y = self.drag_origin
        self.geometry(f"+{origin_x + event.x_root - press_x}+{origin_y + event.y_root - press_y}")

    def refresh_data(self):
        def load():
            providers = widget.fetch_all()
            cost = widget.fetch_usage_cost()
            self.after(0, lambda: self._finish_refresh(providers, cost))

        threading.Thread(target=load, daemon=True).start()

    def _finish_refresh(self, providers, cost):
        if providers:
            self.providers = providers
            self.source = "LIVE"
        else:
            self.source = "DEMO · OFFLINE"
        if cost is not None:
            self.cost = cost
        self.render()
        self.after(15_000, self.refresh_data)

    def render(self):
        variant = self.variant
        for child in self.winfo_children():
            child.destroy()

        self.configure(bg=variant["background"])
        self.attributes("-alpha", variant["opacity"])
        width, content_height = variant["size"]
        total_height = content_height + 48
        self.geometry(f"{width}x{total_height}")
        self.update_idletasks()
        self.native_glass = apply_native_acrylic(
            self,
            variant["tint"],
            variant["tint_alpha"],
        )

        canvas = tk.Canvas(
            self,
            width=width,
            height=content_height,
            bg=variant["background"],
            highlightthickness=0,
        )
        canvas.pack()
        if variant["key"] == "A":
            self._draw_frosted_stack(canvas, variant)
        elif variant["key"] == "B":
            self._draw_prism_grid(canvas, variant)
        else:
            self._draw_clear_lens(canvas, variant)

        self._build_switcher(variant)
        self.update_idletasks()
        widget.set_window_shape(native_handle(self), [
            ("round", 0, 0, self.winfo_width(), self.winfo_height())
        ])
        if not self._user_positioned:
            self._place_for_variant()

    def _source_label(self):
        effect = "NATIVE ACRYLIC" if self.native_glass else "ALPHA GLASS"
        return f"{self.source}  ·  {effect}"

    def _place_for_variant(self):
        self.update_idletasks()
        area = widget.windows_work_area(self.winfo_screenwidth(), self.winfo_screenheight())
        if self.variant["key"] == "C":
            x, y = widget.bottom_center_position(area, self.winfo_width(), self.winfo_height(), margin=24)
        else:
            x, y = widget.bottom_right_position(area, self.winfo_width(), self.winfo_height(), margin=24)
        self.geometry(f"+{x}+{y}")

    def _build_switcher(self, variant):
        rail = tk.Frame(self, bg=variant["background"], height=48)
        rail.pack(fill="x")
        pill = tk.Frame(rail, bg="#02050a", highlightbackground=variant["border"], highlightthickness=1)
        pill.pack(pady=(6, 7))
        previous = tk.Button(
            pill,
            text="←",
            command=lambda: self.cycle(-1),
            bg="#02050a",
            fg=variant["accent"],
            activebackground=variant["glass"],
            activeforeground=variant["text"],
            relief="flat",
            bd=0,
            font=("Segoe UI", 10, "bold"),
            cursor="hand2",
        )
        previous.pack(side="left", padx=(8, 4), pady=2)
        tk.Label(
            pill,
            text=f"PROTOTYPE  {variant['key']} — {variant['name']}",
            bg="#02050a",
            fg=variant["text"],
            font=("Cascadia Mono", 8, "bold"),
        ).pack(side="left", padx=8)
        following = tk.Button(
            pill,
            text="→",
            command=lambda: self.cycle(1),
            bg="#02050a",
            fg=variant["accent"],
            activebackground=variant["glass"],
            activeforeground=variant["text"],
            relief="flat",
            bd=0,
            font=("Segoe UI", 10, "bold"),
            cursor="hand2",
        )
        following.pack(side="left", padx=(4, 8), pady=2)

    def _draw_frosted_stack(self, canvas, variant):
        width, _height = variant["size"]
        rounded_rectangle(
            canvas, 1, 1, width - 1, 429, 26,
            fill=variant["glass"], outline=variant["border"], width=1,
        )
        canvas.create_oval(286, -74, 430, 70, fill="#164e63", outline="")
        canvas.create_oval(-60, 346, 88, 494, fill="#312e81", outline="")
        canvas.create_text(22, 22, text="LLM QUOTA  /  LIQUID", fill=variant["accent"],
                           font=("Cascadia Mono", 9, "bold"), anchor="nw")
        canvas.create_text(22, 48, text="API-equivalent spend", fill=variant["muted"],
                           font=("Segoe UI", 9), anchor="nw")
        canvas.create_text(20, 68, text=widget.format_eur(self.cost), fill=variant["text"],
                           font=("Segoe UI Variable Display", 28, "bold"), anchor="nw")
        rounded_rectangle(canvas, 222, 24, 368, 51, 13, fill="#0a1d2a", outline=variant["border"])
        canvas.create_text(295, 38, text=self._source_label(), fill=variant["text"],
                           font=("Cascadia Mono", 6, "bold"))

        rounded_rectangle(canvas, 14, 116, 376, 342, 20,
                          fill=variant["card"], outline="#315a72", width=1)
        row_height = 43
        for index, provider in enumerate(self.providers[:5]):
            y = 126 + index * row_height
            color = provider_color(provider)
            if index:
                canvas.create_line(28, y - 6, 362, y - 6, fill="#29485b")
            canvas.create_oval(27, y + 1, 51, y + 25, fill=color, outline="#dff8ff", width=1)
            canvas.create_text(39, y + 13, text=provider_initial(provider), fill="#ffffff",
                               font=("Segoe UI", 7, "bold"))
            canvas.create_text(62, y + 4, text=provider["name"], fill=variant["text"],
                               font=("Segoe UI", 9, "bold"), anchor="nw")
            canvas.create_text(62, y + 22, text=f"reset {reset_text(provider)}", fill=variant["muted"],
                               font=("Cascadia Mono", 7), anchor="nw")
            remaining = provider.get("remaining")
            canvas.create_line(220, y + 14, 316, y + 14, fill="#263f50", width=7)
            if remaining is not None:
                canvas.create_line(220, y + 14, 220 + 0.96 * remaining, y + 14,
                                   fill=widget.quota_color(remaining), width=7)
            canvas.create_text(350, y + 14, text=percent_text(provider),
                               fill=widget.quota_color(remaining), font=("Cascadia Mono", 9, "bold"),
                               anchor="e")

        rounded_rectangle(canvas, 14, 353, 376, 416, 18,
                          fill="#0b1d2a", outline="#315a72", width=1)
        canvas.create_text(28, 366, text="RESET HORIZON", fill=variant["muted"],
                           font=("Cascadia Mono", 7, "bold"), anchor="nw")
        left, right, baseline = 29, 361, 396
        canvas.create_line(left, baseline, right, baseline, fill="#3b6074", width=2)
        for provider in self.providers[:5]:
            seconds = provider.get("reset_sec")
            if seconds is None or seconds > widget.HORIZON_SEC:
                continue
            x = left + widget.horizon_position(seconds, right - left)
            color = provider_color(provider)
            canvas.create_line(x, baseline, x, baseline - 15, fill=color, width=2)
            canvas.create_oval(x - 4, baseline - 20, x + 4, baseline - 12, fill=color, outline="")

    def _draw_prism_grid(self, canvas, variant):
        width, height = variant["size"]
        rounded_rectangle(canvas, 1, 1, width - 1, height - 1, 26,
                          fill=variant["glass"], outline=variant["border"], width=1)
        canvas.create_oval(-88, -100, 118, 106, fill="#312e81", outline="")
        canvas.create_oval(382, 268, 558, 444, fill="#155e75", outline="")
        canvas.create_text(22, 20, text="PRISM QUOTA", fill=variant["accent"],
                           font=("Cascadia Mono", 10, "bold"), anchor="nw")
        canvas.create_text(22, 43, text="Five subscriptions · one refracted view", fill=variant["muted"],
                           font=("Segoe UI", 9), anchor="nw")
        canvas.create_text(458, 22, text=self._source_label(), fill=variant["muted"],
                           font=("Cascadia Mono", 6, "bold"), anchor="ne")

        tiles = list(self.providers[:5]) + [None]
        for index, provider in enumerate(tiles):
            column, row = index % 2, index // 2
            x1 = 16 + column * 228
            y1 = 74 + row * 94
            x2, y2 = x1 + 220, y1 + 84
            rounded_rectangle(canvas, x1, y1, x2, y2, 17,
                              fill=variant["card"], outline="#51457b", width=1)
            canvas.create_line(x1 + 18, y1 + 2, x2 - 18, y1 + 2,
                               fill=variant["border"], width=1)
            if provider is None:
                canvas.create_text(x1 + 16, y1 + 16, text="TOKEN SPEND", fill=variant["muted"],
                                   font=("Cascadia Mono", 7, "bold"), anchor="nw")
                canvas.create_text(x1 + 16, y1 + 38, text=widget.format_eur(self.cost),
                                   fill=variant["text"], font=("Segoe UI Variable Display", 19, "bold"),
                                   anchor="nw")
                canvas.create_text(x2 - 14, y2 - 13, text="LOCAL LEDGER", fill=variant["accent"],
                                   font=("Cascadia Mono", 6, "bold"), anchor="se")
                continue

            color = provider_color(provider)
            remaining = provider.get("remaining")
            canvas.create_arc(x1 + 14, y1 + 14, x1 + 70, y1 + 70, start=90, extent=-359.9,
                              outline="#4b426a", width=6, style=tk.ARC)
            if remaining is not None:
                canvas.create_arc(x1 + 14, y1 + 14, x1 + 70, y1 + 70, start=90,
                                  extent=-3.599 * remaining, outline=color, width=6, style=tk.ARC)
            canvas.create_text(x1 + 42, y1 + 42, text=percent_text(provider), fill=variant["text"],
                               font=("Cascadia Mono", 8, "bold"))
            canvas.create_text(x1 + 83, y1 + 19, text=provider["name"], fill=variant["text"],
                               font=("Segoe UI", 10, "bold"), anchor="nw")
            canvas.create_text(x1 + 83, y1 + 44, text=f"reset · {reset_text(provider)}",
                               fill=variant["muted"], font=("Cascadia Mono", 7), anchor="nw")
            canvas.create_oval(x2 - 20, y1 + 18, x2 - 12, y1 + 26,
                               fill=widget.STATUS_DOT.get(provider.get("status"), "#6e7681"), outline="")

    def _draw_clear_lens(self, canvas, variant):
        width, height = variant["size"]
        rounded_rectangle(canvas, 1, 1, width - 1, height - 1, 31,
                          fill=variant["glass"], outline=variant["border"], width=1)
        canvas.create_oval(-40, -80, 138, 98, fill="#164e63", outline="")
        rounded_rectangle(canvas, 14, 14, 174, 120, 24,
                          fill="#0c1823", outline="#36586d", width=1)
        canvas.create_text(30, 28, text="LOCAL SPEND", fill=variant["accent"],
                           font=("Cascadia Mono", 7, "bold"), anchor="nw")
        canvas.create_text(28, 51, text=widget.format_eur(self.cost), fill=variant["text"],
                           font=("Segoe UI Variable Display", 21, "bold"), anchor="nw")
        canvas.create_text(30, 91, text=self._source_label(), fill=variant["muted"],
                           font=("Cascadia Mono", 6, "bold"), anchor="nw")

        for index, provider in enumerate(self.providers[:5]):
            x1 = 184 + index * 136
            x2 = x1 + 126
            rounded_rectangle(canvas, x1, 14, x2, 120, 22,
                              fill=variant["card"], outline="#344959", width=1)
            color = provider_color(provider)
            remaining = provider.get("remaining")
            canvas.create_oval(x1 + 12, 25, x1 + 32, 45, fill=color, outline="#eefcff", width=1)
            canvas.create_text(x1 + 22, 35, text=provider_initial(provider), fill="#ffffff",
                               font=("Segoe UI", 6, "bold"))
            canvas.create_text(x1 + 40, 27, text=provider["name"], fill=variant["text"],
                               font=("Segoe UI", 8, "bold"), anchor="nw")
            canvas.create_text(x1 + 13, 55, text=percent_text(provider),
                               fill=widget.quota_color(remaining),
                               font=("Cascadia Mono", 16, "bold"), anchor="nw")
            canvas.create_text(x1 + 13, 88, text=f"↻ {reset_text(provider)}", fill=variant["muted"],
                               font=("Cascadia Mono", 7), anchor="nw")
            canvas.create_line(x1 + 13, 108, x2 - 13, 108, fill="#283c4b", width=4)
            if remaining is not None:
                canvas.create_line(x1 + 13, 108, x1 + 13 + remaining, 108,
                                   fill=color, width=4)


def parse_args():
    parser = argparse.ArgumentParser(description="LLM Quota liquid-glass widget prototype")
    parser.add_argument("--variant", type=str.upper, choices=("A", "B", "C"), default="A")
    parser.add_argument("--demo", action="store_true", help="Use deterministic sample quota data")
    parser.add_argument("--selftest", action="store_true", help="Close automatically after rendering")
    arguments, _unknown = parser.parse_known_args()
    return arguments


if __name__ == "__main__":
    args = parse_args()
    app = LiquidGlassPrototype(args.variant, args.demo, args.selftest)
    app.mainloop()
