#!/usr/bin/env python3
"""Export safe Sun-Panel groups and service links without changing the source DB."""

import argparse
import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SECRET_QUERY_KEY = re.compile(r"(token|secret|password|passwd|auth|api.?key|credential|signature|(^|_)sig($|_))", re.I)
SECRET_TEXT = re.compile(r"\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*[^\s,;]+", re.I)


def slugify(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:90].strip("-")
    return slug or fallback


def safe_url(primary: str | None, fallback: str | None) -> str | None:
    for candidate in (primary, fallback):
        if not candidate:
            continue
        try:
            parsed = urlsplit(candidate.strip())
            if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                continue
            if any(SECRET_QUERY_KEY.search(key) for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
                continue
            return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path, urlencode(parse_qsl(parsed.query, keep_blank_values=True)), ""))
        except ValueError:
            continue
    return None


def export(source: Path) -> tuple[dict, dict]:
    uri = f"file:{source.resolve()}?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    try:
        groups = db.execute(
            "SELECT id, title, only_name, sort FROM item_icon_group WHERE deleted_at IS NULL ORDER BY sort, id"
        ).fetchall()
        cards = db.execute(
            "SELECT title, only_name, icon_json, url, lan_url, description, item_icon_group_id, sort "
            "FROM item_icon WHERE deleted_at IS NULL ORDER BY sort, id"
        ).fetchall()
    finally:
        db.close()

    group_slugs: dict[int, str] = {}
    used_groups: set[str] = set()
    exported_groups = []
    for index, row in enumerate(groups, start=1):
        name = (row["title"] or "").strip()
        if not name:
            continue
        base = slugify(row["only_name"] or name, f"group-{index}")
        slug = base
        suffix = 2
        while slug in used_groups:
            slug = f"{base[:84]}-{suffix}"
            suffix += 1
        used_groups.add(slug)
        group_slugs[row["id"]] = slug
        exported_groups.append({"name": name[:80], "slug": slug, "color": "#64748b"})

    used_services: set[str] = set()
    exported_services = []
    skipped = 0
    for index, row in enumerate(cards, start=1):
        name = (row["title"] or "").strip()
        if not name:
            try:
                icon_payload = json.loads(row["icon_json"] or "{}")
            except (TypeError, json.JSONDecodeError):
                icon_payload = {}
            if isinstance(icon_payload, dict) and isinstance(icon_payload.get("text"), str):
                name = icon_payload["text"].strip()
        url = safe_url(row["lan_url"], row["url"])
        if not name or not url:
            skipped += 1
            continue
        base = slugify(row["only_name"] or name, f"service-{index}")
        slug = base
        suffix = 2
        while slug in used_services:
            slug = f"{base[:88]}-{suffix}"
            suffix += 1
        used_services.add(slug)
        item = {"name": name[:100], "slug": slug, "url": url, "tags": []}
        description = SECRET_TEXT.sub(r"\1=[redacted]", (row["description"] or "").strip())[:500]
        if description:
            item["description"] = description
        if row["item_icon_group_id"] in group_slugs:
            item["groupSlug"] = group_slugs[row["item_icon_group_id"]]
        exported_services.append(item)

    result = {"groups": exported_groups, "services": exported_services}
    summary = {"groups": len(exported_groups), "services": len(exported_services), "skippedCards": skipped}
    return result, summary


def write_private(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".nexus-import-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Sun-Panel SQLite database (opened read-only)")
    parser.add_argument("--output", type=Path, help="Write a private JSON export instead of previewing counts")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error("source database does not exist")
    try:
        data, summary = export(args.source)
    except sqlite3.Error as error:
        parser.error(f"could not read source schema: {error}")
    if args.output:
        write_private(args.output, data)
        print(json.dumps({**summary, "output": str(args.output), "mode": "export"}, ensure_ascii=False))
    else:
        print(json.dumps({**summary, "mode": "preview"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
