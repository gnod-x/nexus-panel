"""Collector security fixtures only; never invokes a real host query or job."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audit_security_collector", Path(__file__).parents[2] / "scripts" / "collect-tasks.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
NOW = dt.datetime(2026, 2, 5, 12, tzinfo=dt.timezone.utc)
AT = "2026-02-05T12:00:00Z"

class CollectorSecurityAudit(unittest.TestCase):
    def test_inherited_process_secrets_are_not_forwarded_to_metadata_subprocesses(self):
        command = ["/usr/bin/crontab", "-l"]
        with patch.dict(os.environ, {"AUDIT_PRIVATE_ENV": "INHERITED_PRIVATE_MARKER"}):
            with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess(command, 0, "", "")) as run:
                self.assertEqual(collector.query(command), (0, "", None))
                kwargs = run.call_args.kwargs
                self.assertNotIn("INHERITED_PRIVATE_MARKER", json.dumps(kwargs["env"]))
                self.assertEqual(kwargs["env"]["TZ"], "UTC")
                self.assertNotIn("shell", kwargs)
                self.assertEqual(kwargs["timeout"], 3)

    def test_timeout_permission_and_os_errors_never_return_original_diagnostics(self):
        command = ["/usr/bin/systemctl", "--system", "list-timers", "--all", "--no-pager", "--output=json"]
        exceptions = [
            subprocess.TimeoutExpired(command, 3, output="RAW_PRIVATE_MARKER", stderr="RAW_PRIVATE_MARKER"),
            PermissionError("RAW_PRIVATE_MARKER"),
            OSError("RAW_PRIVATE_MARKER"),
            UnicodeDecodeError("utf-8", b"\xff", 0, 1, "RAW_PRIVATE_MARKER"),
        ]
        for exception in exceptions:
            with self.subTest(kind=type(exception).__name__):
                with patch.object(collector.subprocess, "run", side_effect=exception):
                    result = collector.query(command)
                    self.assertNotIn("RAW_PRIVATE_MARKER", json.dumps(result))
                    self.assertEqual(result[1], "")

    def test_sensitive_commands_comments_and_env_never_appear_in_collected_snapshot(self):
        text = (
            "# PRIVATE_COMMENT_MARKER\n"
            "AUTHORIZATION=PRIVATE_ENV_MARKER\n"
            "11 2 * * * /private/PATH_MARKER.py --token=PRIVATE_TOKEN_MARKER https://private.invalid/MEDIA_MARKER\n"
            "17 3 * * * COMMAND_MARKER Authorization: Bearer PRIVATE_HEADER_MARKER\n"
        )
        def runner(argv):
            if argv[0].endswith("crontab"):
                return 0, text, None
            return 0, "[]", None
        result = collector.collect(runner, NOW, "UTC")
        serialized = json.dumps(result)
        for marker in ["PRIVATE_COMMENT_MARKER","PRIVATE_ENV_MARKER","PATH_MARKER","PRIVATE_TOKEN_MARKER","MEDIA_MARKER","COMMAND_MARKER","PRIVATE_HEADER_MARKER","private.invalid"]:
            self.assertNotIn(marker, serialized)
        self.assertEqual(len(result["tasks"]), 2)
        for task in result["tasks"]:
            self.assertEqual(task["state"], "unknown")
            self.assertIsNone(task["exitCode"])
            self.assertIsNone(task["lastFinishedAt"])
            self.assertIsNone(task["nextRunAt"])

    def test_long_but_valid_cron_lists_still_produce_server_compatible_safe_metadata(self):
        fields = [
            ",".join(str(value) for value in range(60)),
            ",".join(str(value) for value in range(24)),
            ",".join(str(value) for value in range(1, 32)),
            ",".join(str(value) for value in range(1, 13)),
            ",".join(str(value) for value in range(7)),
        ]
        expression = " ".join(fields)
        self.assertGreater(len(expression), 200)
        rows = collector.parse_crontab(expression + " synthetic-command", AT, "UTC")
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["schedule"] is None or len(rows[0]["schedule"]) <= 200, "Collector must obey the consumer's 200-character schedule bound")
        self.assertIsNone(rows[0]["nextRunAt"])

    def test_command_argument_injection_via_timer_metadata_never_becomes_an_executed_query(self):
        calls = []
        rows = [
            {"unit": "--version", "activates": "sample.service"},
            {"unit": "sample.timer;PRIVATE_COMMAND", "activates": "sample.service"},
            {"unit": "safe.timer", "activates": "--help"},
            {"unit": "another.timer", "activates": "../PRIVATE_COMMAND.service"},
        ]
        def runner(argv):
            calls.append(argv)
            if argv[0].endswith("crontab"):
                return 0, "", None
            if "list-timers" in argv:
                return 0, json.dumps(rows), None
            return 0, "ActiveState=inactive\n", None
        result = collector.collect(runner, NOW, "UTC")
        all_arguments = json.dumps(calls)
        self.assertNotIn("PRIVATE_COMMAND", all_arguments)
        self.assertNotIn("--version", all_arguments)
        self.assertNotIn("--help", all_arguments)
        self.assertEqual(len(result["tasks"]), 4)
        for argv in calls:
            self.assertIn(argv[0], ["/usr/bin/crontab","/usr/bin/systemctl"])
            if argv[0].endswith("systemctl"):
                self.assertIn(argv[2], ["list-timers","show"])
                self.assertIn("--no-pager", argv)

    def test_only_real_started_exited_services_can_claim_an_exit_code_or_success(self):
        row = {"unit":"synthetic.timer","next":0}
        for props in [
            {"Result":"success","ExecMainCode":"1","ExecMainStatus":"0"},
            {"Result":"signal","ExecMainCode":"2","ExecMainStatus":"9"},
        ]:
            with self.subTest(properties=props):
                result = collector.parse_timer(row, {}, props, "systemd-system", AT, "UTC")
                self.assertIsNone(result["exitCode"])
                if props["Result"] == "success":
                    self.assertEqual(result["state"], "unknown")
        props = {
            "ActiveState":"active","SubState":"exited","Result":"success","ExecMainCode":"1","ExecMainStatus":"0",
            "ExecMainStartTimestamp":"Thu 2026-02-05 10:00:00 UTC","ExecMainExitTimestamp":"Thu 2026-02-05 10:00:07 UTC",
        }
        result = collector.parse_timer(row, {}, props, "systemd-system", AT, "UTC")
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["durationMs"], 7000)
        self.assertEqual(result["exitCode"], 0)

    def test_enumeration_caps_bound_queries_without_claiming_complete_coverage(self):
        calls = []
        rows = [{"unit":"synthetic-" + str(index) + ".timer","next":0} for index in range(80)]
        cron = "\n".join(str(index % 60) + " * * * * command-" + str(index) for index in range(550))
        def runner(argv):
            calls.append(argv)
            if argv[0].endswith("crontab"):
                return 0, cron, None
            if "list-timers" in argv:
                return 0, json.dumps(rows), None
            return 0, "ActiveState=inactive\n", None
        result = collector.collect(runner, NOW, "UTC")
        self.assertEqual(sum(1 for task in result["tasks"] if task["sourceId"] == "user-cron"), 500)
        self.assertEqual(sum(1 for argv in calls if "show" in argv), 128)
        self.assertTrue(all(source["completeness"] == "partial" for source in result["sources"]))
        self.assertLess(len(json.dumps(result).encode()), 1024 * 1024)

if __name__ == "__main__":
    unittest.main()
