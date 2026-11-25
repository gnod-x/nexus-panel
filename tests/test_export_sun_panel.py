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
        db.close()

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

    def test_missing_title_uses_only_icon_display_text_and_preserves_slug_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "icon-text.db"
            self.create_database(source)
            icon = {
                "text": "  Synthetic Launcher  ",
                "image": "data:image/png;base64,SYNTHETIC_IMAGE_SENTINEL",
                "html": "<script>SYNTHETIC_HTML_SENTINEL</script>",
                "token": "SYNTHETIC_ICON_SECRET_SENTINEL",
            }
            with sqlite3.connect(source) as db:
                db.execute("ALTER TABLE item_icon ADD COLUMN icon_json TEXT")
                db.execute("UPDATE item_icon SET title=' ', only_name='stable-source', icon_json=? WHERE id=1", (json.dumps(icon),))
                db.execute("UPDATE item_icon SET icon_json=? WHERE id=2", (json.dumps({"text": "Do not replace explicit title"}),))
                db.execute("INSERT INTO item_icon(id,title,only_name,url,sort,icon_json) VALUES(4,NULL,'','https://synthetic.example/second',4,?)", (json.dumps({"text": "Synthetic Launcher"}),))
            db.close()
            before = source.read_bytes()
            data, summary = export(source)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(summary, {"groups": 2, "services": 3, "skippedCards": 1})
            services = data["services"]
            self.assertEqual((services[0]["name"], services[0]["slug"], services[0]["groupSlug"]), ("Synthetic Launcher", "stable-source", "duplicate"))
            self.assertEqual(services[1]["name"], "Status")
            self.assertEqual((services[2]["name"], services[2]["slug"]), ("Synthetic Launcher", "synthetic-launcher"))
            self.assertTrue(all(set(service) <= {"name", "slug", "url", "tags", "description", "groupSlug"} for service in services))
            serialized = json.dumps(data)
            for sentinel in ["SYNTHETIC_IMAGE_SENTINEL", "SYNTHETIC_HTML_SENTINEL", "SYNTHETIC_ICON_SECRET_SENTINEL", "Do not replace explicit title"]:
                self.assertNotIn(sentinel, serialized)

    def test_invalid_or_nontext_icon_payloads_do_not_invent_service_names(self) -> None:
        payloads = [
            None, "", "{bad-json", "[]", '"not an icon object"', "null", "7",
            "{}", '{"text": null}', '{"text": 42}', '{"text": ["not text"]}',
            '{"text": "  "}', '{"image": "SYNTHETIC_IMAGE_ONLY", "html": "<b>not a display name</b>"}',
            123, bytes([255]),
        ]
        for index, payload in enumerate(payloads):
            with self.subTest(payload_type=index):
                with tempfile.TemporaryDirectory() as temporary:
                    source = Path(temporary) / "invalid-icon.db"
                    self.create_database(source)
                    with sqlite3.connect(source) as db:
                        db.execute("ALTER TABLE item_icon ADD COLUMN icon_json TEXT")
                        db.execute("UPDATE item_icon SET title=NULL,icon_json=? WHERE id=1", (payload,))
                    db.close()
                    before = source.read_bytes()
                    data, summary = export(source)
                    self.assertEqual(source.read_bytes(), before)
                    self.assertEqual(summary, {"groups": 2, "services": 1, "skippedCards": 2})
                    self.assertEqual(data["services"][0]["name"], "Status")

    def test_private_export_file_uses_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "nested" / "export.json"
            write_private(output, {"groups": [], "services": []})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"groups": [], "services": []})


if __name__ == "__main__":
    unittest.main()
