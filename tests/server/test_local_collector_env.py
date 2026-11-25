"""Host-only environment regression; synthetic metadata, no bus or cron reads."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector_env", Path(__file__).parents[2] / "scripts" / "collect-tasks.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
USER = ["/usr/bin/systemctl", "--user", "list-timers"]
BASE = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TZ": "UTC"}


class LocalCollectorEnvironment(unittest.TestCase):
    def environment(self, directory_mode=stat.S_IFDIR | 0o700,
                    socket_mode=stat.S_IFSOCK | 0o600, directory_uid=1234, socket_uid=1234):
        metadata = [SimpleNamespace(st_mode=directory_mode, st_uid=directory_uid),
                    SimpleNamespace(st_mode=socket_mode, st_uid=socket_uid)]
        with patch.object(collector.os, "getuid", return_value=1234), patch.object(
                collector.Path, "lstat", side_effect=metadata):
            return collector.query_environment(USER)

    def test_valid_owned_directory_and_socket_get_derived_bus(self):
        with patch.dict(os.environ, {"DBUS_SESSION_BUS_ADDRESS": "tcp:host=untrusted",
                                     "XDG_RUNTIME_DIR": "/untrusted", "TOKEN": "synthetic"}):
            self.assertEqual(self.environment(), {
                **BASE, "XDG_RUNTIME_DIR": "/run/user/1234",
                "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1234/bus"})

    def test_other_queries_never_probe_or_receive_bus(self):
        for argv in [["/usr/bin/crontab", "-l"], ["/usr/bin/systemctl", "--system"],
                     ["/untrusted/systemctl", "--user"]]:
            with self.subTest(argv=argv), patch.object(collector.Path, "lstat") as probe:
                self.assertEqual(collector.query_environment(argv), BASE)
                probe.assert_not_called()

    def test_reject_directory_symlink_file_owner_or_writable_directory(self):
        for kwargs in [{"directory_mode": stat.S_IFLNK | 0o777},
                       {"directory_mode": stat.S_IFREG | 0o600},
                       {"directory_uid": 0},
                       {"directory_mode": stat.S_IFDIR | 0o720},
                       {"directory_mode": stat.S_IFDIR | 0o702}]:
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.environment(**kwargs), BASE)

    def test_reject_socket_symlink_regular_file_directory_and_other_owner(self):
        for kwargs in [{"socket_mode": stat.S_IFLNK | 0o777},
                       {"socket_mode": stat.S_IFREG | 0o600},
                       {"socket_mode": stat.S_IFDIR | 0o700}, {"socket_uid": 0}]:
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.environment(**kwargs), BASE)

    def test_missing_or_inaccessible_runtime_retains_minimal_environment(self):
        for error in [FileNotFoundError(), PermissionError(), OSError()]:
            with self.subTest(error=error), patch.object(collector.Path, "lstat", side_effect=error):
                self.assertEqual(collector.query_environment(USER), BASE)

    def test_query_uses_environment_and_absent_bus_stays_explicit_error(self):
        result = subprocess.CompletedProcess(USER, 1, "", "Failed to connect to bus: No medium found")
        with patch.object(collector.Path, "lstat", side_effect=FileNotFoundError()), patch.object(
                collector.subprocess, "run", return_value=result) as run:
            self.assertEqual(collector.query(USER), (None, "", "query_failed"))
            self.assertEqual(run.call_args.kwargs["env"], BASE)
        snapshot = collector.collect(runner=lambda argv: (None, "", "query_failed"), timezone="UTC")
        self.assertTrue(all(s["status"] == "error" and s["completeness"] == "partial"
                            for s in snapshot["sources"]))
        self.assertEqual(snapshot["tasks"], [])


if __name__ == "__main__":
    unittest.main()
