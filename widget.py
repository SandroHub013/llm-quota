"""LLM Quota desktop widget — always-on-top.

Supporta 2 modalità di visualizzazione:
1. Modalità Tendina Q Logo (Q icon + pannello a comparsa)
2. Modalità Mini Bar (barra orizzontale sempre visibile a schermo)

Caratteristiche avanzate:
- Loghi reali dei provider (Claude, ChatGPT/Codex, Z.ai, OpenCode, Gemini, Kimi)
- Ore/tempo mancante al reset in ciascuna quota
- Tooltip al passaggio del mouse con il dettaglio di tutte le finestre
- Avviso visivo (anello rosso pulsante sulla Q) quando la quota è <= 15% o rate_limited
- Notifiche Windows Toast per avvisi quota bassa o reset quota
- Pulsanti Dashboard ↗ e Switch Vista (Q Logo <-> Mini Bar) per testare entrambe le modalità.
"""
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import re
import subprocess
import sys
import threading
import tkinter as tk
import urllib.request
import webbrowser
import winreg
from datetime import datetime, timezone

BASE = "http://localhost:4747"
POLL_MS = 5 * 60_000
MUTEX_NAME = "Local\\LLMQuotaWidget"


def acquire_single_instance():
    """Return a process-held Windows mutex, or None when widget is already open."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    create_mutex.restype = wintypes.HANDLE
    handle = create_mutex(None, False, MUTEX_NAME)
    if not handle:
        return None
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return None
    return handle


class Rect(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


def bottom_right_position(work_area, width, height, margin=12):
    left, top, right, bottom = work_area
    return (
        max(left + margin, right - width - margin),
        max(top + margin, bottom - height - margin),
    )


def windows_work_area(screen_width, screen_height):
    rect = Rect()
    if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
        return rect.left, rect.top, rect.right, rect.bottom
    return 0, 0, screen_width, screen_height


def protocol_command(python_executable, script_path):
    pythonw = re.sub(r"python\.exe$", "pythonw.exe", python_executable, flags=re.IGNORECASE)
    return f'"{pythonw}" "{script_path}" "%1"'


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
    command = protocol_command(python_executable, os.path.abspath(__file__))
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
    "opencode-zen": "opencode.ai",
    "gemini": "gemini.google.com",
    "moonshot": "kimi.com",
}


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
        return f"{days}g {h}h" if h > 0 else f"{days}g"


BRAND = {
    "claude": ("#d97757", "C"),
    "codex": ("#10a37f", "C"),
    "zai": ("#4f7cff", "Z"),
    "opencode-zen": ("#9b5bff", "Z"),
    "gemini": ("#4285f4", "G"),
    "moonshot": ("#0ea5e9", "K"),
}
STATUS_IT = {
    "ok": "attivo",
    "partial": "parziale",
    "rate_limited": "rate limited",
    "unauthenticated": "login mancante",
    "no_endpoint": "no API quota",
    "error": "errore",
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
KEY = "#010101"  # color key reso trasparente dalla finestra
MONO = ("Cascadia Mono", 9)
UI = ("Segoe UI", 9)


class Tooltip:
    def __init__(self, widget, text_fn):
        self.widget = widget
        self.text_fn = text_fn
        self.tipwindow = None
        self.widget.bind("<Enter>", self.show_tip)
        self.widget.bind("<Leave>", self.hide_tip)

    def show_tip(self, event=None):
        text = self.text_fn() if callable(self.text_fn) else self.text_fn
        if self.tipwindow or not text:
            return
        x = self.widget.winfo_rootx() + 10
        y = self.widget.winfo_rooty() - 32
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


def fetch_all():
    """Return [{id, name, status, remaining, reset_str, details_str}]"""
    try:
        providers = get_json("/api/quota", timeout=40)["providers"]
    except (OSError, ValueError, TypeError, KeyError):
        return None
    try:
        out = []
        for d in providers:
            metrics = d.get("metrics", [])
            metric_info = []
            details_list = []
            for m in metrics:
                used = m.get("used")
                limit = m.get("limit")
                reset_at = m.get("resetAt")
                sec = parse_reset_sec(reset_at)
                r_str = format_reset(sec)
                rem = 100 - round(100 * used / limit) if used is not None and limit else None
                metric_info.append({"rem": rem, "sec": sec})

                lbl = m.get("label", "Quota")
                if rem is not None:
                    d_item = f"{lbl}: {rem}% residui"
                elif used is not None and limit:
                    d_item = f"{lbl}: {used}/{limit}"
                elif m.get("remaining") is not None:
                    d_item = f"{lbl}: {m['remaining']} {m.get('unit', '')}".strip()
                else:
                    d_item = lbl

                if r_str:
                    d_item += f" (reset tra {r_str})"
                details_list.append(d_item)

            rems = [m["rem"] for m in metric_info if m["rem"] is not None]
            remaining = max(0, min(100, min(rems))) if rems else None

            reset_sec = None
            valid_resets = [m for m in metric_info if m["sec"] is not None]
            if valid_resets:
                valid_resets.sort(key=lambda x: (x["rem"] if x["rem"] is not None else 999, x["sec"]))
                reset_sec = valid_resets[0]["sec"]

            reset_str = format_reset(reset_sec)
            details_str = " • ".join(details_list) if details_list else d.get("message", STATUS_IT.get(d.get("status"), "Nessun dettaglio"))

            out.append({
                "id": d["id"],
                "name": d["name"],
                "status": d.get("status", "error"),
                "remaining": remaining,
                "reset_str": reset_str,
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

        self.view_mode = "q"  # "q" per tendina Q logo, "bar" per mini bar orizzontale
        self.expanded = True  # Aperto di default per essere subito visibile
        self.rows = []
        self.icons = {}
        self.last_data = None
        self.prev_providers = {}
        self.footer_frame = None
        self.minibar_frame = None
        self._user_positioned = False
        self._refresh_job = None
        self._loading = False

        self.bind("<Double-Button-1>", lambda e: self.destroy())
        self.bind("<B1-Motion>", self.drag)
        self.bind("<ButtonPress-3>", lambda e: self.destroy())
        self.bind("<Escape>", lambda e: self.toggle(e) if self.expanded else None)

        # Header: Q logo stilizzata
        self.header = tk.Frame(self, bg=KEY, cursor="hand2")
        self.logo = tk.Canvas(self.header, width=40, height=40, bg=KEY,
                              highlightthickness=0, cursor="hand2")
        self.logo.pack(padx=2, pady=2)
        self.header.pack(anchor="e")
        for w in (self.header, self.logo):
            w.bind("<Button-1>", self.toggle)
        self._draw_logo(None)

        self.panel = tk.Frame(self, bg=BG,
                              highlightbackground=BORDER, highlightthickness=1)
        if self.expanded:
            self.panel.pack(before=self.header)

        # Posizione iniziale: angolo basso-destra dell'area utile, sopra la taskbar.
        self._place_bottom_right()

        self._load_icons()

        # Fade-in all'avvio
        self.attributes("-alpha", 0.0)
        self._fade(0.0)
        self.refresh()

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
        a = min(1.0, a + 0.08)
        self.attributes("-alpha", a)
        if a < 1.0:
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

        # Anello esterno pulsante di avviso per quota esaurita / rate limit
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

    def drag(self, e):
        self._user_positioned = True
        self.geometry(f"+{e.x_root - 22}+{e.y_root - 22}")

    def _place_bottom_right(self):
        self.update_idletasks()
        area = windows_work_area(self.winfo_screenwidth(), self.winfo_screenheight())
        width = max(1, self.winfo_reqwidth())
        height = max(1, self.winfo_reqheight())
        x, y = bottom_right_position(area, width, height)
        self.geometry(f"+{x}+{y}")

    def _anchor_logo(self, lx, ly):
        if lx is None or ly is None or lx <= 10 or ly <= 10:
            return
        self.update_idletasks()
        cur_x, cur_y = self.logo.winfo_rootx(), self.logo.winfo_rooty()
        if cur_x <= 10 or cur_y <= 10:
            return
        dx = cur_x - lx
        dy = cur_y - ly
        if dx or dy:
            y = max(10, self.winfo_y() - dy)
            x = max(10, self.winfo_x() - dx)
            self.geometry(f"+{x}+{y}")

    def toggle(self, e=None):
        if self.view_mode != "q":
            return
        lx = self.logo.winfo_rootx() if self._user_positioned else None
        ly = self.logo.winfo_rooty() if self._user_positioned else None
        self.expanded = not self.expanded
        if self.expanded:
            self.panel.pack(before=self.header)
        else:
            self.panel.forget()
        if self._user_positioned:
            self._anchor_logo(lx, ly)
        else:
            self._place_bottom_right()

    def switch_view_mode(self):
        self.view_mode = "bar" if self.view_mode == "q" else "q"
        if self.view_mode == "bar":
            if self.expanded:
                self.panel.forget()
                self.expanded = False
            self.header.pack_forget()
        else:
            if self.minibar_frame:
                self.minibar_frame.destroy()
                self.minibar_frame = None
            self.header.pack(anchor="e")

        if self.last_data:
            self._render(self.last_data)

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
        self._render(data)

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
            tk.Label(row, text=rst_txt, bg=BG, fg=MUT,
                     font=MONO, width=9, anchor="w").pack(side="left", padx=(4, 0))
        else:
            txt = STATUS_IT.get(d["status"], d["status"])
            tk.Label(row, text=txt, bg=BG, fg=MUT,
                     font=MONO, width=14, anchor="e").pack(side="left")

        dot = tk.Canvas(row, width=10, height=10, bg=BG, highlightthickness=0)
        dot.create_oval(1, 1, 9, 9, fill=STATUS_DOT.get(d["status"], IDLE), width=0)
        dot.pack(side="left", padx=(2, 8))

        # Tooltip con dettagli finestre
        Tooltip(row, lambda: d.get("details_str"))

        row.pack(fill="x")
        for w in (row, *row.winfo_children()):
            w.bind("<Button-1>", self.toggle)
        row.bind("<Enter>", lambda e, r=row: self._hover(r, True))
        row.bind("<Leave>", lambda e, r=row: self._hover(r, False))
        return row

    def _render_minibar(self, data):
        if self.minibar_frame:
            self.minibar_frame.destroy()

        self.minibar_frame = tk.Frame(self, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)

        for d in data:
            color, initial = BRAND.get(d["id"], (ACCENT, d["name"][0]))
            rem = d["remaining"]
            reset_str = d.get("reset_str")

            item = tk.Frame(self.minibar_frame, bg=PANEL)
            img = self.icons.get(d["id"])
            if img:
                lbl_icon = tk.Label(item, image=img, bg=PANEL)
                lbl_icon.image = img
                lbl_icon.pack(side="left", padx=(4, 2), pady=2)
            else:
                tk.Label(item, text=initial, bg=color, fg="#fff", font=("Segoe UI", 8, "bold"), width=2).pack(side="left", padx=(4, 2), pady=2)

            txt = f"{rem}%" if rem is not None else STATUS_IT.get(d["status"], d["status"])
            lbl_txt = tk.Label(item, text=txt, bg=PANEL, fg=quota_color(rem) if rem is not None else MUT, font=MONO)
            lbl_txt.pack(side="left", padx=(2, 2))

            if reset_str:
                tk.Label(item, text=f"({reset_str})", bg=PANEL, fg=MUT, font=MONO).pack(side="left", padx=(0, 4))

            # Tooltip al passaggio del mouse
            Tooltip(item, lambda d=d: d.get("details_str"))

            item.pack(side="left", padx=4)

        # Switch mode button
        btn_switch = tk.Label(self.minibar_frame, text="[ ⇄ Q Logo ]", bg=PANEL, fg=ACCENT, font=UI, cursor="hand2")
        btn_switch.pack(side="left", padx=(6, 8))
        btn_switch.bind("<Button-1>", lambda e: self.switch_view_mode())

        self.minibar_frame.pack()
        self.minibar_frame.bind("<B1-Motion>", self.drag)

    def _check_notifications(self, data):
        for d in data:
            pid = d["id"]
            prev = self.prev_providers.get(pid, {})
            p_rem = prev.get("remaining")
            p_status = prev.get("status")
            n_rem = d.get("remaining")
            n_status = d.get("status")

            if p_rem is not None and p_rem > 15 and n_rem is not None and n_rem <= 15:
                send_win_notification("LLM Quota — Avviso Quota Bassa", f"La quota per {d['name']} è al {n_rem}%!")
            if p_status != "rate_limited" and n_status == "rate_limited":
                send_win_notification("LLM Quota — Rate Limit", f"Il provider {d['name']} ha raggiunto il rate limit.")
            if p_rem is not None and p_rem < 50 and n_rem == 100:
                send_win_notification("LLM Quota — Quota Resettata", f"La quota per {d['name']} è stata resettata al 100%!")

            self.prev_providers[pid] = {"remaining": n_rem, "status": n_status}

    def _render(self, data):
        if data is None:
            self._draw_logo(None, offline=True)
            return
        self.last_data = data
        self._check_notifications(data)

        worst = [d["remaining"] for d in data if d["remaining"] is not None]
        mn = min(worst) if worst else None
        critical = (mn is not None and mn <= 15) or any(d.get("status") == "rate_limited" for d in data)
        self._draw_logo(mn, critical=critical)

        if self.view_mode == "bar":
            self._render_minibar(data)
            if not self._user_positioned:
                self._place_bottom_right()
            return

        for w in self.rows:
            w.destroy()
        if self.footer_frame:
            self.footer_frame.destroy()
            self.footer_frame = None

        self.rows = [self._row(d) for d in data]

        # Sleek footer: Dashboard link, Switch Vista e refresh manuale
        self.footer_frame = tk.Frame(self.panel, bg=BG)
        dash_btn = tk.Label(self.footer_frame, text="Dashboard ↗", bg=BG, fg=ACCENT, font=UI, cursor="hand2")
        dash_btn.pack(side="left", padx=(8, 0), pady=(4, 6))
        dash_btn.bind("<Button-1>", lambda e: webbrowser.open(BASE))

        switch_btn = tk.Label(self.footer_frame, text="⇄ Mini Bar", bg=BG, fg=VIOLET, font=UI, cursor="hand2")
        switch_btn.pack(side="left", padx=(10, 0), pady=(4, 6))
        switch_btn.bind("<Button-1>", lambda e: self.switch_view_mode())

        ref_btn = tk.Label(self.footer_frame, text="↻ Aggiorna", bg=BG, fg=MUT, font=UI, cursor="hand2")
        ref_btn.pack(side="right", padx=(0, 8), pady=(4, 6))
        ref_btn.bind("<Button-1>", lambda e: self.refresh())

        self.footer_frame.pack(fill="x")

        if not self._user_positioned:
            self._place_bottom_right()


if __name__ == "__main__":
    if "--register-protocol" in sys.argv:
        print(register_protocol())
        raise SystemExit(0)
    instance_mutex = acquire_single_instance()
    if instance_mutex is None:
        raise SystemExit(0)
    w = Widget()
    if "--selftest" in sys.argv:
        w.after(3000, w.destroy)
    w.mainloop()
    print("widget ok")
