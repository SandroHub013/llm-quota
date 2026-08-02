import unittest
from unittest.mock import patch

import widget


class FetchAllTest(unittest.TestCase):
    @patch("widget.get_json")
    def test_uses_one_aggregate_request(self, get_json):
        get_json.return_value = {
            "providers": [
                {
                    "id": "codex",
                    "name": "Codex",
                    "status": "ok",
                    "metrics": [{"used": 25, "limit": 100, "unit": "percent"}],
                },
                {
                    "id": "moonshot",
                    "name": "Moonshot",
                    "status": "ok",
                    "metrics": [{"remaining": 10, "unit": "cny"}],
                },
            ]
        }

        self.assertEqual(
            widget.fetch_all(),
            [
                {
                    "id": "codex", "name": "Codex", "status": "ok", "remaining": 75,
                    "reset_sec": None, "reset_str": None, "resets": [],
                    "details_str": "Quota: 75% left",
                },
                {
                    "id": "moonshot", "name": "Moonshot", "status": "ok", "remaining": None,
                    "reset_sec": None, "reset_str": None, "resets": [],
                    "details_str": "Quota: 10 cny",
                },
            ],
        )
        get_json.assert_called_once_with("/api/quota", timeout=40)

    @patch("widget.get_json")
    def test_hides_opencode_quota_but_keeps_measurable_providers(self, get_json):
        get_json.return_value = {
            "providers": [
                {
                    "id": "opencode-zen",
                    "name": "OpenCode Zen",
                    "status": "no_endpoint",
                    "metrics": [],
                },
                {
                    "id": "codex",
                    "name": "Codex",
                    "status": "ok",
                    "metrics": [{"used": 25, "limit": 100}],
                },
            ]
        }

        self.assertEqual([provider["id"] for provider in widget.fetch_all()], ["codex"])

    @patch("widget.get_json", return_value={"providers": [{"id": "broken"}]})
    def test_malformed_provider_payload_marks_widget_offline(self, _get_json):
        self.assertIsNone(widget.fetch_all())

    @patch("widget.parse_reset_sec", side_effect=[3600, widget.HORIZON_SEC + 1])
    @patch("widget.get_json")
    def test_preserves_every_metric_reset_for_the_horizon(self, get_json, _parse_reset_sec):
        get_json.return_value = {
            "providers": [{
                "id": "claude",
                "name": "Claude",
                "status": "ok",
                "metrics": [
                    {"label": "Session (5h)", "used": 25, "limit": 100, "resetAt": "soon"},
                    {"label": "Weekly (7d)", "used": 60, "limit": 100, "resetAt": "later"},
                ],
            }]
        }

        result = widget.fetch_all()

        self.assertEqual(result[0]["resets"], [
            {"label": "Session (5h)", "sec": 3600, "reset_at": "soon", "used_pct": 25},
            {"label": "Weekly (7d)", "sec": widget.HORIZON_SEC + 1, "reset_at": "later", "used_pct": 60},
        ])
        self.assertEqual([event["label"] for event in widget.horizon_events(result)], ["Session (5h)"])

    @patch("widget.get_json", return_value={"estimatedCostEur": 12.34})
    def test_reads_live_local_spend(self, get_json):
        self.assertEqual(widget.fetch_usage_cost(), 12.34)
        get_json.assert_called_once_with("/api/usage", timeout=40)


