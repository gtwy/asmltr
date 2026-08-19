#!/usr/bin/env python3
"""Stdio MCP: Ivy Rolodex cache (separate from /home/adjutant/rolodex).

Reads ~/.asmltr/rolodex-cache/contacts.json (refreshed 07:30 ET from 127.0.0.1:12702/export).
Aliases stay in that cache dir and are never overwritten by sync.
Eve: skip extras/ivy-local.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from mcp.server import MCPServer

CACHE_DIR = Path(os.environ.get("ROLODEX_CACHE") or (Path.home() / ".asmltr" / "rolodex-cache")).expanduser()
CONTACTS_PATH = CACHE_DIR / "contacts.json"
ALIASES_PATH = CACHE_DIR / "aliases.json"
SYNC_SCRIPT = Path(__file__).resolve().parent / "sync.sh"
ET = ZoneInfo("America/New_York")

mcp = MCPServer("rolodex")


def _dumps(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def _load_contacts() -> list[dict[str, Any]] | str:
    if not CONTACTS_PATH.is_file():
        return "Error: contacts.json missing. Run rolodex_sync (or wait for the 07:30 ET timer)."
    try:
        data = _load_json(CONTACTS_PATH)
    except (OSError, json.JSONDecodeError) as exc:
        return f"Error: contacts.json unreadable ({type(exc).__name__})"
    if isinstance(data, list):
        results = data
    elif isinstance(data, dict):
        results = data.get("results")
    else:
        results = None
    if not isinstance(results, list):
        return "Error: contacts.json has no results list"
    return [row for row in results if isinstance(row, dict)]


def _load_aliases() -> dict[str, dict[str, Any]] | str:
    if not ALIASES_PATH.is_file():
        return {}
    try:
        data = _load_json(ALIASES_PATH)
    except (OSError, json.JSONDecodeError) as exc:
        return f"Error: aliases.json unreadable ({type(exc).__name__})"
    if not isinstance(data, dict):
        return "Error: aliases.json must be an object"
    out: dict[str, dict[str, Any]] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            out[key.casefold()] = value
    return out


def _save_aliases(aliases: dict[str, dict[str, Any]]) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ALIASES_PATH.with_name(f"aliases.json.tmp.{os.getpid()}")
    try:
        tmp.write_text(_dumps(aliases) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, ALIASES_PATH)
        os.chmod(ALIASES_PATH, 0o600)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return f"Error: could not write aliases.json ({type(exc).__name__})"
    return None


def _digits(value: str) -> str:
    return "".join(ch for ch in value if ch.isdigit())


def _contact_matches(row: dict[str, Any], needle: str) -> bool:
    if needle in (row.get("displayName") or "").casefold():
        return True
    org = row.get("organization")
    if isinstance(org, str) and needle in org.casefold():
        return True
    for email in row.get("emails") or []:
        if isinstance(email, str) and needle in email.casefold():
            return True
    needle_digits = _digits(needle)
    for phone in row.get("phones") or []:
        if not isinstance(phone, str):
            continue
        if needle in phone.casefold():
            return True
        if needle_digits and needle_digits in _digits(phone):
            return True
    return False


def _prefs_for(resource: str, aliases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    keys: list[str] = []
    for key, rec in aliases.items():
        if (rec.get("resourceName") or "") == resource:
            keys.append(key)
            email = (rec.get("preferredEmail") or "").strip()
            phone = (rec.get("preferredPhone") or "").strip()
            if email and "preferredEmail" not in extra:
                extra["preferredEmail"] = email
            if phone and "preferredPhone" not in extra:
                extra["preferredPhone"] = phone
    if keys:
        extra["aliases"] = keys
    return extra


def _decorate(row: dict[str, Any], aliases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    out = dict(row)
    resource = out.get("resourceName") or ""
    if resource:
        out.update(_prefs_for(resource, aliases))
    return out


def _find_by_resource(contacts: list[dict[str, Any]], resource: str) -> dict[str, Any] | None:
    for row in contacts:
        if row.get("resourceName") == resource:
            return row
    return None


def _search_contacts(contacts: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    needle = query.casefold()
    hits = [row for row in contacts if _contact_matches(row, needle)]
    exact = [row for row in hits if (row.get("displayName") or "").casefold() == needle]
    if exact:
        seen = {id(row) for row in exact}
        return exact + [row for row in hits if id(row) not in seen]
    return hits


def _mtime_et(path: Path) -> str | None:
    if not path.is_file():
        return None
    ts = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone(ET)
    return ts.isoformat(timespec="seconds")


def _pick_one(
    contacts: list[dict[str, Any]],
    aliases: dict[str, dict[str, Any]],
    name: str | None,
    resource_name: str | None,
) -> dict[str, Any] | str:
    resource = (resource_name or "").strip()
    label = (name or "").strip()
    if not resource and not label:
        return "Error: provide name or resourceName"
    if not resource and (label.startswith("people/") or label.startswith("otherContacts/")):
        resource, label = label, ""

    alias_key = None
    if not resource and label:
        key = label.casefold()
        rec = aliases.get(key)
        if rec:
            alias_key = key
            resource = (rec.get("resourceName") or "").strip()
            if not resource:
                return f"Error: alias {key!r} has no resourceName"

    if resource:
        row = _find_by_resource(contacts, resource)
        if row is None:
            payload = {
                "error": "not found",
                "resourceName": resource,
                "name": label or None,
            }
            if alias_key:
                payload["alias"] = alias_key
            return _dumps(payload)
        out = _decorate(row, aliases)
        if alias_key:
            out["alias"] = alias_key
        return out

    hits = _search_contacts(contacts, label)
    if not hits:
        return _dumps({"error": "not found", "name": label})
    needle = label.casefold()
    chosen = hits[0]
    for row in hits:
        if (row.get("displayName") or "").casefold() == needle:
            chosen = row
            break
    return _decorate(chosen, aliases)


@mcp.tool()
def rolodex_health() -> str:
    """Ivy Rolodex cache stats: contact count, alias count, contacts.json mtime. Local cache only."""
    contacts = _load_contacts()
    aliases = _load_aliases()
    if isinstance(contacts, str):
        contact_count = None
        contact_error = contacts
    else:
        contact_count = len(contacts)
        contact_error = None
    if isinstance(aliases, str):
        alias_count = None
        alias_error = aliases
    else:
        alias_count = len(aliases)
        alias_error = None
    payload: dict[str, Any] = {
        "ok": contact_error is None and alias_error is None,
        "service": "rolodex",
        "mode": "ivy-cache",
        "cache": str(CACHE_DIR),
        "contacts": contact_count,
        "aliases": alias_count,
        "contacts_mtime": _mtime_et(CONTACTS_PATH),
        "source": "http://127.0.0.1:12702/export",
        "timer": "07:30 America/New_York",
    }
    if contact_error:
        payload["contacts_error"] = contact_error
    if alias_error:
        payload["aliases_error"] = alias_error
    return _dumps(payload)


@mcp.tool()
def rolodex_search(query: str) -> str:
    """Search the Ivy contacts cache (name, email, phone, org). Exact alias keys resolve first."""
    q = (query or "").strip()
    if not q:
        return "Error: provide query"
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases

    key = q.casefold()
    rec = aliases.get(key)
    if rec:
        resource = (rec.get("resourceName") or "").strip()
        row = _find_by_resource(contacts, resource) if resource else None
        if row is None:
            return _dumps(
                {
                    "query": q,
                    "count": 0,
                    "alias": key,
                    "error": "alias exists but that contact is not in the local cache",
                    "resourceName": resource or None,
                }
            )
        person = _decorate(row, aliases)
        person["alias"] = key
        if rec.get("preferredEmail"):
            person["preferredEmail"] = rec["preferredEmail"]
        if rec.get("preferredPhone"):
            person["preferredPhone"] = rec["preferredPhone"]
        return _dumps({"query": q, "count": 1, "alias": key, "results": [person]})

    hits = [_decorate(row, aliases) for row in _search_contacts(contacts, q)]
    return _dumps({"query": q, "count": len(hits), "results": hits})


@mcp.tool()
def rolodex_get(name: str | None = None, resourceName: str | None = None) -> str:
    """Fetch one contact from the Ivy cache. Name may be an alias key."""
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases
    result = _pick_one(contacts, aliases, name, resourceName)
    if isinstance(result, str):
        return result
    return _dumps(result)


@mcp.tool()
def rolodex_alias(
    nickname: str,
    displayName: str | None = None,
    resourceName: str | None = None,
    preferredEmail: str | None = None,
    preferredPhone: str | None = None,
) -> str:
    """Add or update a nickname in Ivy's cache. Does not touch contacts.json or the Rolodex service."""
    key = (nickname or "").strip().casefold()
    if not key:
        return "Error: provide nickname"
    contacts = _load_contacts()
    if isinstance(contacts, str):
        return contacts
    aliases = _load_aliases()
    if isinstance(aliases, str):
        return aliases

    resource = (resourceName or "").strip()
    label = (displayName or "").strip()
    existing = aliases.get(key) or {}

    if not resource and label:
        needle = label.casefold()
        matches = [row for row in contacts if (row.get("displayName") or "").casefold() == needle]
        if not matches:
            matches = _search_contacts(contacts, label)
        if not matches:
            return f"Error: no contact matching displayName {label!r}"
        exact = [row for row in matches if (row.get("displayName") or "").casefold() == needle]
        if (len(exact) > 1) or (not exact and len(matches) > 1):
            pool = exact or matches
            return _dumps(
                {
                    "error": "ambiguous displayName; pass resourceName",
                    "matches": [row.get("displayName") or row.get("resourceName") for row in pool[:8]],
                    "count": len(pool),
                }
            )
        chosen = exact[0] if exact else matches[0]
        resource = chosen.get("resourceName") or ""
        if not label:
            label = chosen.get("displayName") or ""

    if not resource:
        resource = (existing.get("resourceName") or "").strip()
    if not resource:
        return "Error: provide displayName or resourceName"

    row = _find_by_resource(contacts, resource)
    if row is None:
        return f"Error: resourceName {resource!r} is not in the local cache"

    record: dict[str, Any] = {
        "displayName": label or row.get("displayName") or existing.get("displayName"),
        "resourceName": resource,
    }
    email = (preferredEmail or "").strip() or (existing.get("preferredEmail") or "").strip()
    phone = (preferredPhone or "").strip() or (existing.get("preferredPhone") or "").strip()
    if email:
        record["preferredEmail"] = email
    if phone:
        record["preferredPhone"] = phone

    aliases[key] = record
    err = _save_aliases(aliases)
    if err:
        return err
    return _dumps({"ok": True, "nickname": key, "alias": record})


@mcp.tool()
def rolodex_sync() -> str:
    """Refresh Ivy contacts.json from localhost Rolodex GET /export. Never writes aliases.json."""
    if not SYNC_SCRIPT.is_file():
        return f"Error: sync script missing at {SYNC_SCRIPT}"
    try:
        completed = subprocess.run(
            [str(SYNC_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=210,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "Error: sync timed out (aliases.json not touched)"
    except OSError as exc:
        return f"Error: could not start sync ({type(exc).__name__})"

    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip() or f"exit {completed.returncode}"
        return f"Error: sync failed (exit {completed.returncode}): {err}"

    contacts = _load_contacts()
    aliases = _load_aliases()
    return _dumps(
        {
            "ok": True,
            "message": (completed.stdout or "").strip(),
            "contacts": len(contacts) if isinstance(contacts, list) else None,
            "aliases": len(aliases) if isinstance(aliases, dict) else None,
            "contacts_mtime": _mtime_et(CONTACTS_PATH),
        }
    )


if __name__ == "__main__":
    mcp.run()
