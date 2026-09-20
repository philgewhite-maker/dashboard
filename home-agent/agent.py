#!/usr/bin/env python3
"""Dashboard home agent.

Runs on the QNAP, where Plex already is. Polls commands.php on the web
host for work, does it here on the LAN, and posts the answer back.

That direction matters: the dashboard is served from GitHub Pages and the
PHP proxies sit on public hosting, so neither can reach anything behind
the router. Polling outward means no port forwarding, no VPN, and no Plex
token anywhere except this machine.

Standard library only, so the container is just `python:3-alpine` with
this file copied in -- nothing to install, nothing to keep patched.

Configuration is entirely environment variables (see .env.example).
"""

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0"

SYNC_URL = os.environ.get("DASHBOARD_SYNC_URL", "").strip()
SECRET = os.environ.get("DASHBOARD_SECRET", "").strip()
PLEX_URL = os.environ.get("PLEX_URL", "http://localhost:32400").rstrip("/")
PLEX_TOKEN = os.environ.get("PLEX_TOKEN", "").strip()
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "45"))
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "20"))

if not SYNC_URL or not SECRET:
    sys.exit("Set DASHBOARD_SYNC_URL and DASHBOARD_SECRET (see .env.example)")

# commands.php sits next to sync.php, the same way every other proxy this
# dashboard uses does.
COMMANDS_URL = SYNC_URL.replace("sync.php", "commands.php")
if COMMANDS_URL == SYNC_URL:
    sys.exit("DASHBOARD_SYNC_URL should end in sync.php")


def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def http_json(url, method="GET", body=None, headers=None, timeout=HTTP_TIMEOUT):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
        raw = response.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def dashboard(path_and_query, method="GET", body=None):
    separator = "&" if "?" in COMMANDS_URL else "?"
    return http_json(
        f"{COMMANDS_URL}{separator}{path_and_query}",
        method=method,
        body=body,
        headers={"X-Sync-Secret": SECRET},
    )


def plex(path, params=None):
    """Plex Media Server, asked for JSON rather than its default XML."""
    if not PLEX_TOKEN:
        raise RuntimeError("PLEX_TOKEN is not set, so Plex can't be queried")
    query = dict(params or {})
    query["X-Plex-Token"] = PLEX_TOKEN
    url = f"{PLEX_URL}{path}?{urllib.parse.urlencode(query)}"
    return http_json(url, headers={"Accept": "application/json"})


# ---- Verbs ------------------------------------------------------------
#
# An allowlist, not a dispatcher over arbitrary names: this agent runs
# inside the house with a Plex token, and the queue it reads from lives on
# public hosting. Even with the shared secret, the only things it will
# ever do are the ones written here, and all of them are read-only.


def verb_ping(_args):
    return {"version": VERSION, "plexConfigured": bool(PLEX_TOKEN)}


def verb_plex_libraries(_args):
    body = plex("/library/sections")
    sections = body.get("MediaContainer", {}).get("Directory", []) or []
    return {
        "sections": [
            {"key": s.get("key"), "title": s.get("title"), "type": s.get("type")}
            for s in sections
        ]
    }


def verb_plex_search(args):
    """Is this already in the library?

    Plex's own search is fuzzy, which is right for a person typing and
    wrong for an automated answer -- so the title must match exactly
    (case- and punctuation-insensitively), and the year must agree when
    both sides know it. A false "you already have this" is worse than a
    false "you don't": it stops something being acquired at all.
    """
    title = str(args.get("title") or "").strip()
    if not title:
        raise ValueError("plex.search needs a title")
    wanted_year = str(args.get("year") or "").strip()
    kind = str(args.get("kind") or "").strip()
    plex_types = {"film": "movie", "tv": "show"}
    want_type = plex_types.get(kind)

    body = plex("/search", {"query": title})
    container = body.get("MediaContainer", {})
    candidates = []
    for key in ("Metadata", "Video", "Directory"):
        candidates.extend(container.get(key, []) or [])

    def normalise(value):
        return "".join(ch for ch in str(value or "").lower() if ch.isalnum())

    target = normalise(title)
    for item in candidates:
        if normalise(item.get("title")) != target:
            continue
        item_type = item.get("type")
        if want_type and item_type not in (want_type, None):
            continue
        item_year = str(item.get("year") or "")
        if wanted_year and item_year and item_year != wanted_year:
            continue
        return {
            "found": True,
            "ratingKey": item.get("ratingKey"),
            "title": item.get("title"),
            "year": item_year,
            "type": item_type,
            "librarySectionTitle": item.get("librarySectionTitle"),
        }
    return {"found": False, "searched": len(candidates)}


VERBS = {
    "agent.ping": verb_ping,
    "plex.libraries": verb_plex_libraries,
    "plex.search": verb_plex_search,
}


def handle(command):
    verb = command.get("verb")
    handler = VERBS.get(verb)
    if handler is None:
        return False, None, f"This agent doesn't know the verb {verb!r}"
    try:
        return True, handler(command.get("args") or {}), None
    except Exception as err:  # one bad command must never stop the loop
        return False, None, f"{type(err).__name__}: {err}"


def main():
    log(f"Agent {VERSION} starting, polling {COMMANDS_URL} every {POLL_SECONDS}s")
    last_beat = 0.0
    while True:
        try:
            # A heartbeat every few minutes is what lets the dashboard say
            # "the agent is alive" rather than leaving a silent queue
            # looking identical to a stopped container.
            if time.time() - last_beat > 300:
                dashboard("action=heartbeat", method="POST", body={"version": VERSION})
                last_beat = time.time()

            pending = dashboard("action=pending").get("commands", [])
            for command in pending:
                ok, result, error = handle(command)
                log(f"{command.get('verb')} -> {'ok' if ok else error}")
                dashboard(
                    f"action=result&id={urllib.parse.quote(command.get('id', ''))}",
                    method="POST",
                    body={"ok": ok, "result": result, "error": error},
                )
        except urllib.error.HTTPError as err:
            log(f"HTTP {err.code} talking to the dashboard: {err.reason}")
        except Exception as err:
            log(f"{type(err).__name__}: {err}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
