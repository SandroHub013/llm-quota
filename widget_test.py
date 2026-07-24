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
                    "reset_str": None, "details_str": "Quota: 75% residui",
                },
                {
                    "id": "moonshot", "name": "Moonshot", "status": "ok", "remaining": None,
                    "reset_str": None, "details_str": "Quota: 10 cny",
                },
            ],
        )
        get_json.assert_called_once_with("/api/quota", timeout=40)

    @patch("widget.get_json", return_value={"providers": [{"id": "broken"}]})
    def test_malformed_provider_payload_marks_widget_offline(self, _get_json):
        self.assertIsNone(widget.fetch_all())


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


class PollingTest(unittest.TestCase):
    def test_poll_interval_avoids_provider_endpoint_throttling(self):
        self.assertGreaterEqual(widget.POLL_MS, 5 * 60_000)

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


if __name__ == "__main__":
    unittest.main()
