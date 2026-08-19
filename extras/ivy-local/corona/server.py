#!/usr/bin/env python3
"""Stdio MCP: Corona localhost API on osiris (127.0.0.1:12701).

Read-only. No /say. Eve: skip extras/ivy-local.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server import MCPServer

CORONA_BASE = "http://127.0.0.1:12701"
TIMEOUT = 30

mcp = MCPServer("corona")


def _dumps(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _safe_error(exc: object) -> str:
    text = str(exc)
    lowered = text.lower()
    for needle in ("authorization:", "bearer ", "discord", "token"):
        if needle in lowered:
            return "Corona request failed (details omitted)."
    return text


def _request(path: str, params: dict[str, str] | None = None) -> str:
    url = CORONA_BASE + path
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return f"Error: Corona HTTP {exc.code}: {_safe_error(raw or exc.reason)}"
    except urllib.error.URLError as exc:
        return f"Error: Corona unreachable at {CORONA_BASE}: {_safe_error(exc.reason)}"
    except TimeoutError:
        return f"Error: Corona timed out after {TIMEOUT}s calling {path}"
    except OSError as exc:
        return f"Error: Corona request failed: {_safe_error(exc)}"
    if not body:
        return f"Error: Corona returned an empty response for {path}"
    try:
        return _dumps(json.loads(body))
    except json.JSONDecodeError:
        return body


def _require_one(api_params: dict[str, str | None], required_label: str) -> dict[str, str] | str:
    params = {key: value.strip() for key, value in api_params.items() if value and value.strip()}
    if not params:
        return f"Error: provide {required_label}"
    return params


@mcp.tool()
def corona_health() -> str:
    """Check Corona on this host (GET /health). No arguments."""
    return _request("/health")


@mcp.tool()
def corona_recipe(query: str | None = None, thread_id: str | None = None) -> str:
    """Fetch a full recipe thread from Corona. Provide query or thread_id (one required)."""
    params = _require_one({"q": query, "thread_id": thread_id}, "query or thread_id")
    if isinstance(params, str):
        return params
    return _request("/fetch", params)


@mcp.tool()
def corona_cigars(query: str | None = None, message_id: str | None = None) -> str:
    """Search Corona cigar notes. Provide query or message_id (one required)."""
    params = _require_one({"q": query, "message_id": message_id}, "query or message_id")
    if isinstance(params, str):
        return params
    return _request("/cigars", params)


@mcp.tool()
def corona_cooking(query: str | None = None, message_id: str | None = None) -> str:
    """Search Corona cooking notes. Provide query or message_id (one required)."""
    params = _require_one({"q": query, "message_id": message_id}, "query or message_id")
    if isinstance(params, str):
        return params
    return _request("/cooking", params)


if __name__ == "__main__":
    mcp.run()
