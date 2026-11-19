import json
import os
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path

from scripts.export_sun_panel import export, write_private


class SunPanelExportTests(unittest.TestCase):
    def create_database(self, path: Path) -> None:
        with sqlite3.connect(path) as db:
            db.executescript(
                """
                CREATE TABLE item_icon_group (
                    id INTEGER PRIMARY KEY, title TEXT, only_name TEXT, sort INTEGER,
                    deleted_at TEXT
                );
                CREATE TABLE item_icon (
                    id INTEGER PRIMARY KEY, title TEXT, only_name TEXT, url TEXT,
                    lan_url TEXT, description TEXT, item_icon_group_id INTEGER,
                    sort INTEGER, deleted_at TEXT
                );
                INSERT INTO item_icon_group VALUES
                    (1, 'Core', 'duplicate', 1, NULL),
                    (2, 'Operations', 'duplicate', 2, NULL);
                INSERT INTO item_icon VALUES
                    (1, 'Router', 'duplicate', 'https://public.example/router',
                     'http://router.local/?token=private', 'token: hidden-value', 1, 1, NULL),
                    (2, 'Status', 'duplicate', 'https://status.example/path?q=ok#section',
                     NULL, 'Public status', 2, 2, NULL),
                    (3, 'Unsafe', 'unsafe', 'javascript:alert(1)', NULL, '', 1, 3, NULL);
                """
            )

    def test_export_sanitizes_urls_secrets_and_duplicate_slugs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "sun-panel.db"
            self.create_database(source)
            before = source.read_bytes()

            data, summary = export(source)

            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(summary, {"groups": 2, "services": 2, "skippedCards": 1})
            self.assertEqual([group["slug"] for group in data["groups"]], ["duplicate", "duplicate-2"])
            self.assertEqual([service["slug"] for service in data["services"]], ["duplicate", "duplicate-2"])
            self.assertEqual(data["services"][0]["url"], "https://public.example/router")
            self.assertEqual(data["services"][1]["url"], "https://status.example/path?q=ok")
            self.assertEqual(data["services"][0]["groupSlug"], "duplicate")
            self.assertNotIn("hidden-value", json.dumps(data))
            self.assertNotIn("icon", data["services"][0])

    def test_private_export_file_uses_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "nested" / "export.json"
            write_private(output, {"groups": [], "services": []})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"groups": [], "services": []})


if __name__ == "__main__":
    unittest.main()
