// Every automatic "save a copy of this device's data before the server's
// copy replaces it" goes through here instead of straight to a file download.
// Syncing used to drop a dashboard-backup-<date>.json into Downloads on every
// first load, every merge conflict and every Drive pull -- fine on a personal
// machine, unwelcome on a locked-down work PC.
//
// The policy is per device (a local setting, never synced):
//   ask    (default) a banner offers the download; nothing is written unless
//          it is pressed. The copy is captured when the offer is made, so
//          sync carries on at once and the data it holds is the data from
//          before the replacement, whenever the button is pressed.
//   never  nothing is downloaded, and no banner is shown.
//   always the old behaviour: download immediately.
//
// The Export backup button in Settings is a deliberate action and is not
// gated.
import { data, exportBackup, getLocalSettings, setLocalSetting } from './state.js';

const POLICIES = ['ask', 'never', 'always'];

async function backupPolicy() {
const v = (await getLocalSettings()).backupDownloads;
return POLICIES.includes(v) ? v : 'ask';
}

let banner = null;

function closeBanner() {
if (banner) banner.remove();
banner = null;
}

function showBanner(reason, snapshot) {
// One banner at a time: a second conflict while one is showing replaces
// the held copy with the newer one (it contains the earlier edits too).
if (!banner) {
banner = document.createElement('div');
banner.className = 'backup-offer';
banner.setAttribute('role', 'alert');
banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;padding:12px 14px;border-radius:12px;background:var(--card,#fff);color:var(--text,#222);border:1px solid var(--border,#ccc);box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:14px;';
document.body.appendChild(banner);
}
banner._snapshot = snapshot;
banner.innerHTML = `<div data-backup-reason style="margin-bottom:8px;"></div>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
<button type="button" class="log-btn" data-backup-yes>Download a local backup</button>
<button type="button" class="log-btn" data-backup-no>No thanks</button>
<button type="button" class="log-btn" data-backup-never>Never on this device</button>
</div>`;
banner.querySelector('[data-backup-reason]').textContent = `${reason} Download a copy of this device's version first?`;
banner.querySelector('[data-backup-yes]').addEventListener('click', async () => {
const held = banner._snapshot;
closeBanner();
await exportBackup(held);
});
banner.querySelector('[data-backup-no]').addEventListener('click', closeBanner);
banner.querySelector('[data-backup-never]').addEventListener('click', async () => {
closeBanner();
await setLocalSetting('backupDownloads', 'never');
});
}

// `reason` says what is about to happen to this device's data; `source` is the
// document to keep a copy of (defaults to the live one). Returns what
// happened: 'downloaded', 'offered' or 'skipped'.
async function offerBackup(reason, source) {
const policy = await backupPolicy();
if (policy === 'never') return 'skipped';
// Captured now, before the caller replaces anything.
const text = JSON.stringify(source === undefined ? data : source, null, 2);
if (policy === 'always') {
await exportBackup(text);
return 'downloaded';
}
showBanner(reason, text);
return 'offered';
}

// For the status lines that used to say "saved yours to Downloads".
function backupOutcomePhrase(outcome) {
if (outcome === 'downloaded') return 'yours saved to Downloads';
if (outcome === 'offered') return 'yours can be downloaded from the prompt';
return 'yours was not saved (backup downloads are off on this device)';
}

export { offerBackup, backupPolicy, backupOutcomePhrase, POLICIES };
