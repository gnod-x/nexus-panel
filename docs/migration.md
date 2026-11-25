# Sun-Panel migration

Sun-Panel remains read-only input and rollback reference. Export on its authorized host, review the private result, then import into a separate Nexus database. Household databases/exports/private URLs/credentials never belong in cloud staging. The synthetic cloud preview has separate data; an explicitly authorized home-host upgrade preserves the existing local Nexus project and volume and does not reimport or modify the Sun-Panel source.

## Read-only export

The exporter reads group/card tables, not account/password/API-token/settings tables. It resolves the source and constructs an encoded SQLite file URI with mode=ro. Filenames containing Unicode, spaces, #, ? and % remain literal; committed active WAL data stays readable without immutable-mode assumptions.

Export includes bounded names/descriptions, group associations and safe HTTP(S) links. LAN URLs are preferred when usable; otherwise a safe public URL may be used. Unsupported schemes, embedded credentials and recognized sensitive query keys are rejected. Custom HTML/JavaScript, icons, visibility flags and unrelated settings are omitted.

Recognized credential-bearing descriptions are omitted **entirely**, including common Authorization/Bearer, token, password, Cookie and API-key assignments. This is not universal DLP. Manually review every field for secrets, intended targets and private content before import. A JSON export with no recognized secrets is still private.

Output cannot resolve to the source or SQLite -wal/-shm/-journal sidecars, including existing hardlink/symlink aliases and directory aliases. Choose a distinct JSON path in a trusted operator-controlled directory. Adversarial concurrent filesystem replacement/TOCTOU is not claimed solved. Output is atomically replaced with owner-only 0600 permissions and is not a source backup.

~~~bash
python3 -B scripts/export_sun_panel.py --source /path/to/sun-panel.db
python3 -B scripts/export_sun_panel.py --source /path/to/sun-panel.db --output ~/sun-panel-import.json
~~~

The first command previews counts. Review the second command's private JSON locally before upload; do not place it in cloud artifacts or source control.

## Administrator import

The dialog previews counts and requires admin permission. API accepts at most 1 MiB wire JSON including whitespace, 100 groups and 500 services. Every service/probe URL is validated before a single immediate transaction. Duplicate slugs or missing group references roll back all rows and prevent a partial success event. Only the separate Nexus database is written.

Nexus uses numbered SQLite PRAGMA user_version migrations; it does not replace Sun-Panel. Keep the old database and verified backups until the new directory is validated. See [API](api-contract.md), [deployment](deployment.md), and [testing](testing.md).
