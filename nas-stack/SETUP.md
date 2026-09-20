# Radarr, Sonarr, Prowlarr and qBittorrent on the QNAP

Roughly 30 minutes, most of it waiting for images to pull.

## Before you start

SSH into the NAS (QTS: Control Panel → Telnet/SSH → enable) and check the
two paths and the user id:

```sh
ls /share/Media/Video      # should list Movies, and whatever TV is called
id admin                   # note the uid= and gid= numbers
```

If `/share/Media` doesn't exist, try `ls /share/CACHEDEV1_DATA/Media` and
use that path instead throughout.

Then create the folders the stack expects:

```sh
mkdir -p /share/Media/downloads/{complete,incomplete}
mkdir -p /share/Container/arr
```

## Start it

Copy this folder to the NAS (any location), then:

```sh
cp .env.example .env
vi .env                    # set MEDIA_ROOT, PUID, PGID to what you found above
docker compose up -d
```

Container Station will also show the four containers once they're up.

| App | Address | What it's for |
|---|---|---|
| Radarr | http://QNAP210-79:7878 | Films |
| Sonarr | http://QNAP210-79:8989 | TV |
| Prowlarr | http://QNAP210-79:9696 | Indexers, shared with both |
| qBittorrent | http://QNAP210-79:8090 | Downloading |

## Wire them together

Do these in order — later steps need the earlier ones.

**1. qBittorrent.** Log in (user `admin`; the first-run password is in
`docker logs qbittorrent`). Change it under Options → Web UI. Then
Options → Downloads:

- Default save path: `/data/downloads/complete`
- Keep incomplete in: `/data/downloads/incomplete`

**2. Radarr.** Settings → Media Management → Add Root Folder →
`/data/Video/Movies`. Turn ON "Use Hardlinks instead of Copy".

Settings → Download Clients → **+** → qBittorrent:

- Host `qbittorrent`, Port `8080` — the name works because they share a
  compose network; don't use the NAS's own address here
- Your username and password
- Category: `radarr`

**3. Sonarr.** The same, with root folder `/data/Video/TV` (use whatever
your TV folder is actually called) and category `sonarr`.

**4. Prowlarr.** Settings → Apps → **+** → Radarr:

- Prowlarr Server: `http://prowlarr:9696`
- Radarr Server: `http://radarr:7878`
- API Key: from Radarr's Settings → General

Repeat for Sonarr (`http://sonarr:8989`). Now add your indexers under
Indexers → **+**, and Prowlarr pushes them into both apps automatically.

**5. Plex.** Point your existing libraries at the same folders if they
aren't already, so an imported film appears without another copy.

## The one rule that matters

Everything is mounted as a single `/data`, so a finished download is
**hardlinked** into the library: instant, no second copy, and the torrent
keeps seeding. If you ever mount downloads and media as two separate
volumes, imports still work but quietly become slow full copies that
double your disk usage.

## Quality preferences

This is where "h265 not h264", "no Dolby Vision", "under 5GB/hour" and a
preferred release group live — not in the dashboard:

- Settings → Profiles → **Quality Profiles**: which resolutions are
  acceptable, in what order.
- Settings → **Custom Formats**: scored rules. Positive for x265,
  negative for DV, positive for a release group you trust. Radarr picks
  the highest total score.
- Each quality has a **size limit in MB per minute**, which is where a
  per-hour ceiling goes.

Make a second profile for anything with different needs (weekly sport,
say, where small and fast beats pristine) — the dashboard's download
route sends a profile name, so it can ask for that one by name.

## Checking it works

In Radarr: Movies → **+** → search a film you don't have → Add. Watch
Activity → Queue. When it finishes, the file should appear under
`/share/Media/Video/Movies` and Plex should pick it up on its next scan.

## Not covered by these

- **Books** — Readarr is no longer maintained; keep using the Media tab's
  buy and search routes.
- **Music** — add Lidarr the same way if you want it automated.
- **A specific release group for something not in a catalogue** (your F1
  example) — that's Autobrr's job, matching announces by pattern, rather
  than Sonarr's.
