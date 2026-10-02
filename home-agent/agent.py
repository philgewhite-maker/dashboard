#!/usr/bin/env python3
"""Dashboard home agent.

Runs on the QNAP, where Plex already is. Polls commands.php on the web
host for work, does it here on the LAN, and posts the answer back.

That direction matters: the dashboard is served from GitHub Pages and the
PHP proxies sit on public hosting, so neither can reach anything behind
the router. Polling outward means no port forwarding, no VPN, and no Plex
token anywhere except this machine.

Mostly standard library, with two optional layers added as each site
needed them rather than up front. Neither import is required: if it is
missing, that feature degrades to a plainer answer instead of the agent
failing to start.

  curl_cffi    page.fetch looks like Chrome at the TLS/HTTP2 level, not
               just in its headers -- some sites serve a reduced page to
               anything that doesn't. Falls back to urllib.
  browser      page.render, for the sites that serve a reduced page to
               EVERY plain request including curl_cffi's, because the
               part that's missing is added by JavaScript after load.
               A separate container (docker-compose.yml's `browser`
               service) rather than Playwright in this image, so the few
               hundred MB of Chromium stay optional and restartable on
               their own.

Configuration is entirely environment variables (see .env.example).
"""

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.5"

SYNC_URL = os.environ.get("DASHBOARD_SYNC_URL", "").strip()
SECRET = os.environ.get("DASHBOARD_SECRET", "").strip()
PLEX_URL = os.environ.get("PLEX_URL", "http://localhost:32400").rstrip("/")
PLEX_TOKEN = os.environ.get("PLEX_TOKEN", "").strip()
RADARR_URL = os.environ.get("RADARR_URL", "").rstrip("/")
RADARR_KEY = os.environ.get("RADARR_API_KEY", "").strip()
SONARR_URL = os.environ.get("SONARR_URL", "").rstrip("/")
SONARR_KEY = os.environ.get("SONARR_API_KEY", "").strip()
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "15"))
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


