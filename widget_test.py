import contextlib
import inspect
import io
import os
import queue
import unittest
from unittest.mock import Mock, patch

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

    @patch("widget.get_json", return_value={"providers": ["not-a-provider"]})
    def test_non_object_provider_payload_marks_widget_offline(self, _get_json):
        self.assertIsNone(widget.fetch_all())

    @patch("widget.get_json", return_value={"providers": [{"id": "codex", "name": "Codex", "metrics": ["not-a-metric"]}]})
    def test_non_object_metric_payload_marks_widget_offline(self, _get_json):
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
        self.assertEqual(widget.fetch_usage_cost(), (12.34, False))
        get_json.assert_called_once_with("/api/usage", timeout=40)

    @patch("widget.get_json")
    def test_prefers_the_shared_headline_so_widget_and_dashboard_agree(self, get_json):
        get_json.return_value = {
            "estimatedCostEur": 2412.71,
            "headlineCostEur": 2347.27,
            "usageFiltered": True,
        }
        self.assertEqual(widget.fetch_usage_cost(), (2347.27, True))

    @patch("widget.get_json", return_value={"headlineCostEur": "oops"})
    def test_malformed_headline_keeps_widget_offline(self, _get_json):
        self.assertIsNone(widget.fetch_usage_cost())


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
        self.assertEqual(
            widget.protocol_command(
                r"C:\Python\python.exe",
                r"C:\My App\widget.py",
                "http://localhost:8080",
            ),
            r'"C:\Python\pythonw.exe" "C:\My App\widget.py" --server-url "http://localhost:8080" "%1"',
        )

    def test_server_url_is_customizable_and_safely_normalized(self):
        self.assertEqual(widget.normalize_base_url("https://quota.example.test/"), "https://quota.example.test")
        self.assertEqual(widget.normalize_base_url("http://localhost:8080/base/"), "http://localhost:8080/base")
        self.assertEqual(widget.normalize_base_url("javascript:alert(1)"), widget.DEFAULT_BASE)
        self.assertEqual(widget.normalize_base_url("https://user:secret@example.test"), widget.DEFAULT_BASE)

    def test_dashboard_protocol_passes_its_local_custom_port(self):
        self.assertEqual(
            widget.configured_base_url(
                ["widget.py", "llmquota://widget?server=http%3A%2F%2Flocalhost%3A8080"],
                {},
            ),
            "http://localhost:8080",
        )

    def test_explicit_server_url_wins_and_protocol_rejects_remote_hosts(self):
        self.assertEqual(
            widget.configured_base_url(
                ["widget.py", "--server-url", "https://quota.example.test"],
                {"LLM_QUOTA_URL": "http://localhost:9000"},
            ),
            "https://quota.example.test",
        )
        self.assertEqual(
            widget.configured_base_url(
                ["widget.py", "llmquota://widget?server=https%3A%2F%2Fevil.example"],
                {"LLM_QUOTA_URL": "http://localhost:9000"},
            ),
            "http://localhost:9000",
        )
        self.assertEqual(
            widget.configured_base_url(
                ["widget.py", "llmquota://[malformed"],
                {"LLM_QUOTA_URL": "http://localhost:9000"},
            ),
            "http://localhost:9000",
        )

    def test_widget_icons_use_bundled_files_only(self):
        self.assertNotIn("www.google.com", widget.LOCAL_LOGO_FILES.values())
        for provider in ("claude", "codex", "gemini", "moonshot"):
            self.assertIn(provider, widget.LOCAL_LOGO_FILES)
            relative = widget.LOCAL_LOGO_FILES[provider]
            self.assertTrue(relative.startswith("public"))
            self.assertTrue(relative.endswith(".png"))
            self.assertTrue(os.path.exists(os.path.join(os.path.dirname(widget.__file__), relative)))
        self.assertIn("transparency_get", inspect.getsource(widget.Widget._set_icon))

    def test_currency_uses_english_number_formatting(self):
        self.assertEqual(widget.format_eur(2721.62), "€2,721.62")


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


