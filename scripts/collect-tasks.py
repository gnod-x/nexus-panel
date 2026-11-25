#!/usr/bin/env python3
"""Emit a sanitized, read-only task snapshot to stdout.

No jobs, logs, environment files, Docker sockets, SSH, URLs or remote commands.
Scope: current user's crontab + system/current-user systemd timer metadata only.
Install/run separately on the intended host, never as part of the web API.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_OUTPUT = 1024 * 1024
MAX_TIMERS = 64
QUERY_TIMEOUT = 3
SHOW_PROPERTIES = ",".join([
    "ActiveState", "SubState", "UnitFileState", "TimersCalendar", "TimersMonotonic",
    "Result", "ExecMainCode", "ExecMainStatus", "ExecMainStartTimestamp",
    "ExecMainExitTimestamp",
])
KNOWN_CRON = {
    "ai_night_worker": "媒体整理计划", "rss_subscriber": "订阅同步",
    "auto_sync": "媒体库同步", "daily_update_and_prune": "媒体更新与整理",
    "cleanup": "配额维护",
}
KNOWN_TIMERS = {
    "apt-daily.timer": "软件包索引更新",
    "apt-daily-upgrade.timer": "软件包自动维护",
    "logrotate.timer": "系统日志轮转",
    "dpkg-db-backup.timer": "软件包数据库备份",
    "fstrim.timer": "文件系统空间整理",
    "man-db.timer": "手册索引更新",
    "fwupd-refresh.timer": "固件元数据更新",
    "sysstat-collect.timer": "系统统计采集",
    "sysstat-summary.timer": "系统统计汇总",
}
SAFE_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@\-]{0,180}\.(?:timer|service)$")

def iso(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def utc_now():
    return dt.datetime.now(dt.timezone.utc)

def timezone_name():
    try:
        target = str(Path("/etc/localtime").resolve())
        if "/zoneinfo/" in target:
            name = target.split("/zoneinfo/", 1)[1]
            ZoneInfo(name)
            return name
    except (OSError, ValueError, ZoneInfoNotFoundError):
        pass
    return None

def valid_timezone(value):
    try:
        if len(value) > 80:
            return None
        ZoneInfo(value)
        return value
    except (ValueError, ZoneInfoNotFoundError):
        return None

def public_text(value, limit=200):
    if not isinstance(value, str) or not value or len(value) > limit:
        return None
    if re.search(r"""[\x00-\x1f\x7f]|https?://|\b(?:bearer|[\w.-]*(?:token|secret|password|passwd|credential|authorization|cookie)|api[ _-]?key)\b["']?\s*[:=]|\bbearer\s+\S+""", value, re.I):
        return None
    return value

def stable_id(scope, identity):
    return scope + "-" + hashlib.sha256(identity.encode()).hexdigest()[:20]

def source(identity, name, kind, observed, status="ok", error=None):
    result = dict(id=identity, name=name, kind=kind, status=status,
                  completeness="partial", observedAt=observed, freshness="fresh")
    if error:
        result["error"] = error
    return result

def task(identity, source_id, name, kind, schedule, timezone, observed):
    return dict(id=identity, sourceId=source_id, name=name, serviceName=None,
                kind=kind, schedule=schedule, timezone=timezone, enabled=None,
                state="unknown", lastStartedAt=None, lastFinishedAt=None,
                durationMs=None, exitCode=None, nextRunAt=None,
                nextRunKind="unknown", sourceUpdatedAt=None, observedAt=observed,
                freshness="fresh")

def query_environment(argv):
    """Never inherit session credentials or caller-selected bus destinations."""
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TZ": "UTC"}
    if not (len(argv) > 1 and argv[:2] == ["/usr/bin/systemctl", "--user"]):
        return env
    uid = os.getuid()
    runtime = Path("/run/user") / str(uid)
    bus = runtime / "bus"
    try:
        directory, socket = runtime.lstat(), bus.lstat()
        if (stat.S_ISDIR(directory.st_mode) and directory.st_uid == uid
                and not directory.st_mode & 0o022
                and stat.S_ISSOCK(socket.st_mode) and socket.st_uid == uid):
            env["XDG_RUNTIME_DIR"] = str(runtime)
            env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + str(bus)
    except OSError:
        pass
    return env