class ResetHorizonTest(unittest.TestCase):
    def test_uses_dashboard_sqrt_scale(self):
        self.assertEqual(widget.horizon_position(0, 300), 0)
        self.assertEqual(widget.horizon_position(42 * 3600, 300), 150)
        self.assertEqual(widget.horizon_position(widget.HORIZON_SEC, 300), 300)

    def test_countdown_units_match_the_axis_labels(self):
        # The horizon axis is labelled 3d / 7d, so the countdown beside it cannot
        # read "5g 14h". This used to be the last Italian string in the widget.
        self.assertEqual(widget.format_reset(5 * 86400 + 14 * 3600), "5d 14h")
        self.assertEqual(widget.format_reset(3 * 86400), "3d")
        self.assertEqual(widget.format_reset(5 * 3600), "5h")
        self.assertEqual(widget.format_reset(90), "1m")

    def test_live_horizon_subtracts_elapsed_time_without_refetching(self):
        data = [{
            "id": "codex",
            "name": "Codex",
            "resets": [{"label": "Session", "sec": 3600, "used_pct": 25}],
        }]
        self.assertEqual(widget.horizon_events(data, elapsed=900)[0]["sec"], 2700)

    def test_quota_signature_ignores_relative_countdowns(self):
        first = [{
            "id": "codex", "name": "Codex", "status": "ok", "remaining": 75,
            "details_str": "Session: 75% left (resets in 1h)",
            "resets": [{"label": "Session", "sec": 3600, "reset_at": "fixed", "used_pct": 25}],
        }]
        later = [{
            **first[0],
            "details_str": "Session: 75% left (resets in 59m)",
            "resets": [{**first[0]["resets"][0], "sec": 3540}],
        }]
        self.assertEqual(widget.quota_signature(first), widget.quota_signature(later))
        later[0]["remaining"] = 74
        self.assertNotEqual(widget.quota_signature(first), widget.quota_signature(later))


class ProtocolRegistrationTest(unittest.TestCase):
    def test_protocol_command_quotes_python_and_widget_paths(self):
        self.assertEqual(
            widget.protocol_command(r"C:\Python\python.exe", r"C:\My App\widget.py"),
            r'"C:\Python\pythonw.exe" "C:\My App\widget.py" "%1"',
        )


class WidgetPositionTest(unittest.TestCase):
    def test_bottom_right_uses_work_area_above_taskbar(self):
        self.assertEqual(
            widget.bottom_right_position((0, 0, 1920, 1040), 322, 245, margin=12),
            (1586, 783),
        )

    def test_glass_surface_sits_above_and_right_aligned_with_logo(self):
        self.assertEqual(
            widget.surface_above_logo_position(1586, 783, 44, 322, 309),
            (1308, 472),
        )

    def test_minibar_is_centered_above_the_taskbar(self):
        self.assertEqual(
            widget.bottom_center_position((0, 0, 1920, 1040), 800, 36, margin=12),
            (560, 992),
        )


class PollingTest(unittest.TestCase):
    def test_live_intervals_match_each_data_source(self):
        self.assertEqual(widget.POLL_MS, 60_000)
        self.assertEqual(widget.USAGE_POLL_MS, 5_000)
        self.assertLessEqual(widget.COUNTDOWN_TICK_MS, 30_000)

    def test_refresh_coalesces_overlapping_loads_and_replaces_timer(self):
        fake = object.__new__(widget.Widget)
        fake._refresh_job = "old"
        fake._loading = True
        fake.after_cancel = unittest.mock.Mock()
        fake.after = unittest.mock.Mock(return_value="new")

        widget.Widget.refresh(fake)

        fake.after_cancel.assert_called_once_with("old")
        fake.after.assert_called_once_with(widget.POLL_MS, fake.refresh)
        self.assertEqual(fake._refresh_job, "new")

    @patch("widget.time.monotonic", return_value=100)
    def test_unchanged_poll_updates_baselines_without_rebuilding_ui(self, _monotonic):
        data = [{
            "id": "codex", "name": "Codex", "status": "ok", "remaining": 75,
            "details_str": "Session: 75% left (resets in 59m)", "reset_sec": 3540,
            "resets": [{"label": "Session", "sec": 3540, "reset_at": "fixed", "used_pct": 25}],
        }]
        fake = object.__new__(widget.Widget)
        fake._loading = True
        fake._quota_online = False
        fake._quota_signature = widget.quota_signature(data)
        fake._last_data_at = 0
        fake.last_data = [{**data[0], "details_str": "Session: 75% left (resets in 1h)"}]
        fake._render = unittest.mock.Mock()
        fake._update_live_values = unittest.mock.Mock()
        fake._update_live_status = unittest.mock.Mock()

        widget.Widget._finish_load(fake, data)

        fake._render.assert_not_called()
        fake._update_live_values.assert_called_once_with()
        fake._update_live_status.assert_called_once_with()
        self.assertIs(fake.last_data, data)
        self.assertTrue(fake._quota_online)


if __name__ == "__main__":
    unittest.main()