class GlassEffectTest(unittest.TestCase):
    def test_acrylic_tint_is_packed_for_the_windows_compositor(self):
        self.assertEqual(widget.abgr_color("#0b1623", 125), 0x7D23160B)

    def test_glass_background_layers_are_color_neutral(self):
        for color in (widget.GLASS_TINT, widget.BG, widget.PANEL):
            channels = tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
            with self.subTest(color=color):
                self.assertEqual(max(channels) - min(channels), 0)

    def test_surface_keeps_a_readable_transparent_fallback(self):
        self.assertGreaterEqual(widget.SURFACE_OPACITY, 0.6)
        self.assertLessEqual(widget.SURFACE_OPACITY, 0.72)

    @patch("widget.set_window_shape")
    @patch("widget.apply_native_acrylic", return_value=True)
    @patch("widget.native_window_handle", side_effect=(101, 202))
    def test_acrylic_surface_has_only_one_rounded_corner_owner(
        self,
        native_window_handle,
        apply_native_acrylic,
        set_window_shape,
    ):
        fake = object.__new__(widget.Widget)
        fake.update_idletasks = unittest.mock.Mock()
        fake.winfo_rootx = unittest.mock.Mock(return_value=0)
        fake.winfo_rooty = unittest.mock.Mock(return_value=0)
        fake.logo = unittest.mock.Mock()
        fake.logo.winfo_rootx.return_value = 0
        fake.logo.winfo_rooty.return_value = 0
        fake.logo.winfo_width.return_value = 40
        fake.logo.winfo_height.return_value = 40
        fake.surface = unittest.mock.Mock()
        fake.surface.winfo_ismapped.return_value = True

        widget.Widget._apply_window_effects(fake)

        native_window_handle.assert_has_calls([unittest.mock.call(fake), unittest.mock.call(fake.surface)])
        apply_native_acrylic.assert_called_once_with(202)
        set_window_shape.assert_called_once_with(101, [("ellipse", 0, 0, 40, 40)])


class WakeBehaviorTest(unittest.TestCase):
    @patch("widget.force_window_visible")
    def test_wake_forces_both_native_windows_visible(self, force_window_visible):
        fake = object.__new__(widget.Widget)
        fake.view_mode = "q"
        fake.expanded = True
        fake.panel = unittest.mock.Mock()
        fake.surface = unittest.mock.Mock()
        fake.deiconify = unittest.mock.Mock()
        fake.after_idle = unittest.mock.Mock()
        fake._sync_surface_to_logo = unittest.mock.Mock()
        fake.lift = unittest.mock.Mock()
        fake.attributes = unittest.mock.Mock()
        fake._user_positioned = True
        fake.refresh = unittest.mock.Mock()

        widget.Widget._do_wake_up(fake)

        self.assertEqual(
            force_window_visible.call_args_list,
            [unittest.mock.call(fake), unittest.mock.call(fake.surface)],
        )


class PollingTest(unittest.TestCase):
    def test_worker_results_are_drained_on_the_ui_thread(self):
        fake = object.__new__(widget.Widget)
        fake._ui_queue = queue.Queue()
        fake._closing = False
        fake.after = Mock(return_value="next")
        fake._ui_queue_job = None
        seen = []

        widget.Widget._queue_ui(fake, lambda: seen.append("done"))
        self.assertEqual(seen, [])
        widget.Widget._drain_ui_queue(fake)
        self.assertEqual(seen, ["done"])
        fake.after.assert_called_once()

    def test_failed_quota_poll_marks_existing_data_stale(self):
        fake = object.__new__(widget.Widget)
        fake._loading = True
        fake._quota_online = True
        fake._quota_stale = False
        fake.last_data = [{"id": "codex"}]
        fake._render = Mock()
        fake._update_live_status = Mock()
        fake._update_live_values = Mock()

        widget.Widget._finish_load(fake, None)

        self.assertFalse(fake._quota_online)
        self.assertTrue(fake._quota_stale)
        fake._render.assert_not_called()
        fake._update_live_status.assert_called_once_with()

    def test_failed_usage_poll_marks_existing_spend_stale(self):
        fake = object.__new__(widget.Widget)
        fake._usage_loading = True
        fake._usage_stale = False
        fake._update_spend_labels = Mock()

        widget.Widget._finish_usage(fake, None)

        self.assertTrue(fake._usage_stale)
        fake._update_spend_labels.assert_called_once_with()

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


class SwallowedErrorReportingTest(unittest.TestCase):
    """The widget survives every one of these, but must not survive them silently.

    Each test asserts both halves of the contract: the fallback the UI depends on,
    and the explanation on stderr. Remove the `log_handled` call the test covers and
    the second assertion fails.
    """

    def _stderr(self, call):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            result = call()
        return result, captured.getvalue()

    @patch("widget.get_json", side_effect=OSError("[Errno 111] Connection refused"))
    def test_an_unreachable_server_is_reported_not_just_absorbed(self, _get_json):
        result, logged = self._stderr(widget.fetch_all)

        self.assertIsNone(result)
        self.assertIn("could not read the quota", logged)
        self.assertIn("Connection refused", logged)

    @patch("widget.get_json", side_effect=OSError("timed out"))
    def test_an_unreachable_server_is_reported_for_the_spend_poll_too(self, _get_json):
        result, logged = self._stderr(widget.fetch_usage_cost)

        self.assertIsNone(result)
        self.assertIn("could not read the local spend total", logged)
        self.assertIn("timed out", logged)

    @patch("widget.get_json", return_value={"providers": [{"id": "broken"}]})
    def test_a_malformed_payload_says_it_was_the_shape_not_the_network(self, _get_json):
        result, logged = self._stderr(widget.fetch_all)

        self.assertIsNone(result)
        self.assertIn("expected shape", logged)

    @patch("widget.get_json", return_value={"providers": {"not": "a list"}})
    def test_a_provider_list_that_is_not_a_list_is_reported(self, _get_json):
        result, logged = self._stderr(widget.fetch_all)

        self.assertIsNone(result)
        self.assertIn("llm-quota widget:", logged)

    def test_log_handled_names_the_context_and_the_exception_type(self):
        _, logged = self._stderr(lambda: widget.log_handled("doing a thing", ValueError("bad input")))

        self.assertIn("doing a thing", logged)
        self.assertIn("ValueError", logged)
        self.assertIn("bad input", logged)


