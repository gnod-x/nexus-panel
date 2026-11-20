# Sun-Panel Migration

The importer is intended to read Sun-Panel data without changing it. The source stays online and remains the rollback target until the new panel has been verified locally.

The exporter accepts an explicit read-only database path. It exports group and service names, associations, descriptions, and HTTP(S) links. If a card has no title, it uses text from the icon JSON as the display name. Nexus assigns a default group color for migrated groups and sorts them by name. The exporter does not copy icon images, arbitrary custom HTML, settings, or visibility flags.

The importer opens SQLite with `mode=ro` and reads only the group/card tables; it does not read account, password, API-token, or settings tables. It prefers the LAN URL for local use, skips non-HTTP(S) URLs and URL query parameters with credential-like names, and ignores icon payloads after extracting a missing display name. If a LAN URL is rejected, it may use a safe public URL from the same card. Its exported JSON contains service names and local URLs and is private data. Keep it out of cloud staging and the public repository.

Nexus applies schema changes through SQLite `PRAGMA user_version`. The first migration creates the complete initial schema and is applied in one transaction; later releases can add numbered migrations without replacing the database file.

Run the preview and export on the host that holds the Sun-Panel database:

```bash
python3 scripts/export_sun_panel.py --source /path/to/sun-panel.db
python3 scripts/export_sun_panel.py --source /path/to/sun-panel.db --output ~/sun-panel-import.json
```

Inspect the private file, then open the administrator's import dialog (`导入数据`) and review the counts before confirming. An import that conflicts with existing slugs is rolled back in full. It writes only to the Nexus database. Keep the export out of cloud staging and the public repository.