def verb_arr_monitor(args):
    """Monitor only the episodes whose titles match, and search for those.

    For a series where one event produces several episodes -- Formula 1
    gives five a weekend, of which you want the race -- Sonarr has no way
    to say so: it monitors by season or "future episodes", never by title.
    So the dashboard decides which episodes count and this sets exactly
    those, leaving every other episode unmonitored so Sonarr never goes
    hunting a practice session.

    Idempotent on purpose. It runs again every time the dashboard notices
    new episodes, and re-sending the same set is how a newly published
    race weekend gets picked up.
    """
    tvdb_id = args.get("tvdbId")
    if not tvdb_id:
        raise ValueError("arr.monitor needs a tvdbId")
    include = re.compile(args.get("include") or r"\((sprint\s*)?race\)|\(sprint\)", re.I)
    exclude_raw = args.get("exclude")
    exclude = re.compile(exclude_raw, re.I) if exclude_raw else None

    matches = [s for s in arr("sonarr", "/series") if str(s.get("tvdbId")) == str(tvdb_id)]
    if not matches:
        return {"monitored": 0, "reason": "That series isn't in Sonarr yet -- add it first."}
    series = matches[0]

    episodes = arr("sonarr", "/episode", params={"seriesId": series["id"]})
    wanted, unwanted = [], []
    for ep in episodes:
        title = str(ep.get("title") or "")
        keep = bool(include.search(title)) and not (exclude and exclude.search(title))
        (wanted if keep else unwanted).append(ep)

    # Both directions, every run: a title corrected upstream ("Sprint
    # Shootout" renamed) should stop being monitored as well as start.
    if unwanted:
        arr("sonarr", "/episode/monitor", method="PUT",
            body={"episodeIds": [e["id"] for e in unwanted], "monitored": False})
    if wanted:
        arr("sonarr", "/episode/monitor", method="PUT",
            body={"episodeIds": [e["id"] for e in wanted], "monitored": True})

    # Search only for the ones that are missing AND already aired --
    # asking Sonarr to hunt a race that hasn't happened wastes indexer
    # queries, and it'll pick them up on its own RSS sweep anyway.
    today = time.strftime("%Y-%m-%d")
    searchable = [e["id"] for e in wanted
                  if not e.get("hasFile") and str(e.get("airDate") or "9999") <= today]
    if searchable and args.get("search") is not False:
        arr("sonarr", "/command", method="POST",
            body={"name": "EpisodeSearch", "episodeIds": searchable[:200]})

    return {
        "series": series.get("title"),
        "seriesId": series["id"],
        "monitored": len(wanted),
        "unmonitored": len(unwanted),
        "searching": len(searchable),
        "examples": [e.get("title") for e in wanted[-3:]],
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


# How much of a page to carry back. A product page runs ~200KB, and the
# result travels agent -> commands.php -> dashboard, so this is a guard
# against one enormous page filling the queue file rather than a limit
# anything real should hit.
PAGE_MAX_BYTES = 1024 * 1024

# Browser-shaped headers. Not an attempt to disguise anything -- the point
# is that some retailers serve a stripped page, or nothing at all, to a
# request that looks like a script. What makes this work where the web
# host fails isn't these headers, it's the address: this runs on your home
# connection, and Agent Provocateur refuses the datacentre one outright
# (measured: 403 on every request from the web host, 200 from a browser).
PAGE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

# Gap between pages in one batch. Agent Provocateur returns 403s for burst
# traffic -- measured, five rapid fetches and two refused, the same URLs
# fine a few seconds apart. Nothing is waiting on this, so it goes at the
# pace the strictest site tolerates.
PAGE_GAP_SECONDS = 4

# The browser container (docker-compose.yml's `browser` service), for
# pages a plain request never gets whole no matter how it's dressed up.
# Confirmed against browserless's own source, not guessed: POST
# {BROWSER_URL}/content with {"url", "gotoOptions"} returns the page's
# HTML as plain text after Chrome has run it, gotoOptions passing
# straight through to Puppeteer's page.goto() (so "waitUntil" and
# "timeout" are Puppeteer's own values). Empty by default -- page.render
# fails with a clear "not configured" message rather than page.fetch's
# URL silently trying to reach http://:3000.
BROWSER_URL = os.environ.get("BROWSER_URL", "").rstrip("/")
BROWSER_TOKEN = os.environ.get("BROWSER_TOKEN", "").strip()
# Generous: a cold Chromium launch plus a page that waits for its own
# "Wear with" block to hydrate is slower than any plain fetch here, and
# this verb exists for exactly the pages that are slow for that reason.
BROWSER_TIMEOUT_MS = int(os.environ.get("BROWSER_TIMEOUT_MS", "45000"))


# Browser-grade fetching, when the image has it.
#
# Headers were never the whole story. Agent Provocateur serves 194KB with
# the entire product set to a browser and 15KB with only the main garment
# to urllib, at the same URL, in the same minute, from this same
# connection — and a full Chrome header set, a cookie jar and a second
# request changed nothing. What a browser also brings is its TLS
# handshake and HTTP/2, and that is what curl_cffi reproduces.
#
# Optional on purpose: if the import fails the agent still runs and
# page.fetch behaves exactly as it did before, because an agent that
# won't start is worse than one that fetches a smaller page.
try:
    from curl_cffi import requests as curl_requests
    # Which browser to look like. Switchable from .env because AP serves a
    # reduced page to a browser it does not recognise -- it even ships an
    # "we do not support this browser" block in the short version -- and
    # the library default may be several Chrome versions behind what the
    # site expects. Trying another is then a restart, not a rebuild.
    IMPERSONATE = os.environ.get("PAGE_IMPERSONATE", "chrome").strip() or "chrome"
    # One session for the life of the agent, so cookies persist between
    # fetches the way a browser keeps them between page loads.
    PAGE_SESSION = curl_requests.Session(impersonate=IMPERSONATE)
except Exception:  # noqa: BLE001 - any import failure means "use urllib"
    curl_requests = None
    IMPERSONATE = ""
    PAGE_SESSION = None


def fetch_one(url):
    """Returns (status, text). Raises for anything that isn't an HTTP reply."""
    if PAGE_SESSION is not None:
        # impersonate= sets Chrome's TLS and HTTP/2 fingerprint and its
        # default headers, which are an XHR's. The 194KB response was a
        # browser NAVIGATION, and these are what a navigation sends that a
        # fetch() does not. Measured in between: fingerprint alone took
        # the page from 15KB to 73KB, so this is the rest of the same
        # gap rather than a guess at a different one.
        res = PAGE_SESSION.get(
            url,
            timeout=HTTP_TIMEOUT,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": PAGE_HEADERS["Accept-Language"],
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1",
                "Priority": "u=0, i",
            },
            # A session, so a clearance cookie handed out on the first
            # request is presented on the next one. Cloudflare issues
            # those after a fingerprint check passes, and the page served
            # with one is not always the page served without.
            allow_redirects=True,
        )
        # .text decodes using the response's own charset, and curl_cffi
        # handles br/zstd that urllib cannot, which is itself part of
        # looking like a browser.
        return res.status_code, res.text[:PAGE_MAX_BYTES]

    request = urllib.request.Request(url, method="GET")
    for key, value in PAGE_HEADERS.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT, context=ssl.create_default_context()) as response:
        raw = response.read(PAGE_MAX_BYTES)
        charset = response.headers.get_content_charset() or "utf-8"
    return 200, raw.decode(charset, "replace")