def query(argv):
    """Only callers below supply fixed binaries and validated unit identifiers."""
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=QUERY_TIMEOUT,
                                env=query_environment(argv))
        if len(result.stdout.encode()) > MAX_OUTPUT or len(result.stderr.encode()) > MAX_OUTPUT:
            return (None, "", "query_failed")
        if result.returncode:
            if re.search(r"permission denied|not permitted|access denied", result.stderr, re.I):
                return (None, "", "permission_denied")
            if argv[0] == "/usr/bin/crontab" and re.search(r"no crontab for", result.stderr, re.I):
                return (0, "", None)
            return (None, "", "query_failed")
        return (0, result.stdout, None)
    except subprocess.TimeoutExpired:
        return (None, "", "query_timeout")
    except FileNotFoundError:
        return (None, "", "command_unavailable")
    except PermissionError:
        return (None, "", "permission_denied")
    except (OSError, UnicodeError):
        return (None, "", "query_failed")

def error_source(identity, name, kind, observed, error):
    return source(identity, name, kind, observed,
                  "permission_denied" if error == "permission_denied" else
                  "unavailable" if error == "command_unavailable" else "error", error)

def parse_crontab(text, observed, host_timezone):
    """Do not emit commands, account names, comments, environment or log paths."""
    tasks = []
    timezone = host_timezone
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        variable = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", stripped)
        if variable:
            if variable[1] == "CRON_TZ":
                timezone = valid_timezone(variable[2].strip("\"'"))
            continue
        if stripped.startswith("@"):
            parts = stripped.split(None, 1)
            if len(parts) != 2 or parts[0] not in ["@reboot", "@hourly", "@daily", "@midnight", "@weekly", "@monthly", "@yearly", "@annually"]:
                continue
            schedule, command = parts
            kind = "event" if schedule == "@reboot" else "cron"
        else:
            parts = stripped.split(None, 5)
            if len(parts) != 6 or not all(re.fullmatch(r"[0-9A-Za-z*,/\-]+", field) for field in parts[:5]):
                continue
            schedule, command, kind = " ".join(parts[:5]), parts[5], "cron"
        name = next((label for target, label in KNOWN_CRON.items()
                     if re.search(r"(?<![\w-])" + re.escape(target) + r"(?![\w-])", command)), "用户计划")
        identity = stable_id("cron", command + "\n" + schedule)
        row = task(identity, "user-cron", name, kind, public_text(schedule), timezone, observed)
        row["enabled"] = True
        tasks.append(row)
    # Exact duplicate entries have one stable identity; multiplicity is not execution history.
    return list({item["id"]: item for item in tasks}.values())[:500]

def parse_properties(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)

def timestamp(value):
    """systemctl is queried with TZ=UTC; do not guess arbitrary abbreviations."""
    if not value or value in ["n/a", "0", "never"]:
        return None
    if isinstance(value, (int, float)):
        if value <= 0 or value > 253402300799000000:
            return None
        try:
            return iso(dt.datetime.fromtimestamp(value / 1_000_000, dt.timezone.utc))
        except (ValueError, OverflowError, OSError):
            return None
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(?:[A-Za-z]{3} )?(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) UTC", value)
    if match:
        try:
            return iso(dt.datetime.fromisoformat(match[1]).replace(tzinfo=dt.timezone.utc))
        except ValueError:
            pass
    return None

