"""The NAS as a device of its own: opens the dashboard in the NAS's headless
browser every APP_RUNNER_MINUTES and lets it run whatever scheduled syncs are
due, exactly as opening the app on a phone would (js/features/scheduled.js,
"The NAS runner"). Nothing is ported: the app's own code does the work, so a
sync behaves the same here as anywhere else.

Each visit:
  1. opens a same-origin page of the app (its manifest) and writes the
     device-local settings the app needs (sync URL + secret, and optionally
     the Anthropic key and the end-to-end sync key) into the app's own
     IndexedDB through the app's own js/db.js, and marks the browser as the
     runner (localStorage dash-runner=nas, device tag 'nas');
  2. opens the app, which pulls the server's copy, checks the Settings switch
     (prefs.nasRunner.enabled -- untick it and this does nothing), runs what's
     due, pushes, and leaves window.__dashRunnerResult;
  3. reads that result back and logs one line.

Google syncs need Google linked to the web host (server/google-token.php):
the headless browser can never open a sign-in window. Without it, only the
non-Google tasks run here and the Google ones stay with your devices.

Every browserless session is a fresh profile, so nothing persists on the NAS
between visits. The secrets pass from this container to the browser
container over 127.0.0.1 only.

Switching off: untick the box in Settings (the next visit exits early), or set
APP_RUNNER_MINUTES=0 / remove APP_RUNNER_URL here. Devices never wait for the
NAS, so losing it only means the syncs run on the next device open instead.

Stdlib only; runs on its own thread so the command queue keeps polling.
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

RUNNER_FUNCTION = """
export default async function ({ page, context }) {
  const { appUrl, settings, waitMs } = context;
  const origin = new URL(appUrl);
  await page.goto(new URL('manifest.webmanifest', origin).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async ({ settings, dbUrl }) => {
    localStorage.setItem('dash-runner', 'nas');
    localStorage.setItem('dash-device-tag', 'nas');
    const db = await import(dbUrl);
    const current = (await db.kvGet('local-settings')) || {};
    await db.kvSet('local-settings', { ...current, ...settings });
  }, { settings, dbUrl: new URL('js/db.js', origin).href });
  await page.goto(origin.href, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => !!window.__dashRunnerResult, { timeout: waitMs, polling: 2000 });
  const result = await page.evaluate(() => window.__dashRunnerResult);
  return { data: JSON.stringify(result), type: 'application/json' };
}
"""


class AppRunner:
    def __init__(self, browser_url, browser_token, app_url, sync_url, sync_secret,
                 minutes=30, anthropic_key="", sync_key="", wait_minutes=12, log=print):
        self.browser_url = (browser_url or "").rstrip("/")
        self.browser_token = browser_token or ""
        self.app_url = (app_url or "").strip()
        if self.app_url and not self.app_url.endswith("/"):
            self.app_url += "/"
        self.sync_url = sync_url
        self.sync_secret = sync_secret
        self.minutes = max(0, int(minutes or 0))
        self.anthropic_key = (anthropic_key or "").strip()
        self.sync_key = (sync_key or "").strip()
        self.wait_ms = max(2, int(wait_minutes or 12)) * 60000
        self.log = log
        self.last_start = 0.0
        self.thread = None

    def configured(self):
        return bool(self.browser_url and self.app_url and self.minutes > 0)

    def describe(self):
        if not self.browser_url:
            return "app runner: off -- needs the browser container (BROWSER_URL)"
        if not self.app_url or self.minutes <= 0:
            return "app runner: off -- set APP_RUNNER_URL (and APP_RUNNER_MINUTES, default 30) in .env to let the NAS run scheduled syncs"
        extras = [k for k, v in (("Anthropic key", self.anthropic_key), ("sync key", self.sync_key)) if v]
        return (f"app runner: {self.app_url} every {self.minutes} min"
                + (f", with {' and '.join(extras)}" if extras else ", no Anthropic key (AI-assisted syncs will skip)"))

    def tick(self):
        """Called from the main loop; starts a visit on its own thread when one is due."""
        if not self.configured():
            return
        if self.thread and self.thread.is_alive():
            return
        # First visit two minutes after start, so a container restart doesn't race the agent's own startup.
        if self.last_start == 0.0:
            self.last_start = time.time() - self.minutes * 60 + 120
        if time.time() - self.last_start < self.minutes * 60:
            return
        self.last_start = time.time()
        self.thread = threading.Thread(target=self._visit_safely, name="app-runner", daemon=True)
        self.thread.start()

    def _settings(self):
        s = {"syncUrl": self.sync_url, "syncSecret": self.sync_secret}
        if self.anthropic_key:
            s["anthropicApiKey"] = self.anthropic_key
        if self.sync_key:
            s["syncKey"] = self.sync_key
            s["syncEncrypted"] = True
        return s

    def _visit_safely(self):
        started = time.time()
        try:
            result = self.visit()
            took = round(time.time() - started)
            if not result.get("ok"):
                self.log(f"app runner: failed after {took}s -- {result.get('error')}")
            elif result.get("skipped"):
                self.log(f"app runner: {result['skipped']}")
            else:
                ran = ", ".join(result.get("ran") or []) or "nothing was due"
                fails = "; ".join(result.get("failures") or [])
                google = "" if result.get("canGoogle") else " (no Google: link it to the web host)"
                self.log(f"app runner: {took}s, ran {ran}{google}" + (f"; failed {fails}" if fails else ""))
        except Exception as err:  # noqa: BLE001 - a bad visit must never take the agent down
            self.log(f"app runner: {type(err).__name__}: {err}")

    def visit(self):
        query = {"timeout": str(self.wait_ms + 180000)}  # the whole session: two page loads + the run
        if self.browser_token:
            query["token"] = self.browser_token
        endpoint = f"{self.browser_url}/function?{urllib.parse.urlencode(query)}"
        body = json.dumps({
            "code": RUNNER_FUNCTION,
            "context": {"appUrl": self.app_url, "settings": self._settings(), "waitMs": self.wait_ms},
        }).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=(self.wait_ms + 240000) / 1000) as response:
                raw = response.read(2_000_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read(400).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
            return {"ok": False, "error": f"browser HTTP {err.code} {detail}".strip()}
        parsed = json.loads(raw) if raw.strip() else {}
        # browserless can hand the return value back as is or wrapped as {data, type}.
        if isinstance(parsed, dict) and "data" in parsed and "ok" not in parsed:
            parsed = parsed["data"]
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        return parsed if isinstance(parsed, dict) else {"ok": False, "error": f"unexpected reply: {raw[:200]}"}
