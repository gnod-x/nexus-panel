"""Security regressions using only synthetic SQLite files in TemporaryDirectory."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audit_exporter", Path(__file__).parents[1] / "scripts" / "export_sun_panel.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

def database(filename, description="Synthetic safe description"):
    connection = sqlite3.connect(filename)
    connection.executescript("""
      CREATE TABLE item_icon_group(id INTEGER PRIMARY KEY,title TEXT,only_name TEXT,sort INTEGER,deleted_at TEXT);
      CREATE TABLE item_icon(id INTEGER PRIMARY KEY,title TEXT,only_name TEXT,url TEXT,lan_url TEXT,description TEXT,item_icon_group_id INTEGER,sort INTEGER,deleted_at TEXT);
      INSERT INTO item_icon_group VALUES(1,'Synthetic group','synthetic-group',0,NULL);
    """)
    connection.execute("INSERT INTO item_icon VALUES(1,?,?,?,?,?,?,?,NULL)", (
        "Synthetic service","synthetic-service","https://synthetic.audit.invalid/",None,description,1,0,
    ))
    connection.commit()
    connection.close()

def digest(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()

class MigrationSecurityAudit(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nexus-audit-migration-")
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def cli(self, source, output):
        with patch.object(sys, "argv", ["export_sun_panel.py", "--source", str(source), "--output", str(output)]):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    return exporter.main()
                except SystemExit as error:
                    return error.code

    def test_source_uri_metacharacters_are_encoded_and_do_not_create_other_databases(self):
        for index, name in enumerate(["source#snapshot.db", "source?readonly.db", "source%23snapshot.db", "source%3Fquery.db", "source [文].db"]):
            with self.subTest(filename=name):
                case = self.root / str(index)
                case.mkdir()
                source = case / name
                database(source, "Synthetic URI case " + str(index))
                before = {p.name: digest(p) for p in case.iterdir() if p.is_file()}
                try:
                    result, summary = exporter.export(source)
                except sqlite3.Error as error:
                    result, summary = None, None
                after = {p.name: digest(p) for p in case.iterdir() if p.is_file()}
                self.assertEqual(before, after, "Read-only export must not create a truncated or decoded-path database")
                self.assertIsNotNone(result, "A valid source with URI metacharacters must remain readable")
                self.assertEqual(summary["services"], 1)

    def test_missing_metacharacter_source_cannot_create_a_prefix_database(self):
        source = self.root / "missing#readonly.db"
        with self.assertRaises(sqlite3.Error):
            exporter.export(source)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_rejects_output_equal_to_source_and_preserves_database(self):
        source = self.root / "synthetic.db"
        database(source)
        before = digest(source)
        status = self.cli(source, source)
        self.assertEqual(digest(source), before, "Output must never replace the source database")
        self.assertNotEqual(status, 0)

    def test_cli_rejects_source_alias_as_destination(self):
        source = self.root / "synthetic.db"
        database(source)
        alias = self.root / "source-alias.db"
        alias.symlink_to(source)
        before = digest(source)
        status = self.cli(alias, source)
        self.assertEqual(digest(source), before)
        self.assertNotEqual(status, 0)

    def test_cli_rejects_destination_parent_alias_to_source(self):
        actual = self.root / "actual"
        actual.mkdir()
        source = actual / "synthetic.db"
        database(source)
        alias = self.root / "alias"
        alias.symlink_to(actual, target_is_directory=True)
        before = digest(source)
        status = self.cli(source, alias / source.name)
        self.assertEqual(digest(source), before)
        self.assertNotEqual(status, 0)

    def test_cli_does_not_overwrite_source_sqlite_sidecar_paths(self):
        for suffix in ["-wal", "-shm", "-journal"]:
            with self.subTest(suffix=suffix):
                source = self.root / ("sidecar" + suffix.replace("-", "") + ".db")
                database(source)
                before = digest(source)
                output = Path(str(source) + suffix)
                status = self.cli(source, output)
                self.assertEqual(digest(source), before)
                self.assertNotEqual(status, 0)
                self.assertFalse(output.exists())

    def test_cli_rejects_existing_source_destination_aliases(self):
        source = self.root / "source-alias-target.db"
        database(source)
        before = digest(source)
        for kind in ["hardlink", "symlink"]:
            with self.subTest(alias=kind):
                alias = self.root / (kind + ".json")
                if kind == "hardlink":
                    alias.hardlink_to(source)
                else:
                    alias.symlink_to(source)
                status = self.cli(source, alias)
                self.assertNotEqual(status, 0)
                self.assertEqual(digest(source), before)
                self.assertEqual(digest(alias), before)

    def test_cli_rejects_existing_sidecar_destination_aliases(self):
        for suffix in ["-wal", "-shm", "-journal"]:
            for kind in ["hardlink", "symlink"]:
                with self.subTest(suffix=suffix, alias=kind):
                    case = self.root / (suffix[1:] + "-" + kind)
                    case.mkdir()
                    source = case / "source.db"
                    database(source)
                    before = digest(source)
                    sidecar = Path(str(source) + suffix)
                    sidecar.write_bytes(b"SYNTHETIC_SIDECAR_SENTINEL")
                    alias = case / "output.json"
                    if kind == "hardlink":
                        alias.hardlink_to(sidecar)
                    else:
                        alias.symlink_to(sidecar)
                    status = self.cli(source, alias)
                    self.assertNotEqual(status, 0)
                    self.assertEqual(sidecar.read_bytes(), b"SYNTHETIC_SIDECAR_SENTINEL")
                    self.assertEqual(alias.read_bytes(), b"SYNTHETIC_SIDECAR_SENTINEL")
                    self.assertEqual(digest(source), before)

    def test_readonly_export_sees_committed_wal_without_checkpointing_source(self):
        source = self.root / "active-wal.db"
        database(source)
        connection = sqlite3.connect(source)
        try:
            self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.execute("UPDATE item_icon SET description='Committed synthetic WAL metadata'")
            connection.commit()
            before_database = digest(source)
            before_wal = digest(Path(str(source) + "-wal"))
            result, summary = exporter.export(source)
            self.assertEqual(summary["services"], 1)
            self.assertEqual(result["services"][0]["description"], "Committed synthetic WAL metadata")
            self.assertEqual(digest(source), before_database)
            self.assertEqual(digest(Path(str(source) + "-wal")), before_wal)
        finally:
            connection.close()

    def test_description_credentials_are_not_migrated(self):
        cases = [
            ("Authorization: Bearer AUDIT_CREDENTIAL_A", "AUDIT_CREDENTIAL_A"),
            ("authorization=Bearer AUDIT_CREDENTIAL_B", "AUDIT_CREDENTIAL_B"),
            ("access_token=AUDIT_CREDENTIAL_C", "AUDIT_CREDENTIAL_C"),
            ("refresh_token: AUDIT_CREDENTIAL_D", "AUDIT_CREDENTIAL_D"),
            ('password="audit quoted words AUDIT_CREDENTIAL_E"', "AUDIT_CREDENTIAL_E"),
            ("passwd='audit quoted words AUDIT_CREDENTIAL_F'", "AUDIT_CREDENTIAL_F"),
            ('api_key: "audit quoted words AUDIT_CREDENTIAL_G"', "AUDIT_CREDENTIAL_G"),
            ('{"password":"AUDIT_CREDENTIAL_H"}', "AUDIT_CREDENTIAL_H"),
            ('{"access_token": "AUDIT_CREDENTIAL_I"}', "AUDIT_CREDENTIAL_I"),
            ("Cookie: session=AUDIT_CREDENTIAL_J", "AUDIT_CREDENTIAL_J"),
            ("token=AUDIT_CREDENTIAL_K", "AUDIT_CREDENTIAL_K"),
            ("X-Api-Key: AUDIT_CREDENTIAL_L", "AUDIT_CREDENTIAL_L"),
            ("password = AUDIT_CREDENTIAL_M", "AUDIT_CREDENTIAL_M"),
        ]
        for index, (description, sentinel) in enumerate(cases):
            with self.subTest(pattern=index):
                source = self.root / ("description-" + str(index) + ".db")
                database(source, "Synthetic note. " + description)
                result, _ = exporter.export(source)
                self.assertEqual(len(result["services"]), 1)
                self.assertNotIn(sentinel, json.dumps(result))

    def test_plain_description_survives_and_source_bytes_never_change(self):
        source = self.root / "ordinary.db"
        description = "Synthetic help text with no secret values."
        database(source, description)
        before = digest(source)
        result, summary = exporter.export(source)
        self.assertEqual(result["services"][0]["description"], description)
        self.assertEqual(summary, {"groups": 1, "services": 1, "skippedCards": 0})
        self.assertEqual(digest(source), before)

if __name__ == "__main__":
    unittest.main()
