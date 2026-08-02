"""LLM Quota desktop widget — always on top.

The widget has two display modes:
1. Q logo drawer (Q icon with a pop-up panel)
2. Mini bar (a horizontal strip that stays visible)

Features:
- Local provider logos (Claude, ChatGPT/Codex, Z.ai, Gemini, Kimi)
- Native Windows acrylic glass without changing the existing widget layout
- A live reset countdown for every measurable quota
- Hover details for every provider window
- A pulsing red Q ring when a quota is at or below 15%, or rate limited
- Windows notifications for low quotas and resets
- Dashboard and view-switch controls for both display modes
"""
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.request
import webbrowser
import winreg
from datetime import datetime, timezone
from math import isfinite, sqrt
from urllib.parse import parse_qs, urlsplit

DEFAULT_BASE = "http://localhost:4747"


def normalize_base_url(value):
    """Return a safe server base URL, falling back to the local default."""
    candidate = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return DEFAULT_BASE
    if (
        any(char.isspace() for char in candidate)
        or '"' in candidate
        or parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return DEFAULT_BASE
    return candidate


def command_line_base_url(argv):
    """Return an explicitly supplied server URL, or None when it was omitted."""
    args = list(argv)
    for index, argument in enumerate(args):
        if argument == "--server-url" and index + 1 < len(args):
            return normalize_base_url(args[index + 1])
        if argument.startswith("--server-url="):
            return normalize_base_url(argument.split("=", 1)[1])
    return None


def configured_base_url(argv=None, environ=None):
    """Resolve CLI, dashboard-protocol, and environment configuration in order."""
    args = list(sys.argv if argv is None else argv)
    environment = os.environ if environ is None else environ
    explicit = command_line_base_url(args)
    if explicit is not None:
        return explicit

    for argument in args:
        if not str(argument).lower().startswith("llmquota://"):
            continue
        values = parse_qs(urlsplit(argument).query).get("server")
        if not values:
            continue
        candidate = normalize_base_url(values[0])
        # A web page may invoke a custom protocol. Only the local dashboard may
        # choose the server implicitly; remote servers require an explicit flag
        # or environment variable.
        if urlsplit(candidate).hostname in {"localhost", "127.0.0.1", "::1"}:
            return candidate

    return normalize_base_url(environment.get("LLM_QUOTA_URL") or environment.get("WEBQUOTA_URL"))


BASE = configured_base_url()
POLL_MS = 60_000
USAGE_POLL_MS = 5_000
COUNTDOWN_TICK_MS = 30_000
HORIZON_SEC = 7 * 24 * 60 * 60
SURFACE_OPACITY = 0.68
GLASS_TINT = "#0b1623"
GLASS_TINT_ALPHA = 82
MUTEX_NAME = "Local\\LLMQuotaWidget"
WAKE_PORT = 51122


def wake_running_instance():
    """Try sending a wake signal to an already running instance."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect(("127.0.0.1", WAKE_PORT))
        s.sendall(b"WAKE\n")
        s.close()
        return True
    except Exception:
        return False


def acquire_single_instance(wake_callback=None):
    """Return a process-held Windows mutex, or None when widget is already open."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    create_mutex.restype = wintypes.HANDLE
    handle = create_mutex(None, False, MUTEX_NAME)
    if not handle:
        wake_running_instance()
        return None
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        wake_running_instance()
        return None

    if wake_callback:
        import socket
        def _listen():
            try:
                srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                srv.bind(("127.0.0.1", WAKE_PORT))
                srv.listen(1)
                while True:
                    conn, _ = srv.accept()
                    data = conn.recv(64)
                    conn.close()
                    if b"WAKE" in data:
                        wake_callback()
            except Exception:
                pass
        t = threading.Thread(target=_listen, daemon=True)
        t.start()

    return handle



class Rect(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
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


def native_window_handle(window):
    """Return the real Win32 handle behind a Tk top-level window."""
    user32 = ctypes.windll.user32
    user32.GetParent.argtypes = (wintypes.HWND,)
    user32.GetParent.restype = wintypes.HWND
    return user32.GetParent(window.winfo_id()) or window.winfo_id()


def abgr_color(hex_color, alpha):
    """Pack #RRGGBB and alpha into the ABGR value expected by DWM."""
    red = int(hex_color[1:3], 16)
    green = int(hex_color[3:5], 16)
    blue = int(hex_color[5:7], 16)
    return (alpha << 24) | (blue << 16) | (green << 8) | red


def apply_native_acrylic(hwnd, tint=GLASS_TINT, alpha=GLASS_TINT_ALPHA):
    """Enable native Windows acrylic blur, leaving window alpha as fallback."""
    try:
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

        dark_mode = ctypes.c_int(1)
        # The GDI window region already owns the exact rounded silhouette. Asking
        # DWM to round it again uses a different radius and leaves tinted wedges
        # inside every corner, especially on the compact mini bars.
        corner_preference = ctypes.c_int(1)  # DWMWCP_DONOTROUND
        dwm = ctypes.windll.dwmapi
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(dark_mode), ctypes.sizeof(dark_mode))
        dwm.DwmSetWindowAttribute(
            hwnd,
            33,
            ctypes.byref(corner_preference),
            ctypes.sizeof(corner_preference),
        )
        return applied
    except (AttributeError, OSError, ValueError):
        return False


def force_window_visible(window):
    """Restore a Tk window even when Windows hid it behind Tk's state tracking."""
    window.deiconify()
    window.update_idletasks()
    try:
        hwnd = native_window_handle(window)
        user32 = ctypes.windll.user32
        user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.ShowWindow.restype = wintypes.BOOL
        user32.SetWindowPos.argtypes = (
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        )
        user32.SetWindowPos.restype = wintypes.BOOL
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    except (AttributeError, OSError, ValueError):
        pass


def set_window_shape(hwnd, regions):
    """Clip the borderless window to rounded panels and the circular Q button."""
    if not regions:
        return
    gdi32, user32 = ctypes.windll.gdi32, ctypes.windll.user32
    gdi32.CreateRectRgn.argtypes = (ctypes.c_int,) * 4
    gdi32.CreateRoundRectRgn.argtypes = (ctypes.c_int,) * 6
    gdi32.CreateEllipticRgn.argtypes = (ctypes.c_int,) * 4
    for name in ("CreateRectRgn", "CreateRoundRectRgn", "CreateEllipticRgn"):
        getattr(gdi32, name).restype = wintypes.HANDLE
    gdi32.CombineRgn.argtypes = (wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.c_int)
    gdi32.DeleteObject.argtypes = (wintypes.HANDLE,)
    combined = gdi32.CreateRectRgn(0, 0, 0, 0)
    for kind, left, top, right, bottom in regions:
        if kind == "ellipse":
            region = gdi32.CreateEllipticRgn(left, top, right + 1, bottom + 1)
        else:
            region = gdi32.CreateRoundRectRgn(left, top, right + 1, bottom + 1, 40, 40)
        gdi32.CombineRgn(combined, combined, region, 2)  # RGN_OR
        gdi32.DeleteObject(region)
    user32.SetWindowRgn.argtypes = (wintypes.HWND, wintypes.HANDLE, wintypes.BOOL)
    user32.SetWindowRgn.restype = ctypes.c_int
    if not user32.SetWindowRgn(hwnd, combined, True):
        gdi32.DeleteObject(combined)


def bottom_right_position(work_area, width, height, margin=12):
    left, top, right, bottom = work_area
    return (
        max(left + margin, right - width - margin),
        max(top + margin, bottom - height - margin),
    )


def bottom_center_position(work_area, width, height, margin=12):
    left, top, right, bottom = work_area
    return (
        max(left + margin, left + (right - left - width) // 2),
        max(top + margin, bottom - height - margin),
    )


def surface_above_logo_position(logo_x, logo_y, logo_width, surface_width, surface_height, gap=2):
    return logo_x + logo_width - surface_width, logo_y - surface_height - gap


def windows_work_area(screen_width, screen_height):
    rect = Rect()
    if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
        return rect.left, rect.top, rect.right, rect.bottom
    return 0, 0, screen_width, screen_height


def protocol_command(python_executable, script_path, base_url=None):
    pythonw = re.sub(r"python\.exe$", "pythonw.exe", python_executable, flags=re.IGNORECASE)
    server_option = f' --server-url "{normalize_base_url(base_url)}"' if base_url is not None else ""
    return f'"{pythonw}" "{script_path}"{server_option} "%1"'


def register_protocol():
    try:
        python_executable = subprocess.check_output(
            ["py", "-c", "import sys; print(sys.executable)"],
            text=True,
            creationflags=0x08000000,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        python_executable = sys.executable

    root = r"Software\Classes\llmquota"
    registration_base = command_line_base_url(sys.argv)
    if registration_base is None:
        environment_base = os.environ.get("LLM_QUOTA_URL") or os.environ.get("WEBQUOTA_URL")
        registration_base = normalize_base_url(environment_base) if environment_base else None
    command = protocol_command(python_executable, os.path.abspath(__file__), registration_base)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:LLM Quota Widget")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, command)
    return command

DOMAIN_MAP = {
    "claude": "claude.ai",
    "codex": "chatgpt.com",
    "zai": "z.ai",
    "gemini": "gemini.google.com",
    "moonshot": "kimi.com",
}

WIDGET_HIDDEN_PROVIDER_IDS = frozenset({"opencode-zen"})


def send_win_notification(title, message):
    def _send():
        try:
            ps_cmd = f"""
            [reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null
            $notification = New-Object System.Windows.Forms.NotifyIcon
            $notification.Icon = [System.Drawing.SystemIcons]::Warning
            $notification.BalloonTipTitle = '{title.replace("'", "''")}'
            $notification.BalloonTipText = '{message.replace("'", "''")}'
            $notification.Visible = $true
            $notification.ShowBalloonTip(4000)
            Start-Sleep -s 5
            $notification.Dispose()
            """
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        except Exception:
            pass
    threading.Thread(target=_send, daemon=True).start()


def parse_reset_sec(reset_iso):
    if not reset_iso:
        return None
    try:
        dt = datetime.fromisoformat(str(reset_iso).replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        diff_sec = (dt - now).total_seconds()
        return diff_sec if diff_sec > 0 else None
    except (ValueError, TypeError):
        return None


def format_reset(sec):
    if sec is None or sec <= 0:
        return None
    mins = int(sec // 60)
    hours = sec / 3600.0
    if hours < 1:
        return f"{max(1, mins)}m"
    elif hours < 24:
        h = int(hours)
        m = int((sec % 3600) // 60)
        return f"{h}h {m}m" if m > 0 else f"{h}h"
    else:
        days = int(hours // 24)
        h = int((hours % 24))
        return f"{days}d {h}h" if h > 0 else f"{days}d"


def horizon_position(sec, width):
    return round(width * sqrt(min(max(sec, 0), HORIZON_SEC) / HORIZON_SEC))


def horizon_events(data, elapsed=0):
    events = []
    for provider in data:
        for reset in provider.get("resets", []):
            sec = reset["sec"] - max(0, elapsed)
            if 0 < sec <= HORIZON_SEC:
                events.append({"id": provider["id"], "name": provider["name"], **reset, "sec": sec})
    return sorted(events, key=lambda event: event["sec"])


def format_eur(value):
    """Format EUR consistently with the widget's English interface."""
    amount = max(0, float(value or 0))
    return f"€{amount:,.2f}"


def quota_signature(data):
    """Visible quota state, excluding relative countdown text and fetch timing."""
    if data is None:
        return None
    return tuple(
        (
            provider.get("id"),
            provider.get("name"),
            provider.get("status"),
            provider.get("remaining"),
            re.sub(r"\s+\(resets in [^)]+\)", "", str(provider.get("details_str") or "")),
            tuple(
                (reset.get("label"), reset.get("used_pct"), reset.get("reset_at"))
                for reset in provider.get("resets", [])
            ),
        )
        for provider in data
    )


BRAND = {
    "claude": ("#d97757", "C"),
    "codex": ("#10a37f", "C"),
    "zai": ("#4f7cff", "Z"),
    "gemini": ("#4285f4", "G"),
    "moonshot": ("#0ea5e9", "K"),
}
STATUS_LABEL = {
    "ok": "active",
    "partial": "partial",
    "rate_limited": "rate limited",
    "unauthenticated": "not signed in",
    "no_endpoint": "no API quota",
    "error": "error",
}
STATUS_DOT = {
    "ok": "#3fb950",
    "partial": "#d29922",
    "rate_limited": "#d29922",
    "unauthenticated": "#6e7681",
    "no_endpoint": "#6e7681",
    "error": "#f85149",
}
BG, PANEL, BORDER = "#05060b", "#101522", "#1d2740"
FG, MUT, IDLE = "#eef3fa", "#8d9cb3", "#6e7681"
ACCENT, VIOLET, TRACK, ERR = "#5b8cff", "#9b5bff", "#1d2740", "#f85149"
KEY = "#010101"  # color key made transparent by the window manager
MONO = ("Cascadia Mono", 9)
UI = ("Segoe UI", 9)


class Tooltip:
    def __init__(self, widget, text_fn, tag=None):
        self.widget = widget
        self.text_fn = text_fn
        self.tipwindow = None
        bind = (lambda event, handler: widget.tag_bind(tag, event, handler)) if tag else widget.bind
        bind("<Enter>", self.show_tip)
        bind("<Leave>", self.hide_tip)

    def show_tip(self, event=None):
        text = self.text_fn() if callable(self.text_fn) else self.text_fn
        if self.tipwindow or not text:
            return
        x = getattr(event, "x_root", self.widget.winfo_rootx()) + 10
        y = getattr(event, "y_root", self.widget.winfo_rooty()) - 32
        self.tipwindow = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x}+{y}")
        tw.attributes("-topmost", True)
        label = tk.Label(tw, text=text, justify=tk.LEFT,
                         bg=PANEL, fg=FG, relief=tk.SOLID, borderwidth=1,
                         highlightbackground=BORDER, font=("Segoe UI", 8), padx=8, pady=4)
        label.pack()

    def hide_tip(self, event=None):
        tw = self.tipwindow
        self.tipwindow = None
        if tw:
            tw.destroy()


def get_json(path, timeout=40):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.load(r)


def fetch_usage_cost():
    """Read the live local API-equivalent spend, preserving zero as valid data."""
    try:
        value = float(get_json("/api/usage", timeout=40)["estimatedCostEur"])
        return value if isfinite(value) and value >= 0 else None
    except (OSError, ValueError, TypeError, KeyError):
        return None


def fetch_all():
    """Return [{id, name, status, remaining, reset_str, details_str}]"""
    try:
        providers = get_json("/api/quota", timeout=40)["providers"]
    except (OSError, ValueError, TypeError, KeyError):
        return None
    try:
        out = []
        for d in providers:
            if d.get("id") in WIDGET_HIDDEN_PROVIDER_IDS:
                continue
            metrics = d.get("metrics", [])
            metric_info = []
            details_list = []
            resets = []
            for m in metrics:
                used = m.get("used")
                limit = m.get("limit")
                reset_at = m.get("resetAt")
                sec = parse_reset_sec(reset_at)
                r_str = format_reset(sec)
                rem = 100 - round(100 * used / limit) if used is not None and limit else None
                lbl = m.get("label", "Quota")
                metric_info.append({"rem": rem, "sec": sec})
                if sec is not None:
                    resets.append({
                        "label": lbl,
                        "sec": sec,
                        "reset_at": reset_at,
                        "used_pct": max(0, min(100, 100 - rem)) if rem is not None else 0,
                    })

                if rem is not None:
                    d_item = f"{lbl}: {rem}% left"
                elif used is not None and limit:
                    d_item = f"{lbl}: {used}/{limit}"
                elif m.get("remaining") is not None:
                    d_item = f"{lbl}: {m['remaining']} {m.get('unit', '')}".strip()
                else:
                    d_item = lbl

                if r_str:
                    d_item += f" (resets in {r_str})"
                details_list.append(d_item)

            rems = [m["rem"] for m in metric_info if m["rem"] is not None]
            remaining = max(0, min(100, min(rems))) if rems else None

            reset_sec = None
            valid_resets = [m for m in metric_info if m["sec"] is not None]
            if valid_resets:
                valid_resets.sort(key=lambda x: (x["rem"] if x["rem"] is not None else 999, x["sec"]))
                reset_sec = valid_resets[0]["sec"]

            reset_str = format_reset(reset_sec)
            details_str = " • ".join(details_list) if details_list else d.get("message", STATUS_LABEL.get(d.get("status"), "No detail"))

            out.append({
                "id": d["id"],
                "name": d["name"],
                "status": d.get("status", "error"),
                "remaining": remaining,
                "reset_sec": reset_sec,
                "reset_str": reset_str,
                "resets": resets,
                "details_str": details_str,
            })
        return out
    except (ValueError, TypeError, KeyError):
        return None


def quota_color(remaining):
    """Hue verde -> rosso come i donut web."""
    if remaining is None:
        return IDLE
    if remaining <= 20:
        return ERR
    if remaining <= 40:
        return "#d29922"
    return "#3fb950"


class Widget(tk.Tk):
    def __init__(self):
        super().__init__()
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg=KEY)
        self.attributes("-transparentcolor", KEY)

        self.surface = tk.Toplevel(self)
        self.surface.overrideredirect(True)
        self.surface.attributes("-topmost", True)
        self.surface.configure(bg=BG)
        self.surface.withdraw()

        self.view_mode = "q"  # "q" per tendina Q logo, "bar" per mini bar orizzontale
        self.expanded = True  # open by default so the widget is immediately visible
        self.rows = []
        self.icons = {}
        self.last_data = None
        self.prev_providers = {}
        self.footer_frame = None
        self.horizon_frame = None
        self.minibar_frame = None
        self.bar_orientation = "horizontal"
        self._drag_origin = None
        self._user_positioned = False
        self._refresh_job = None
        self._usage_job = None
        self._tick_job = None
        self._cost_animation_job = None
        self._loading = False
        self._usage_loading = False
        self._quota_online = False
        self._quota_signature = None
        self._last_data_at = time.monotonic()
        self.usage_cost = None
        self.displayed_usage_cost = None
        self._row_reset_labels = {}
        self._minibar_reset_labels = {}
        self._live_labels = []
        self._spend_labels = []
        self._horizon_canvas = None
        self._horizon_next_label = None
        self._horizon_markers = []

        for window in (self, self.surface):
            window.bind("<Double-Button-1>", lambda e: self.destroy())
            window.bind("<ButtonPress-3>", lambda e: self.destroy())
            window.bind("<Escape>", lambda e: self.toggle(e) if self.expanded else None)
            # Both windows drag: the panel now lives on `surface`, so binding only the
            # root left the whole expanded panel as dead space to grab.
            window.bind("<ButtonPress-1>", self._drag_start, add="+")
            window.bind("<B1-Motion>", self.drag)

        # Header: Q logo stilizzata
        self.header = tk.Frame(self, bg=KEY, cursor="hand2")
        self.logo = tk.Canvas(self.header, width=40, height=40, bg=KEY,
                              highlightthickness=0, cursor="hand2")
        self.logo.pack(padx=2, pady=2)
        self.header.pack(anchor="e")
        for w in (self.header, self.logo):
            w.bind("<Button-1>", self.toggle)
        self._draw_logo(None)

        self.panel = tk.Frame(self.surface, bg=BG,
                              highlightbackground=BORDER, highlightthickness=1)
        if self.expanded:
            self.panel.pack()
            self.surface.deiconify()

        # Posizione iniziale: angolo basso-destra dell'area utile, sopra la taskbar.
        self._place_bottom_right()

        self._load_icons()

        # Il logo resta color-keyed e perfettamente trasparente; sfuma solo la superficie glass.
        self.attributes("-alpha", 1.0)
        self.surface.attributes("-alpha", 0.0)
        self._fade(0.0)
        self.after_idle(self._apply_window_effects)
        self.refresh()
        self.refresh_usage()
        self._tick_job = self.after(COUNTDOWN_TICK_MS, self._tick_live_values)

    def _apply_window_effects(self):
        self.update_idletasks()
        self.surface.update_idletasks()

        logo_bounds = (
            "ellipse",
            self.logo.winfo_rootx() - self.winfo_rootx(),
            self.logo.winfo_rooty() - self.winfo_rooty(),
            self.logo.winfo_rootx() - self.winfo_rootx() + self.logo.winfo_width(),
            self.logo.winfo_rooty() - self.winfo_rooty() + self.logo.winfo_height(),
        )
        set_window_shape(native_window_handle(self), [logo_bounds])

        if self.surface.winfo_ismapped():
            surface_handle = native_window_handle(self.surface)
            apply_native_acrylic(surface_handle)
            set_window_shape(surface_handle, [
                ("round", 0, 0, self.surface.winfo_width(), self.surface.winfo_height())
            ])

    def _load_icons(self):
        def _fetch(pid, domain):
            try:
                url = f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
                with urllib.request.urlopen(url, timeout=5) as r:
                    raw = r.read()
                self.after(0, lambda p=pid, data=raw: self._set_icon(p, data))
            except Exception:
                pass

        for pid, domain in DOMAIN_MAP.items():
            threading.Thread(target=_fetch, args=(pid, domain), daemon=True).start()

    def _set_icon(self, pid, raw):
        try:
            img = tk.PhotoImage(data=raw).subsample(2, 2)
            if pid == "codex":
                # Il logo di OpenAI ha tratti neri: convertiamo i tratti scuri in bianco brillante per la dark mode
                w, h = img.width(), img.height()
                new_img = tk.PhotoImage(width=w, height=h)
                for x in range(w):
                    for y in range(h):
                        r, g, b = img.get(x, y)
                        if r < 120 and g < 120 and b < 120:
                            new_img.put("#ffffff", (x, y))
                img = new_img
            self.icons[pid] = img
            if self.last_data:
                self._render(self.last_data)
        except Exception:
            pass

    def _fade(self, a):
        a = min(SURFACE_OPACITY, a + 0.08)
        self.surface.attributes("-alpha", a)
        if a < SURFACE_OPACITY:
            self.after(16, lambda: self._fade(a))

    def _lerp(self, c1, c2, t):
        a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
        b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
        return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(a, b))

    def _draw_logo(self, remaining, offline=False, critical=False):
        c = self.logo
        c.delete("all")
        S = 40 / 64
        ccx, ccy, rr = 31 * S, 30 * S, 20 * S
        w = max(2, round(9 * S))

        # Pulsing outer warning ring for an exhausted or rate-limited quota
        if critical and not offline:
            c.create_oval(ccx - rr - 3, ccy - rr - 3, ccx + rr + 3, ccy + rr + 3,
                          outline=ERR, width=2)

        N = 24
        for i in range(N):
            col = ERR if offline else self._lerp("#22d3ee", "#a855f7", i / (N - 1))
            c.create_arc(ccx - rr, ccy - rr, ccx + rr, ccy + rr,
                         start=135 - i * 360 / N, extent=-(360 / N) - 0.5,
                         outline=col, width=w, style=tk.ARC)

        x1, y1, x2, y2 = 42 * S, 41 * S, 55 * S, 54 * S
        for i in range(6):
            t0, t1 = i / 6, (i + 1) / 6
            col = ERR if offline else self._lerp("#22d3ee", "#a855f7", (t0 + t1) / 2)
            c.create_line(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
                          x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1,
                          fill=col, width=w, capstyle=tk.ROUND)

    def _drag_start(self, e):
        target = self.surface if self.view_mode == "bar" else self
        self._drag_origin = (e.x_root, e.y_root, target.winfo_x(), target.winfo_y())

    def drag(self, e):
        # Move by the pointer delta, not to the pointer. The old code snapped the
        # window's corner under the cursor, which is tolerable when you grab a 44px
        # logo and unusable once you can grab a 300px panel or an 800px mini bar:
        # the thing you grabbed would jump out from under you.
        if not self._drag_origin:
            return
        self._user_positioned = True
        target = self.surface if self.view_mode == "bar" else self
        press_x, press_y, origin_x, origin_y = self._drag_origin
        target.geometry(f"+{origin_x + e.x_root - press_x}+{origin_y + e.y_root - press_y}")
        if self.view_mode == "q":
            self.after_idle(self._sync_surface_to_logo)

    def _sync_surface_to_logo(self):
        if self.view_mode != "q" or not self.expanded:
            return
        self.update_idletasks()
        self.surface.update_idletasks()
        x, y = surface_above_logo_position(
            self.winfo_x(), self.winfo_y(), self.winfo_width(),
            self.surface.winfo_width(), self.surface.winfo_height(),
        )
        self.surface.geometry(f"+{x}+{max(10, y)}")

    def _place_bottom_right(self):
        self.update_idletasks()
        self.surface.update_idletasks()
        area = windows_work_area(self.winfo_screenwidth(), self.winfo_screenheight())
        if self.view_mode == "bar":
            width = max(1, self.surface.winfo_reqwidth())
            height = max(1, self.surface.winfo_reqheight())
            x, y = bottom_center_position(area, width, height)
            self.surface.geometry(f"+{x}+{y}")
            return

        width = max(1, self.winfo_reqwidth())
        height = max(1, self.winfo_reqheight())
        x, y = bottom_right_position(area, width, height)
        self.geometry(f"+{x}+{y}")
        self.after_idle(self._sync_surface_to_logo)

    def toggle(self, e=None):
        if self.view_mode != "q":
            return
        self.expanded = not self.expanded
        if self.expanded:
            self.panel.pack()
            self.surface.deiconify()
            self.after_idle(self._sync_surface_to_logo)
        else:
            self.surface.withdraw()
        if not self._user_positioned:
            self._place_bottom_right()
        self.after_idle(self._apply_window_effects)

    def wake_up(self):
        self.after(0, self._do_wake_up)

    def _do_wake_up(self):
        if self.view_mode == "q":
            self.deiconify()
            if not self.expanded:
                self.expanded = True
                self.panel.pack()
            self.surface.deiconify()
            force_window_visible(self)
            force_window_visible(self.surface)
            self.after_idle(self._sync_surface_to_logo)
        else:
            self.surface.deiconify()
            force_window_visible(self.surface)
        self.lift()
        self.surface.lift()
        self.attributes("-topmost", True)
        self.surface.attributes("-topmost", True)
        if not self._user_positioned:
            self._place_bottom_right()
        self.refresh()


    def switch_view_mode(self):
        self.view_mode = "bar" if self.view_mode == "q" else "q"
        if self.view_mode == "bar":
            if self.expanded:
                self.panel.forget()
                self.expanded = False
            self.withdraw()
            self.surface.deiconify()
        else:
            if self.minibar_frame:
                self.minibar_frame.destroy()
                self.minibar_frame = None
            self.surface.withdraw()
            self.deiconify()

        if self.last_data:
            self._render(self.last_data)
        if self.view_mode == "bar":
            self._place_bottom_right()
            self.after_idle(self._apply_window_effects)

    def toggle_bar_orientation(self):
        self.bar_orientation = "vertical" if self.bar_orientation == "horizontal" else "horizontal"
        if self.last_data:
            self._render_minibar(self.last_data)
            self._place_bottom_right()
            self.after_idle(self._apply_window_effects)

    def refresh(self):
        if self._refresh_job is not None:
            self.after_cancel(self._refresh_job)
        if not self._loading:
            self._loading = True
            threading.Thread(target=self._load, daemon=True).start()
        self._refresh_job = self.after(POLL_MS, self.refresh)

    def _load(self):
        data = fetch_all()
        self.after(0, lambda: self._finish_load(data))

    def _finish_load(self, data):
        self._loading = False
        if data is None:
            self._quota_online = False
            if self.last_data is None:
                self._render(None)
            self._update_live_status()
            return

        signature = quota_signature(data)
        changed = signature != self._quota_signature
        self._last_data_at = time.monotonic()
        self._quota_online = True
        if changed:
            self._quota_signature = signature
            self._render(data)
        else:
            # Refresh the countdown baseline and tooltip payload without replacing
            # any Tk widgets the user is currently hovering or dragging.
            self.last_data = data
            self._update_live_values()
        self._update_live_status()

    def refresh_usage(self):
        if self._usage_job is not None:
            self.after_cancel(self._usage_job)
        if not self._usage_loading:
            self._usage_loading = True
            threading.Thread(target=self._load_usage, daemon=True).start()
        self._usage_job = self.after(USAGE_POLL_MS, self.refresh_usage)

    def _load_usage(self):
        cost = fetch_usage_cost()
        self.after(0, lambda: self._finish_usage(cost))

    def _finish_usage(self, cost):
        self._usage_loading = False
        if cost is not None:
            self.usage_cost = cost
            self._animate_usage_cost(cost)

    def _animate_usage_cost(self, target):
        target = max(0, float(target))
        start = self.displayed_usage_cost if self.displayed_usage_cost is not None else 0.0
        if self._cost_animation_job is not None:
            self.after_cancel(self._cost_animation_job)
            self._cost_animation_job = None
        if format_eur(start) == format_eur(target):
            self.displayed_usage_cost = target
            self._update_spend_labels()
            return

        started_at = time.monotonic()

        def step():
            progress = min(1.0, (time.monotonic() - started_at) / 0.9)
            eased = 1 - (1 - progress) ** 3
            self.displayed_usage_cost = start + (target - start) * eased
            self._update_spend_labels()
            if progress < 1:
                self._cost_animation_job = self.after(33, step)
            else:
                self.displayed_usage_cost = target
                self._cost_animation_job = None
                self._update_spend_labels()

        step()

    def _update_spend_labels(self):
        text = "€ …" if self.displayed_usage_cost is None else f"≈ {format_eur(self.displayed_usage_cost)}"
        for label in self._spend_labels:
            try:
                label.config(text=text)
            except tk.TclError:
                pass

    def _update_live_status(self):
        text = "● LIVE" if self._quota_online else "● RETRY"
        color = STATUS_DOT["ok"] if self._quota_online else STATUS_DOT["rate_limited"]
        for label in self._live_labels:
            try:
                label.config(text=text, fg=color)
            except tk.TclError:
                pass

    def _elapsed_since_load(self):
        return max(0.0, time.monotonic() - self._last_data_at)

    def _provider(self, provider_id):
        return next((provider for provider in (self.last_data or []) if provider["id"] == provider_id), None)

    def _update_live_values(self):
        if not self.last_data:
            return
        elapsed = self._elapsed_since_load()
        for provider_id, label in self._row_reset_labels.items():
            provider = self._provider(provider_id)
            reset = format_reset((provider.get("reset_sec") or 0) - elapsed) if provider else None
            try:
                label.config(text=f"({reset})" if reset else "")
            except tk.TclError:
                pass
        for provider_id, label in self._minibar_reset_labels.items():
            provider = self._provider(provider_id)
            reset = format_reset((provider.get("reset_sec") or 0) - elapsed) if provider else None
            try:
                label.config(text=f"({reset})" if reset else "")
            except tk.TclError:
                pass
        self._update_horizon_values(elapsed)

    def _update_horizon_values(self, elapsed=None):
        canvas = self._horizon_canvas
        if canvas is None or self._horizon_next_label is None:
            return
        elapsed = self._elapsed_since_load() if elapsed is None else elapsed
        events = horizon_events(self.last_data or [], elapsed)
        by_key = {(event["id"], event["label"]): event for event in events}
        left, right, baseline = self._horizon_geometry
        for marker in self._horizon_markers:
            event = by_key.get(marker["key"])
            state = "normal" if event else "hidden"
            for item in marker["items"]:
                canvas.itemconfigure(item, state=state)
            if not event:
                continue
            x = left + horizon_position(event["sec"], right - left)
            stem = 10 + round(event["used_pct"] * 0.24)
            y = baseline - stem
            line, dot, text_item = marker["items"]
            canvas.coords(line, x, baseline, x, y)
            canvas.coords(dot, x - 7, y - 7, x + 7, y + 7)
            canvas.coords(text_item, x, y)
        if events:
            first = events[0]
            next_text = f"next · {first['name']} {first['label']} in {format_reset(first['sec'])}"
        else:
            next_text = "No resets in the next 7 days"
        self._horizon_next_label.config(text=next_text)

    def _tick_live_values(self):
        self._update_live_values()
        self._tick_job = self.after(COUNTDOWN_TICK_MS, self._tick_live_values)

    def _horizon_tooltip(self, key):
        for event in horizon_events(self.last_data or [], self._elapsed_since_load()):
            if (event["id"], event["label"]) == key:
                return f"{event['name']} · {event['label']}\nresets in {format_reset(event['sec'])}"
        return "Reset elapsed"

    def _hover(self, row, on):
        bg = PANEL if on else BG
        for w in (row, *row.winfo_children()):
            if getattr(w, "_keep_bg", False):
                continue
            w.config(bg=bg)

    def _row(self, d):
        color, initial = BRAND.get(d["id"], (ACCENT, d["name"][0]))
        rem = d["remaining"]
        reset_str = d.get("reset_str")
        row = tk.Frame(self.panel, bg=BG)

        img = self.icons.get(d["id"])
        if img:
            chip = tk.Label(row, image=img, bg=BG)
            chip.image = img
            chip._keep_bg = True
            chip.pack(side="left", padx=(8, 6), pady=4)
        else:
            chip = tk.Label(row, text=initial, bg=color, fg="#fff", width=2,
                            font=("Segoe UI", 9, "bold"))
            chip._keep_bg = True  # resta brand anche in hover
            chip.pack(side="left", padx=(8, 6), pady=4)

        tk.Label(row, text=d["name"], bg=BG, fg=FG, font=UI,
                 anchor="w", width=13).pack(side="left")

        bar = tk.Canvas(row, width=56, height=6, bg=BG, highlightthickness=0)
        bar.create_rectangle(0, 0, 56, 6, fill=TRACK, width=0)
        if rem is not None:
            w = max(3, round(56 * rem / 100))
            bar.create_rectangle(0, 0, w, 6, fill=quota_color(rem), width=0)
        bar.pack(side="left", padx=(0, 6))

        if rem is not None:
            tk.Label(row, text=f"{rem}%", bg=BG, fg=quota_color(rem),
                     font=MONO, width=4, anchor="e").pack(side="left")
            rst_txt = f"({reset_str})" if reset_str else ""
            reset_label = tk.Label(row, text=rst_txt, bg=BG, fg=MUT,
                                   font=MONO, width=9, anchor="w")
            reset_label.pack(side="left", padx=(4, 0))
            self._row_reset_labels[d["id"]] = reset_label
        else:
            txt = STATUS_LABEL.get(d["status"], d["status"])
            tk.Label(row, text=txt, bg=BG, fg=MUT,
                     font=MONO, width=14, anchor="e").pack(side="left")

        dot = tk.Canvas(row, width=10, height=10, bg=BG, highlightthickness=0)
        dot.create_oval(1, 1, 9, 9, fill=STATUS_DOT.get(d["status"], IDLE), width=0)
        dot.pack(side="left", padx=(2, 8))

        # Tooltip con dettagli finestre
        Tooltip(row, lambda provider_id=d["id"]: (self._provider(provider_id) or d).get("details_str"))

        row.pack(fill="x")
        for w in (row, *row.winfo_children()):
            w.bind("<Button-1>", self.toggle)
        row.bind("<Enter>", lambda e, r=row: self._hover(r, True))
        row.bind("<Leave>", lambda e, r=row: self._hover(r, False))
        return row

    def _render_horizon(self, data):
        if self.horizon_frame:
            self.horizon_frame.destroy()

        self.horizon_frame = tk.Frame(self.panel, bg=BG)
        self._horizon_markers = []
        events = horizon_events(data)
        tk.Label(self.horizon_frame, text="RESET HORIZON", bg=BG, fg=MUT,
                 font=("Cascadia Mono", 8), anchor="w").pack(fill="x", padx=8, pady=(6, 0))
        if events:
            first = events[0]
            next_text = f"next · {first['name']} {first['label']} in {format_reset(first['sec'])}"
        else:
            next_text = "No resets in the next 7 days"
        self._horizon_next_label = tk.Label(self.horizon_frame, text=next_text, bg=BG, fg=FG,
                                            font=("Segoe UI", 8), anchor="w")
        self._horizon_next_label.pack(fill="x", padx=8)

        width, height, left, right, baseline = 300, 62, 8, 292, 43
        canvas = tk.Canvas(self.horizon_frame, width=width, height=height, bg=BG,
                           highlightthickness=0)
        self._horizon_canvas = canvas
        self._horizon_geometry = (left, right, baseline)
        canvas.create_line(left, baseline, right, baseline, fill=BORDER)
        for sec, label in ((0, "NOW"), (6 * 3600, "6h"), (24 * 3600, "24h"),
                           (72 * 3600, "3d"), (HORIZON_SEC, "7d")):
            x = left + horizon_position(sec, right - left)
            canvas.create_line(x, 8, x, baseline, fill=BORDER)
            canvas.create_text(x, 54, text=label, fill=MUT, font=("Cascadia Mono", 7),
                               anchor="w" if sec == 0 else "center")

        for index, event in enumerate(events):
            x = left + horizon_position(event["sec"], right - left)
            stem = 10 + round(event["used_pct"] * 0.24)
            y = baseline - stem
            color, initial = BRAND.get(event["id"], (ACCENT, event["name"][0]))
            tag = f"horizon-{index}"
            line = canvas.create_line(x, baseline, x, y, fill=color, width=2, tags=tag)
            dot = canvas.create_oval(x - 7, y - 7, x + 7, y + 7, fill=color, outline=BG,
                                     width=2, tags=tag)
            text_item = canvas.create_text(x, y, text=initial, fill="#fff",
                                           font=("Segoe UI", 6, "bold"), tags=tag)
            key = (event["id"], event["label"])
            self._horizon_markers.append({"key": key, "items": (line, dot, text_item)})
            Tooltip(canvas, lambda key=key: self._horizon_tooltip(key), tag=tag)

        canvas.pack(fill="x", padx=4)
        self.horizon_frame.pack(fill="x")

    def _render_minibar(self, data):
        if self.minibar_frame:
            self.minibar_frame.destroy()

        self._minibar_reset_labels = {}
        self._live_labels = []
        self._spend_labels = []
        self.minibar_frame = tk.Frame(self.surface, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        vertical = self.bar_orientation == "vertical"

        for d in data:
            color, initial = BRAND.get(d["id"], (ACCENT, d["name"][0]))
            rem = d["remaining"]
            reset_str = d.get("reset_str")

            item = tk.Frame(self.minibar_frame, bg=PANEL)
            img = self.icons.get(d["id"])
            if img:
                lbl_icon = tk.Label(item, image=img, bg=PANEL)
                lbl_icon.image = img
                lbl_icon.pack(side="left", padx=(3, 1), pady=2)
            else:
                tk.Label(item, text=initial, bg=color, fg="#fff", font=("Segoe UI", 8, "bold"), width=2).pack(side="left", padx=(3, 1), pady=2)

            txt = f"{rem}%" if rem is not None else STATUS_LABEL.get(d["status"], d["status"])
            lbl_txt = tk.Label(item, text=txt, bg=PANEL, fg=quota_color(rem) if rem is not None else MUT, font=MONO)
            lbl_txt.pack(side="left", padx=1)

            if reset_str:
                reset_label = tk.Label(item, text=f"({reset_str})", bg=PANEL, fg=MUT, font=MONO)
                reset_label.pack(side="left", padx=(0, 2))
                self._minibar_reset_labels[d["id"]] = reset_label

            # Tooltip al passaggio del mouse
            Tooltip(item, lambda provider_id=d["id"]: (self._provider(provider_id) or d).get("details_str"))

            if vertical:
                item.pack(fill="x", padx=3, pady=1)
            else:
                item.pack(side="left", padx=2)

        controls = tk.Frame(self.minibar_frame, bg=PANEL)
        spend = tk.Label(controls, text="€ …", bg=PANEL, fg="#b8f1c0", font=MONO)
        spend.pack(side="left", padx=(4, 3), pady=2)
        Tooltip(spend, "Live local API-equivalent token spend")
        self._spend_labels.append(spend)

        live = tk.Label(controls, text="● LIVE", bg=PANEL, fg=STATUS_DOT["ok"], font=("Cascadia Mono", 8))
        live.pack(side="left", padx=(1, 3), pady=2)
        Tooltip(live, "Silent updates: spend every 5 seconds, quotas every minute")
        self._live_labels.append(live)

        orientation_text = "[ ↔ ]" if vertical else "[ ↕ ]"
        orientation_tip = "Switch to horizontal mini bar" if vertical else "Switch to vertical mini bar"
        btn_orientation = tk.Label(controls, text=orientation_text, bg=PANEL, fg=VIOLET,
                                   font=UI, cursor="hand2")
        btn_orientation.pack(side="left", padx=(4, 2), pady=2)
        btn_orientation.bind("<Button-1>", lambda e: self.toggle_bar_orientation())
        Tooltip(btn_orientation, orientation_tip)

        btn_switch = tk.Label(controls, text="[ Q Logo ]", bg=PANEL, fg=ACCENT,
                              font=UI, cursor="hand2")
        btn_switch.pack(side="left", padx=(2, 6), pady=2)
        btn_switch.bind("<Button-1>", lambda e: self.switch_view_mode())
        Tooltip(btn_switch, "Switch to Q logo")

        if vertical:
            controls.pack(fill="x")
        else:
            controls.pack(side="left")

        self.minibar_frame.pack()
        self.minibar_frame.bind("<B1-Motion>", self.drag)
        self._update_spend_labels()
        self._update_live_status()

    def _check_notifications(self, data):
        for d in data:
            pid = d["id"]
            prev = self.prev_providers.get(pid, {})
            p_rem = prev.get("remaining")
            p_status = prev.get("status")
            n_rem = d.get("remaining")
            n_status = d.get("status")

            if p_rem is not None and p_rem > 15 and n_rem is not None and n_rem <= 15:
                send_win_notification("LLM Quota — Low Quota Warning", f"{d['name']} is down to {n_rem}%.")
            if p_status != "rate_limited" and n_status == "rate_limited":
                send_win_notification("LLM Quota — Rate Limit", f"{d['name']} has hit its rate limit.")
            if p_rem is not None and p_rem < 50 and n_rem == 100:
                send_win_notification("LLM Quota — Quota Reset", f"{d['name']} is back to 100%.")

            self.prev_providers[pid] = {"remaining": n_rem, "status": n_status}

    def _render(self, data):
        if data is None:
            self._draw_logo(None, offline=True)
            return
        self.last_data = data
        self._check_notifications(data)
        self._live_labels = []
        self._spend_labels = []

        worst = [d["remaining"] for d in data if d["remaining"] is not None]
        mn = min(worst) if worst else None
        critical = (mn is not None and mn <= 15) or any(d.get("status") == "rate_limited" for d in data)
        self._draw_logo(mn, critical=critical)

        if self.view_mode == "bar":
            self._render_minibar(data)
            if not self._user_positioned:
                self._place_bottom_right()
            self.after_idle(self._apply_window_effects)
            return

        for w in self.rows:
            w.destroy()
        self._row_reset_labels = {}
        self._render_horizon(data)
        if self.footer_frame:
            self.footer_frame.destroy()
            self.footer_frame = None

        self.rows = [self._row(d) for d in data]

        # Live footer: navigation plus silent-update state and local spend.
        self.footer_frame = tk.Frame(self.panel, bg=BG)
        dash_btn = tk.Label(self.footer_frame, text="Dashboard ↗", bg=BG, fg=ACCENT, font=UI, cursor="hand2")
        dash_btn.pack(side="left", padx=(8, 0), pady=(4, 6))
        dash_btn.bind("<Button-1>", lambda e: webbrowser.open(BASE))

        switch_btn = tk.Label(self.footer_frame, text="⇄ Mini Bar", bg=BG, fg=VIOLET, font=UI, cursor="hand2")
        switch_btn.pack(side="left", padx=(10, 0), pady=(4, 6))
        switch_btn.bind("<Button-1>", lambda e: self.switch_view_mode())

        live = tk.Label(self.footer_frame, text="● LIVE", bg=BG, fg=STATUS_DOT["ok"],
                        font=("Cascadia Mono", 8))
        live.pack(side="right", padx=(4, 8), pady=(4, 6))
        Tooltip(live, "Silent updates: spend every 5 seconds, quotas every minute")
        self._live_labels.append(live)

        spend = tk.Label(self.footer_frame, text="€ …", bg=BG, fg="#b8f1c0", font=MONO)
        spend.pack(side="right", padx=(4, 0), pady=(4, 6))
        Tooltip(spend, "Live local API-equivalent token spend")
        self._spend_labels.append(spend)

        self.footer_frame.pack(fill="x")

        if not self._user_positioned:
            self._place_bottom_right()
        else:
            self.after_idle(self._sync_surface_to_logo)
        self.after_idle(self._apply_window_effects)
        self._update_spend_labels()
        self._update_live_status()
        self._update_live_values()


if __name__ == "__main__":
    if "--register-protocol" in sys.argv:
        print(register_protocol())
        raise SystemExit(0)
    widget_ref = []
    instance_mutex = acquire_single_instance(lambda: widget_ref and widget_ref[0].wake_up())
    if instance_mutex is None:
        raise SystemExit(0)
    w = Widget()
    widget_ref.append(w)
    if "--selftest" in sys.argv:
        w.after(3000, w.destroy)
    w.mainloop()
    print("widget ok")