class SpendBoundaryTest(unittest.TestCase):
    """Boundary values for the headline spend, which the widget renders as currency."""

    @patch("widget.get_json", return_value={"estimatedCostEur": 0})
    def test_zero_spend_is_data_and_must_survive_the_guard(self, _get_json):
        # A day with no calls really does cost nothing; collapsing that to None would
        # show "€ …" forever on a machine that simply has not been used yet.
        self.assertEqual(widget.fetch_usage_cost(), (0.0, False))

    @patch("widget.get_json", return_value={"estimatedCostEur": -1})
    def test_a_negative_spend_is_rejected(self, _get_json):
        self.assertIsNone(widget.fetch_usage_cost())

    @patch("widget.get_json", return_value={"estimatedCostEur": float("inf")})
    def test_a_non_finite_spend_is_rejected(self, _get_json):
        self.assertIsNone(widget.fetch_usage_cost())

    @patch("widget.get_json", return_value={"estimatedCostEur": None})
    def test_a_null_spend_is_rejected(self, _get_json):
        self.assertIsNone(widget.fetch_usage_cost())

    @patch("widget.get_json", return_value={})
    def test_a_response_with_no_cost_field_at_all_is_rejected(self, _get_json):
        self.assertIsNone(widget.fetch_usage_cost())

    @patch("widget.get_json", return_value={"headlineCostEur": None, "estimatedCostEur": 5.5})
    def test_a_null_headline_falls_back_to_the_grand_total(self, _get_json):
        self.assertEqual(widget.fetch_usage_cost(), (5.5, False))


class LinuxSchemeRegistrationTest(unittest.TestCase):
    """The dashboard's Widget button opens an llmquota:// URL, and on Linux a desktop
    entry is the only thing that answers it. Getting this wrong is invisible from the
    code — the button simply opens "No apps available"."""

    def _register(self, home):
        environ = {"XDG_DATA_HOME": os.path.join(home, "data"),
                   "XDG_CONFIG_HOME": os.path.join(home, "config")}
        with patch.dict(os.environ, environ, clear=False), \
             patch("widget.IS_WINDOWS", False), patch("widget.IS_MACOS", False), \
             patch("widget.subprocess.run", side_effect=OSError("no xdg tools here")):
            message = widget.register_protocol()
            # Both files are read while the throwaway home still applies; outside this
            # block the paths resolve to the real one.
            entry = io.open(widget.desktop_entry_path(), encoding="utf-8").read()
            associations = io.open(widget.mimeapps_path(), encoding="utf-8").read()
        return message, entry, associations

    def test_the_entry_is_visible_to_the_open_with_chooser(self):
        import tempfile
        message, entry, _ = self._register(tempfile.mkdtemp())

        # NoDisplay hides an entry from the menus *and* from the application chooser,
        # which is the one dialog this entry exists to appear in.
        self.assertNotIn("NoDisplay", entry)
        self.assertIn("MimeType=x-scheme-handler/llmquota;", entry)
        # %u, or the URL the dashboard passes never reaches the widget.
        self.assertTrue(entry.rstrip().count("%u"), "the Exec line drops the URL")
        self.assertIn("llm-quota-widget.desktop", message)

    def test_it_associates_the_scheme_without_xdg_mime(self):
        import tempfile
        _, _, associations = self._register(tempfile.mkdtemp())

        self.assertIn("x-scheme-handler/llmquota=llm-quota-widget.desktop", associations)

    def test_it_keeps_every_other_association_the_user_chose(self):
        import tempfile
        home = tempfile.mkdtemp()
        config = os.path.join(home, "config")
        os.makedirs(config, exist_ok=True)
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": config}, clear=False):
            io.open(widget.mimeapps_path(), "w", encoding="utf-8").write(
                "[Default Applications]\ntext/html=firefox.desktop\n")
            widget.associate_scheme("llm-quota-widget.desktop")
            kept = io.open(widget.mimeapps_path(), encoding="utf-8").read()

        self.assertIn("text/html=firefox.desktop", kept)
        self.assertIn("x-scheme-handler/llmquota=llm-quota-widget.desktop", kept)


if __name__ == "__main__":
    unittest.main()
