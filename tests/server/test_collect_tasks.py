"""Pure fixtures only: importing collector never performs host collection."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collect_tasks", Path(__file__).parents[2] / "scripts" / "collect-tasks.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
NOW = dt.datetime(2026, 2, 3, 12, 0, tzinfo=dt.timezone.utc)
AT = "2026-02-03T12:00:00Z"

class CollectorFixtures(unittest.TestCase):
    def test_cron_redacts_commands_env_comments_paths_and_urls(self):
        text = "# private comment\nTOKEN=synthetic-marker\n13 7 * * * /private/script --token=hidden https://private.invalid\n@reboot /private/boot\n"
        rows = collector.parse_crontab(text, AT, "Asia/Shanghai")
        self.assertEqual(len(rows), 2)
        output = json.dumps(rows)
        for secret in ["synthetic-marker", "hidden", "private", "TOKEN", "script", "/private/boot"]:
            self.assertNotIn(secret, output)
        self.assertEqual(rows[0]["schedule"], "13 7 * * *")
        self.assertEqual(rows[1]["kind"], "event")
        self.assertIsNone(rows[0]["nextRunAt"])
        self.assertIsNone(rows[0]["exitCode"])
        self.assertEqual(rows[0]["state"], "unknown")

    def test_cron_timezone_is_per_entry_and_invalid_is_unknown(self):
        rows = collector.parse_crontab("CRON_TZ=Europe/Paris\n5 * * * * fixture-one\nCRON_TZ=Not/AZone\n6 * * * * fixture-two\n", AT, "UTC")
        self.assertEqual(rows[0]["timezone"], "Europe/Paris")
        self.assertIsNone(rows[1]["timezone"])

    def test_cron_ids_stable_across_comment_and_order_changes(self):
        one = collector.parse_crontab("4 8 * * * fixture-one\n5 9 * * * fixture-two", AT, "UTC")
        two = collector.parse_crontab("# note\n5 9 * * * fixture-two\n4 8 * * * fixture-one", AT, "UTC")
        self.assertEqual({x["id"] for x in one}, {x["id"] for x in two})
        self.assertEqual(collector.parse_crontab("not a valid line", AT, "UTC"), [])

    def test_no_crontab_and_permissions_timeout_missing_binary_are_distinct(self):
        command = ["/usr/bin/crontab", "-l"]
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess(command, 1, "", "no crontab for synthetic")):
            self.assertEqual(collector.query(command), (0, "", None))
        for exc, expected in [(PermissionError(), "permission_denied"), (FileNotFoundError(), "command_unavailable"), (subprocess.TimeoutExpired(command, 3), "query_timeout")]:
            with patch.object(collector.subprocess, "run", side_effect=exc):
                self.assertEqual(collector.query(command)[2], expected)
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess(command, 1, "", "Operation not permitted")):
            self.assertEqual(collector.query(command)[2], "permission_denied")

    def test_failed_sources_are_explicit_never_synthetic_success(self):
        def runner(argv):
            return None, "", "permission_denied" if argv[0].endswith("crontab") else "query_timeout"
        result = collector.collect(runner, NOW, "UTC")
        self.assertEqual(result["mode"], "live")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["sources"][0]["status"], "permission_denied")
        self.assertEqual(result["sources"][1]["error"], "query_timeout")
        self.assertTrue(all(source["completeness"] == "partial" for source in result["sources"]))

    def test_systemd_runtime_service_metadata_and_next_are_authoritative(self):
        row = {"unit": "synthetic-index.timer", "activates": "synthetic-index.service", "next": 1770123600000000}
        timer = {"ActiveState": "active", "TimersCalendar": "{ OnCalendar=*-*-* 09:13:00 ; next_elapse=ignored }"}
        service = {"ActiveState": "inactive", "Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0",
                   "ExecMainStartTimestamp": "Tue 2026-02-03 10:00:00 UTC", "ExecMainExitTimestamp": "Tue 2026-02-03 10:00:09 UTC"}
        item = collector.parse_timer(row, timer, service, "systemd-user", AT, "UTC")
        self.assertEqual(item["state"], "succeeded")
        self.assertEqual(item["durationMs"], 9000)
        self.assertEqual(item["exitCode"], 0)
        self.assertEqual(item["nextRunKind"], "authoritative")
        self.assertTrue(item["enabled"])
        self.assertNotIn("synthetic-index", json.dumps(item))

    def test_running_failed_signals_and_unknown_have_no_fabricated_exit_code(self):
        row = {"unit": "sample.timer", "next": 0}
        for properties, expected in [({}, "unknown"), ({"ActiveState": "active", "SubState": "running"}, "running"), ({"Result": "signal", "ExecMainCode": "2", "ExecMainStatus": "9"}, "failed")]:
            item = collector.parse_timer(row, {}, properties, "systemd-system", AT, "UTC")
            self.assertEqual(item["state"], expected)
            self.assertIsNone(item["exitCode"])
            self.assertIsNone(item["nextRunAt"])

    def test_invalid_units_cannot_become_command_options(self):
        for unit in ["--help", "../private.timer", "https://private.invalid.timer", "evil;touch.timer"]:
            self.assertIsNone(collector.parse_timer({"unit": unit}, {}, {}, "systemd-system", AT, "UTC"))

    def test_snapshot_queries_are_fixed_read_only_and_do_not_enumerate_root_or_logs(self):
        calls = []
        def runner(argv):
            calls.append(argv)
            if argv[0].endswith("crontab"):
                return 0, "9 2 * * * synthetic-job", None
            if "list-timers" in argv:
                return 0, json.dumps([{"unit": "demo.timer", "activates": "demo.service", "next": 0}]), None
            return 0, "ActiveState=inactive\n", None
        snapshot = collector.collect(runner, NOW, "UTC")
        self.assertEqual(len(snapshot["tasks"]), 3)
        for argv in calls:
            self.assertIn(argv[0], ["/usr/bin/crontab", "/usr/bin/systemctl"])
            self.assertNotIn("start", argv)
            self.assertNotIn("Environment", " ".join(argv))
            self.assertNotIn("-u", argv)
            self.assertNotIn("root", argv)
        self.assertTrue(all(source["completeness"] == "partial" for source in snapshot["sources"]))

    def test_malformed_timer_json_reports_error(self):
        def runner(argv):
            return (0, "", None) if argv[0].endswith("crontab") else (0, '{"unsafe":"shape"}', None)
        snapshot = collector.collect(runner, NOW, "UTC")
        self.assertEqual(snapshot["sources"][1]["error"], "query_failed")

    def test_timestamp_unknown_unsupported_zone_and_oversized_output(self):
        for value in [0, None, "n/a", "Tue 2026-02-03 10:00:00 MYSTERY"]:
            self.assertIsNone(collector.timestamp(value))
        self.assertIsNone(collector.valid_timezone("../etc/passwd"))
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "x" * (collector.MAX_OUTPUT + 1), "")):
            self.assertEqual(collector.query(["/usr/bin/crontab", "-l"])[2], "query_failed")

if __name__ == "__main__":
    unittest.main()
