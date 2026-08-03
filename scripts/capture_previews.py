"""Generate documentation and social previews from synthetic local data.

The script serves ./public on an ephemeral loopback port and intercepts every API
request in Playwright. It never reads the developer's credentials, CLI history,
GitHub account, or running LLM Quota server.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image
from playwright.sync_api import Route, sync_playwright

try:
    import pillow_avif  # noqa: F401 — registers AVIF with Pillow
except ImportError as error:  # pragma: no cover - dependency guidance for humans
    raise SystemExit(
        "pillow-avif-plugin is required: uv run --with playwright --with pillow "
        "--with pillow-avif-plugin python scripts/capture_previews.py"
    ) from error


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
DOCS = ROOT / "docs"
NOW = datetime.now(timezone.utc)
TARGET_COST_EUR = 186.42


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass


@contextmanager
def local_site():
    handler = partial(QuietHandler, directory=str(PUBLIC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def iso_after(**kwargs: int) -> str:
    return (NOW + timedelta(**kwargs)).isoformat().replace("+00:00", "Z")


def token_totals(seed: int) -> dict[str, int]:
    input_tokens = 420_000 + seed * 17_000
    cache_read = 1_100_000 + seed * 41_000
    cache_write = 75_000 + seed * 3_000
    output = 180_000 + seed * 9_000
    reasoning = 48_000 + seed * 2_000
    return {
        "input": input_tokens,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "output": output,
        "reasoning": reasoning,
        "total": input_tokens + cache_read + cache_write + output,
    }


def quota_fixture() -> dict:
    providers = [
        {
            "id": "claude",
            "name": "Claude Code",
            "status": "ok",
            "plan": "max",
            "sourceLabel": "Claude Code status line",
            "consoleUrl": "https://claude.ai/settings/usage",
            "updatedAt": NOW.isoformat(),
            "metrics": [
                {"label": "Session (5h)", "used": 38, "limit": 100, "unit": "percent", "resetAt": iso_after(hours=3, minutes=42)},
                {"label": "Weekly (7d)", "used": 63, "limit": 100, "unit": "percent", "resetAt": iso_after(days=4, hours=18)},
            ],
        },
        {
            "id": "codex",
            "name": "Codex (ChatGPT)",
            "status": "ok",
            "plan": "plus",
            "sourceLabel": "Codex app-server",
            "consoleUrl": "https://chatgpt.com",
            "updatedAt": NOW.isoformat(),
            "metrics": [
                {"label": "Weekly (7d)", "used": 42, "limit": 100, "unit": "percent", "resetAt": iso_after(days=5, hours=9)},
            ],
        },
        {
            "id": "zai",
            "name": "z.ai",
            "status": "no_endpoint",
            "sourceLabel": "official plugin / console",
            "consoleUrl": "https://z.ai/manage-apikey/apikey-list",
            "updatedAt": NOW.isoformat(),
            "metrics": [],
            "message": "Quota available through the official Usage Query plugin; no public dashboard API.",
        },
        {
            "id": "gemini",
            "name": "Gemini",
            "status": "ok",
            "plan": "Google AI Pro",
            "sourceLabel": "Antigravity status line",
            "consoleUrl": "https://antigravity.google/",
            "updatedAt": NOW.isoformat(),
            "metrics": [
                {"label": "Gemini models \u00b7 Weekly (7d)", "used": 29, "limit": 100, "unit": "percent", "resetAt": iso_after(days=2, hours=8)},
                {"label": "Gemini models \u00b7 Session (5h)", "used": 16, "limit": 100, "unit": "percent", "resetAt": iso_after(hours=4, minutes=11)},
                {"label": "Claude and GPT models \u00b7 Weekly (7d)", "used": 7, "limit": 100, "unit": "percent", "resetAt": iso_after(days=6, hours=2)},
                {"label": "Claude and GPT models \u00b7 Session (5h)", "used": 21, "limit": 100, "unit": "percent", "resetAt": iso_after(hours=2, minutes=46)},
            ],
        },
        {
            "id": "moonshot",
            "name": "Kimi / Moonshot",
            "status": "ok",
            "sourceLabel": "Moonshot Open Platform balance API",
            "consoleUrl": "https://platform.moonshot.ai/console/account",
            "updatedAt": NOW.isoformat(),
            "metrics": [
                {"label": "Available API credit", "remaining": 46.2, "unit": "cny"},
            ],
        },
    ]
    return {"providers": providers, "generatedAt": NOW.isoformat()}


def usage_fixture() -> dict:
    today = NOW.date()
    daily = []
    for offset in range(180):
        if offset % 3 != 0 and offset % 11 != 0:
            continue
        totals = token_totals((offset % 9) + 1)
        daily.append(
            {
                "date": (today - timedelta(days=offset)).isoformat(),
                "calls": 8 + offset % 13,
                "tokens": totals,
                "contextReusePct": round(
                    totals["cacheRead"]
                    / (totals["input"] + totals["cacheRead"] + totals["cacheWrite"])
                    * 100,
                    1,
                ),
                "estimatedCostEur": 1.25 + (offset % 17) * 0.31,
                "pricingCoveragePct": 96.4,
                "sources": ["codex", "claude"] if offset % 2 == 0 else ["opencode", "kimi"],
            }
        )

    raw_cost = sum(day["estimatedCostEur"] for day in daily)
    for day in daily:
        day["estimatedCostEur"] = round(day["estimatedCostEur"] * TARGET_COST_EUR / raw_cost, 2)
    daily[0]["estimatedCostEur"] = round(
        daily[0]["estimatedCostEur"] + TARGET_COST_EUR - sum(day["estimatedCostEur"] for day in daily),
        2,
    )

    totals = {
        key: sum(day["tokens"][key] for day in daily)
        for key in ("input", "cacheRead", "cacheWrite", "output", "reasoning", "total")
    }
    context = totals["input"] + totals["cacheRead"] + totals["cacheWrite"]
    context_reuse = round(totals["cacheRead"] / context * 100, 1)

    return {
        "estimatedCostEur": TARGET_COST_EUR,
        "estimatedCostUsd": round(TARGET_COST_EUR * 1.1485, 2),
        "currency": "EUR",
        "tokens": totals,
        "contextReusePct": context_reuse,
        "pricedTokens": round(totals["total"] * 0.964),
        "pricingCoveragePct": 96.4,
        "rows": [
            {"source": "codex", "sourceName": "Codex", "model": "gpt-5.6-sol", "effort": "high", "agent": "main", "calls": 128, **token_totals(7), "contextReusePct": 74.3, "costUsd": 92.10, "costEur": 80.19, "costBasis": "public_list"},
            {"source": "claude", "sourceName": "Claude Code", "model": "claude-fable-5", "effort": "high", "agent": "main", "calls": 86, **token_totals(5), "contextReusePct": 69.8, "costUsd": 71.20, "costEur": 61.99, "costBasis": "public_list"},
            {"source": "opencode", "sourceName": "OpenCode", "model": "glm-4.7", "effort": "medium", "agent": "subagent", "calls": 64, **token_totals(3), "contextReusePct": 77.1, "costUsd": 31.80, "costEur": 27.69, "costBasis": "public_list"},
            {"source": "kimi", "sourceName": "Kimi Code", "model": "kimi-k2.7-code", "effort": "high", "agent": "main", "calls": 41, **token_totals(2), "contextReusePct": 65.4, "costUsd": 19.00, "costEur": 16.55, "costBasis": "public_list"},
        ],
        "daily": daily,
        "sources": [
            {"id": "codex", "name": "Codex", "status": "ok", "files": 24},
            {"id": "claude", "name": "Claude Code", "status": "ok", "files": 18},
            {"id": "opencode", "name": "OpenCode", "status": "ok", "files": 11},
            {"id": "kimi", "name": "Kimi Code", "status": "ok", "files": 9},
            {"id": "gemini", "name": "Gemini", "status": "unsupported", "message": "No local token log format is available."},
        ],
        "unpricedModels": [],
        "generatedAt": NOW.isoformat(),
        "pricing": {
            "kind": "api_equivalent",
            "asOf": "2026-08-02",
            "usdPerEur": 1.1485,
            "fxAsOf": "2026-07-31",
            "note": "Estimated API-equivalent value, not the amount charged by subscription plans.",
        },
    }


def api_handler(route: Route, quota: dict, usage: dict) -> None:
    path = urlparse(route.request.url).path
    if path == "/api/quota":
        route.fulfill(json=quota)
    elif path == "/api/usage":
        route.fulfill(json=usage)
    elif path == "/api/prototype/github-contributions":
        route.fulfill(
            json={
                "status": "unavailable",
                "message": "Optional GitHub view — authenticate with the GitHub CLI to show your account.",
                "generatedAt": NOW.isoformat(),
            }
        )
    else:
        route.fulfill(status=404, json={"error": "unexpected synthetic preview endpoint"})


def capture(page, url: str, width: int, height: int) -> bytes:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(url, wait_until="networkidle")
    page.wait_for_function("document.querySelector('#liveStatusText')?.textContent === 'Live'")
    page.wait_for_timeout(600)
    return page.screenshot(type="png", full_page=False)


def save(image_bytes: bytes, path: Path, image_format: str, **options) -> None:
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image.save(path, image_format, **options)


def main() -> None:
    quota = quota_fixture()
    usage = usage_fixture()
    with local_site() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(
            locale="en-US",
            color_scheme="dark",
            reduced_motion="reduce",
            device_scale_factor=1,
        )
        page = context.new_page()
        page.route("**/api/**", lambda route: api_handler(route, quota, usage))
        dashboard = capture(page, url, 1600, 800)
        social = capture(page, url, 1280, 640)
        context.close()
        browser.close()

    save(dashboard, DOCS / "dashboard-preview.jpg", "JPEG", quality=91, optimize=True, progressive=True)
    save(dashboard, DOCS / "dashboard-preview.webp", "WEBP", quality=88, method=6)
    save(dashboard, DOCS / "dashboard-preview.avif", "AVIF", quality=74)
    save(social, DOCS / "og.jpg", "JPEG", quality=90, optimize=True, progressive=True)
    save(social, PUBLIC / "og.jpg", "JPEG", quality=90, optimize=True, progressive=True)

    for path in (
        DOCS / "dashboard-preview.jpg",
        DOCS / "dashboard-preview.webp",
        DOCS / "dashboard-preview.avif",
        DOCS / "og.jpg",
        PUBLIC / "og.jpg",
    ):
        print(f"{path.relative_to(ROOT)} — {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
