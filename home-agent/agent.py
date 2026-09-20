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
RADARR_URL = os.environ.get("RADARR_URL", "").rstrip("/")
RADARR_KEY = os.environ.get("RADARR_API_KEY", "").strip()
SONARR_URL = os.environ.get("SONARR_URL", "").rstrip("/")
SONARR_KEY = os.environ.get("SONARR_API_KEY", "").strip()
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
    return {
        "version": VERSION,
        "plexConfigured": bool(PLEX_TOKEN),
        "radarrConfigured": bool(RADARR_URL and RADARR_KEY),
        "sonarrConfigured": bool(SONARR_URL and SONARR_KEY),
    }


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
    """What does the library have that might be this?

    Returns CANDIDATES rather than a verdict. Deciding "yes you own this"
    here would mean either trusting Plex's fuzzy search (a wrong yes
    quietly stops something being acquired at all) or demanding an exact
    title and year -- which breaks on the ordinary cases: international
    releases dated a year apart, "The" dropped from a title, a colon
    where the catalogue has a dash. So the evidence comes back and the
    dashboard auto-accepts only an unambiguous match, asking about
    anything else.
    """
    title = str(args.get("title") or "").strip()
    if not title:
        raise ValueError("plex.search needs a title")
    kind = str(args.get("kind") or "").strip()
    plex_types = {"film": "movie", "tv": "show"}
    want_type = plex_types.get(kind)

    body = plex("/search", {"query": title})
    container = body.get("MediaContainer", {})
    raw = []
    for key in ("Metadata", "Video", "Directory"):
        raw.extend(container.get(key, []) or [])

    def normalise(value):
        text = str(value or "").lower()
        for article in ("the ", "a ", "an "):
            if text.startswith(article):
                text = text[len(article):]
        return "".join(ch for ch in text if ch.isalnum())

    target = normalise(title)
    candidates = []
    for item in raw:
        item_type = item.get("type")
        if item_type not in ("movie", "show"):
            continue
        if want_type and item_type != want_type:
            continue
        name = normalise(item.get("title"))
        if not name:
            continue
        exact = name == target
        if not exact and target not in name and name not in target:
            continue  # Plex matched it on something else entirely (a cast member, say)
        candidates.append({
            "ratingKey": item.get("ratingKey"),
            "title": item.get("title"),
            "year": str(item.get("year") or ""),
            "type": item_type,
            "librarySectionTitle": item.get("librarySectionTitle"),
            "exactTitle": exact,
        })

    candidates.sort(key=lambda c: (not c["exactTitle"], c["title"]))
    return {"candidates": candidates[:6], "searched": len(raw)}


def arr(which, path, method="GET", body=None, params=None):
    """Radarr and Sonarr speak the same API shape, so one helper covers both."""
    base, key = (RADARR_URL, RADARR_KEY) if which == "radarr" else (SONARR_URL, SONARR_KEY)
    if not base or not key:
        raise RuntimeError(f"{which} isn't configured on this agent (see .env)")
    query = urllib.parse.urlencode(params or {})
    url = f"{base}/api/v3{path}" + (f"?{query}" if query else "")
    return http_json(url, method=method, body=body, headers={"X-Api-Key": key})


def _profile_id(which, wanted):
    """Quality profiles are named in the dashboard but numbered in the API.

    The dashboard deliberately sends a NAME ("F1", "Films"), because the
    profile itself -- codecs, size limits, preferred release groups --
    is defined in Radarr/Sonarr and shouldn't be duplicated anywhere
    else. Unmatched or unspecified falls back to the first profile,
    which is what a fresh install has anyway.
    """
    profiles = arr(which, "/qualityprofile")
    if wanted:
        for p in profiles:
            if str(p.get("name", "")).strip().lower() == wanted.strip().lower():
                return p["id"]
    if not profiles:
        raise RuntimeError(f"{which} has no quality profiles yet")
    return profiles[0]["id"]


def _root_folder(which):
    folders = arr(which, "/rootfolder")
    if not folders:
        raise RuntimeError(f"{which} has no root folder set -- add one in its settings first")
    return folders[0]["path"]