def parse_timer(row, properties, service_properties, scope, observed, timezone):
    unit = row.get("unit")
    if not isinstance(unit, str) or not SAFE_UNIT.fullmatch(unit) or not unit.endswith(".timer"):
        return None
    schedule = None
    kind = "unknown"
    calendar = re.search(r"OnCalendar=([^;}]+)", properties.get("TimersCalendar", ""))
    if calendar:
        schedule, kind = public_text(calendar[1].strip()), "calendar"
    elif properties.get("TimersMonotonic"):
        # This is a relative trigger, never a fixed wall-clock promise.
        relative = re.search(r"(On[A-Za-z]+USec=[^;}]+)", properties["TimersMonotonic"])
        if relative:
            schedule, kind = public_text(relative[1].strip()), "interval"
    name = KNOWN_TIMERS.get(unit, "系统计时器 " + stable_id("", unit).lstrip("-")[:6])
    item = task(stable_id(scope, unit), scope, name, kind, schedule, timezone, observed)
    active = properties.get("ActiveState")
    item["enabled"] = True if active == "active" else False if active in ["inactive", "failed"] else None
    item["nextRunAt"] = timestamp(row.get("next"))
    if item["nextRunAt"]:
        item["nextRunKind"] = "authoritative"
    item["lastStartedAt"] = timestamp(service_properties.get("ExecMainStartTimestamp"))
    item["lastFinishedAt"] = timestamp(service_properties.get("ExecMainExitTimestamp"))
    if item["lastStartedAt"] and item["lastFinishedAt"]:
        seconds = (dt.datetime.fromisoformat(item["lastFinishedAt"].replace("Z", "+00:00")) -
                   dt.datetime.fromisoformat(item["lastStartedAt"].replace("Z", "+00:00"))).total_seconds()
        if seconds >= 0:
            item["durationMs"] = int(seconds * 1000)
        else:
            item["lastFinishedAt"] = None
    result = service_properties.get("Result")
    if service_properties.get("ActiveState") == "activating" or (service_properties.get("ActiveState") == "active" and service_properties.get("SubState") == "running"):
        item["state"] = "running"
        item["lastFinishedAt"] = None
        item["durationMs"] = None
    elif result and result != "success":
        item["state"] = "failed"
    elif result == "success" and item["lastFinishedAt"]:
        item["state"] = "succeeded"
    if item["lastStartedAt"] and item["state"] != "running" and service_properties.get("ExecMainCode") == "1":
        try:
            code = int(service_properties.get("ExecMainStatus", ""))
            if 0 <= code <= 255:
                item["exitCode"] = code
        except ValueError:
            pass
    return item

def collect(runner=query, now=None, timezone=None):
    deadline = time.monotonic() + 20
    observed = iso(now or utc_now())
    timezone = timezone if timezone is not None else timezone_name()
    sources, tasks = [], []
    _, output, error = runner(["/usr/bin/crontab", "-l"])
    if error:
        sources.append(error_source("user-cron", "当前用户计划", "cron", observed, error))
    else:
        sources.append(source("user-cron", "当前用户计划", "cron", observed))
        tasks.extend(parse_crontab(output, observed, timezone))
    for scope, flag, name in [("systemd-system", "--system", "系统计时器"), ("systemd-user", "--user", "用户计时器")]:
        _, output, error = runner(["/usr/bin/systemctl", flag, "list-timers", "--all", "--no-pager", "--output=json"])
        if error:
            sources.append(error_source(scope, name, "systemd", observed, error))
            continue
        try:
            rows = json.loads(output)
            if not isinstance(rows, list):
                raise ValueError()
        except (ValueError, TypeError):
            sources.append(error_source(scope, name, "systemd", observed, "query_failed"))
            continue
        info = source(scope, name, "systemd", observed)
        sources.append(info)
        for row in rows[:MAX_TIMERS]:
            if time.monotonic() > deadline:
                info["status"] = "error"
                info["error"] = "query_timeout"
                break
            if not isinstance(row, dict):
                continue
            unit = row.get("unit")
            if not isinstance(unit, str) or not SAFE_UNIT.fullmatch(unit) or not unit.endswith(".timer"):
                continue
            _, output, error = runner(["/usr/bin/systemctl", flag, "show", unit, "--no-pager", "--property=" + SHOW_PROPERTIES])
            if error:
                info["error"] = error
                info["status"] = "permission_denied" if error == "permission_denied" else "error"
            timer_props = parse_properties(output) if not error else {}
            service_props = {}
            service = row.get("activates")
            if isinstance(service, str) and SAFE_UNIT.fullmatch(service) and service.endswith(".service"):
                _, output, error = runner(["/usr/bin/systemctl", flag, "show", service, "--no-pager", "--property=" + SHOW_PROPERTIES])
                if error:
                    info["error"] = error
                    info["status"] = "permission_denied" if error == "permission_denied" else "error"
                else:
                    service_props = parse_properties(output)
            item = parse_timer(row, timer_props, service_props, scope, observed, timezone)
            if item:
                tasks.append(item)
    return dict(version=1, mode="live", observedAt=observed, freshness="fresh", sources=sources, tasks=tasks)

if __name__ == "__main__":
    # No CLI values are accepted: no command, URL, token, path or account override.
    import sys
    if len(sys.argv) != 1:
        raise SystemExit("No arguments accepted. Emits sanitized read-only metadata to stdout.")
    print(json.dumps(collect(), ensure_ascii=False, separators=(",", ":")))