def verb_page_fetch(args):
    """Fetch one or more pages from HOME and hand the HTML back.

    Deliberately returns raw HTML rather than parsing anything. The
    dashboard already has a tested parser for every site it reads, in
    JavaScript; writing a second one here in Python would be two things to
    keep in step and the Python one would be the one nobody notices
    breaking. This verb's whole job is to be a pair of eyes on a
    residential connection.
    """
    urls = args.get("urls") or ([args["url"]] if args.get("url") else [])
    if not urls:
        raise ValueError("page.fetch needs a url or urls")
    pages = []
    for index, url in enumerate(urls):
        if not str(url).lower().startswith("https://"):
            pages.append({"url": url, "error": "Only https URLs are fetched"})
            continue
        if index:
            time.sleep(PAGE_GAP_SECONDS)
        try:
            status, text = fetch_one(url)
            if status >= 400:
                # curl_cffi returns a status rather than raising, so a
                # refusal is reported the same way urllib's HTTPError is
                # below instead of being handed back as a page.
                pages.append({"url": url, "status": status, "error": f"HTTP {status}"})
                continue
            # Size is logged because it is the whole question on sites that
            # serve a reduced page: "ok" told you nothing, and 73KB versus
            # 194KB is the difference between a product and a product set.
            log(f"page.fetch {url[-40:]} -> {status}, {len(text)} bytes")
            pages.append({"url": url, "status": status, "html": text})
        except urllib.error.HTTPError as err:
            # Reported per URL, not raised: one refused page shouldn't cost
            # you the eleven that worked.
            pages.append({"url": url, "status": err.code, "error": f"HTTP {err.code}"})
        except Exception as err:
            pages.append({"url": url, "error": f"{type(err).__name__}: {err}"})
    return {"pages": pages}


def verb_page_render(args):
    """Fetch pages through a real browser and hand back the rendered HTML.

    The expensive option, for the sites that answer nothing else. Agent
    Provocateur serves 194,677 bytes with the whole product set to a
    browser and 73,705 with only the main garment to everything short of
    one -- plain urllib, a full Chrome header set, Chrome's TLS and
    HTTP/2 fingerprint, a persistent session, every impersonation target
    curl_cffi offers. Its short version even carries AP's own "we don't
    support this browser" notice, and the "Wear with" set itself is added
    by JavaScript after the document loads, so nothing short of running
    the page gets the rest.

    Separate from page.fetch rather than replacing it: starting a browser
    costs seconds and a few hundred MB where a plain request costs
    neither, so most pages should never reach this. The CALLER says
    which do -- it is not tried as a fallback from page.fetch, because
    that would make every refused page slow rather than just the ones
    that need it.
    """
    if not BROWSER_URL:
        raise RuntimeError(
            "page.render needs the browser container: set BROWSER_URL (and BROWSER_TOKEN) "
            "in .env, then `docker compose up -d` to bring the `browser` service up"
        )
    urls = args.get("urls") or ([args["url"]] if args.get("url") else [])
    if not urls:
        raise ValueError("page.render needs a url or urls")
    pages = []
    for index, url in enumerate(urls):
        if not str(url).lower().startswith("https://"):
            pages.append({"url": url, "error": "Only https URLs are rendered"})
            continue
        if index:
            time.sleep(PAGE_GAP_SECONDS)
        try:
            endpoint = f"{BROWSER_URL}/content"
            if BROWSER_TOKEN:
                endpoint += f"?token={urllib.parse.quote(BROWSER_TOKEN)}"
            # waitUntil networkidle2 rather than the default "load": the
            # set is added to the DOM after the load event fires, and the
            # whole reason for this verb is the part that arrives late.
            # Puppeteer's own values, passed straight through by
            # browserless -- see BROWSER_URL's comment above.
            body = json.dumps({
                "url": url,
                "gotoOptions": {"waitUntil": "networkidle2", "timeout": BROWSER_TIMEOUT_MS},
            }).encode("utf-8")
            request = urllib.request.Request(endpoint, data=body, method="POST")
            request.add_header("Content-Type", "application/json")
            # A little longer than the browser's own timeout, so a page
            # that gives up cleanly at BROWSER_TIMEOUT_MS is the error
            # that surfaces rather than this socket cutting it off first.
            with urllib.request.urlopen(request, timeout=BROWSER_TIMEOUT_MS / 1000 + 15) as response:
                html = response.read(PAGE_MAX_BYTES).decode("utf-8", "replace")
            log(f"page.render {url[-40:]} -> {len(html)} bytes")
            pages.append({"url": url, "status": 200, "html": html})
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read(500).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - the status code is the useful part either way
                pass
            pages.append({"url": url, "status": err.code, "error": f"browser returned HTTP {err.code} {detail}".strip()})
        except Exception as err:
            pages.append({"url": url, "error": f"{type(err).__name__}: {err}"})
    return {"pages": pages}


VERBS = {
    "agent.ping": verb_ping,
    "page.fetch": verb_page_fetch,
    "page.render": verb_page_render,
    "plex.libraries": verb_plex_libraries,
    "plex.search": verb_plex_search,
    "arr.search": verb_arr_search,
    "arr.add": verb_arr_add,
    "arr.monitor": verb_arr_monitor,
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
    # Said at startup because it decides what some sites will even send
    # back, and the symptom of its absence is a page that looks fine but
    # is missing most of itself.
    log(f"page.fetch: impersonating {IMPERSONATE} (curl_cffi)" if PAGE_SESSION else "page.fetch: urllib only -- curl_cffi not installed, some sites will send a reduced page")
    log(f"page.render: browser at {BROWSER_URL}" if BROWSER_URL else "page.render: not configured -- set BROWSER_URL in .env to use it")
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