def verb_arr_search(args):
    """What does Radarr/Sonarr think this title is? Candidates, not a pick."""
    which = "sonarr" if args.get("kind") == "tv" else "radarr"
    term = str(args.get("title") or "").strip()
    if not term:
        raise ValueError("needs a title")
    path = "/series/lookup" if which == "sonarr" else "/movie/lookup"
    results = arr(which, path, params={"term": term})
    out = []
    for r in results[:6]:
        out.append({
            "title": r.get("title"),
            "year": r.get("year"),
            "tmdbId": r.get("tmdbId"),
            "tvdbId": r.get("tvdbId"),
            "imdbId": r.get("imdbId"),
            "alreadyAdded": bool(r.get("id")),
            "overview": (r.get("overview") or "")[:160],
        })
    return {"service": which, "candidates": out}


def verb_arr_add(args):
    """Add it and start searching.

    Identified by tmdb/tvdb id where the dashboard has one, since that's
    unambiguous in a way a title isn't; otherwise the first lookup hit
    for the exact title given.
    """
    which = "sonarr" if args.get("kind") == "tv" else "radarr"
    term = str(args.get("title") or "").strip()
    tmdb_id = args.get("tmdbId")
    tvdb_id = args.get("tvdbId")

    lookup_term = f"tmdb:{tmdb_id}" if (which == "radarr" and tmdb_id) else (
        f"tvdb:{tvdb_id}" if (which == "sonarr" and tvdb_id) else term)
    path = "/series/lookup" if which == "sonarr" else "/movie/lookup"
    results = arr(which, path, params={"term": lookup_term})
    if not results:
        return {"added": False, "reason": f"{which} found nothing for {lookup_term!r}"}
    chosen = results[0]
    if chosen.get("id"):
        return {"added": False, "already": True, "title": chosen.get("title"), "reason": "already in the library"}

    payload = dict(chosen)
    payload["qualityProfileId"] = _profile_id(which, str(args.get("profile") or ""))
    payload["rootFolderPath"] = _root_folder(which)
    payload["monitored"] = True
    if which == "sonarr":
        payload["seasonFolder"] = True
        payload["addOptions"] = {"searchForMissingEpisodes": True}
    else:
        payload["addOptions"] = {"searchForMovie": True}
    created = arr(which, "/series" if which == "sonarr" else "/movie", method="POST", body=payload)
    return {
        "added": True,
        "service": which,
        "title": created.get("title"),
        "year": created.get("year"),
        "id": created.get("id"),
    }


def verb_arr_status(args):
    """Where has it got to? Queue first, then whether the file exists."""
    which = "sonarr" if args.get("kind") == "tv" else "radarr"
    queue = arr(which, "/queue", params={"pageSize": 200})
    records = queue.get("records", queue) if isinstance(queue, dict) else queue
    wanted_id = args.get("id")
    for record in records or []:
        owner = record.get("movieId") or record.get("seriesId")
        if wanted_id and owner != wanted_id:
            continue
        size = record.get("size") or 0
        left = record.get("sizeleft") or 0
        percent = round((1 - (left / size)) * 100) if size else 0
        return {
            "state": record.get("status"),
            "percent": percent,
            "title": record.get("title"),
            "eta": record.get("timeleft"),
        }
    if wanted_id:
        item = arr(which, f"/movie/{wanted_id}" if which == "radarr" else f"/series/{wanted_id}")
        has_file = item.get("hasFile") if which == "radarr" else (item.get("statistics", {}) or {}).get("episodeFileCount", 0) > 0
        return {"state": "downloaded" if has_file else "waiting", "title": item.get("title")}
    return {"state": "unknown"}


VERBS = {
    "agent.ping": verb_ping,
    "plex.libraries": verb_plex_libraries,
    "plex.search": verb_plex_search,
    "arr.search": verb_arr_search,
    "arr.add": verb_arr_add,
    "arr.status": verb_arr_status,
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
