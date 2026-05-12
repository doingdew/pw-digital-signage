# Pittwater Signage Server

Multi-screen digital signage. One server, many TVs, one admin panel.

```
admin  →  server  →  TV 1  ("Lobby")
         (Node +    TV 2  ("Reception")
          SQLite)   TV 3  ("Warehouse")
                    …
```

Each TV has its own URL (`/s/<slug>`), its own config (zones, fonts, colors, logos, locations, integrations), and its own live WebSocket for instant updates. Admin pushes a change → server saves to SQLite → all TVs viewing that screen update in <1 second.

## Quick start (Docker)

```bash
# 1. Build and run
docker compose up -d --build

# 2. Open admin
open http://localhost:3000/login

# 3. Create your first admin user (the form auto-detects first run)

# 4. Create a screen — give it a name like "Lobby"
#    The server gives you a slug — point a TV browser at:
#    http://<server-ip>:3000/s/lobby
```

That's it. The server, database, uploads, and WebSocket all run in one container. Persistent data lives in `./data/` — back that folder up.

## Persistence

Everything that needs to survive a restart is in `./data/`:

- `data/signage.db` — SQLite database (screens, users, sessions, messages, upload metadata, integration settings)
- `data/uploads/` — uploaded logo and image files

Mounted as a volume in `docker-compose.yml`. To back up:

```bash
# Stop briefly to ensure consistent SQLite state
docker compose stop signage
tar czf signage-backup-$(date +%F).tar.gz data/
docker compose start signage
```

## Configuration

### Environment variables

Set these in `docker-compose.yml`. Sessions are stored server-side in SQLite — there is no shared secret to configure.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Listen port inside the container |
| `DATA_DIR` | `/app/data` | Where the DB + uploads live (don't change unless you also change the volume mount) |
| `TRUST_PROXY` | `0` | Set to `1` if you put nginx / Traefik / a load balancer in front |
| `COOKIE_SECURE` | `0` | Set to `1` to send the session cookie only over HTTPS. Pair with `TRUST_PROXY=1` behind a TLS terminator. |
| `UNIFI_PORT` | `12445` | (Optional) UniFi Access controller port — only used if you set up the legacy env-var-based UniFi config; the admin Settings page is preferred. |

### Per-screen config vs global settings

Most config is **per-screen** — different lobby and warehouse screens can have different layouts, themes, zones, and feeds. A handful of items are **global server-wide** because they're credentials or apply to the host:

Global (in admin → **Settings**):
- Google Maps API key (for the radar + traffic zones)
- UniFi Protect API key, UniFi Access API key, UniFi controller host (for the doors zone + camera grid)

Global (in their own admin tabs):
- Slack bot — admin → **Slack**
- Hikvision smart-event camera — admin → **Hikvision Cam**

Everything else (theme, zones, weather location, fonts, sheet URLs, etc.) is per-screen.

## Adding a new screen

1. Open admin → **+ New Screen**
2. Enter a name like "Lobby" — server picks a slug automatically (you can override it on creation, or rename later via the **Change URL** button in the top bar)
3. Click into the screen → adjust zones, font, colors, integrations
4. On the TV browser, open `http://<server>:3000/s/<slug>`
5. Any changes you save in admin appear on the TV in <1 second over WebSocket

If you change the slug after the fact, connected TVs auto-navigate to the new URL via a `SLUG_CHANGED` WebSocket message — no manual reload needed.

## Pointing a TV at a screen

Most modern TVs and small kiosk PCs work well as signage clients:

- **Chromebox / NUC / Raspberry Pi 4 with Chromium** — best option. Boot into a kiosk-mode browser pointing at the URL.
- **Smart TV with built-in browser** — works if it's a recent enough model (~2018+).
- **Fire TV / Apple TV with browser sideload** — works but more fiddly.

Kiosk mode example for Chromium on Linux:

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  http://your-server:3000/s/lobby
```

### Reliability on Raspberry Pi (long-running kiosks)

Out-of-the-box Chromium on a Pi 4 will gradually accumulate memory and can crash ("Aw, Snap!") after a few hours to days of continuous play. The signage page already does most of the heavy lifting in code — but a couple of system-level tweaks turn an unreliable kiosk into one that runs for weeks.

**1. The app self-recovers.** Three layers, all enabled by default and tunable in admin → per-screen config (the signage page reloads on each trigger):

- **Nightly reload** (`reloadHour`/`reloadMinute`, default 03:00 local) — a clean slate during off-hours.
- **Heap watchdog** (`kioskMaxHeapMb`, default 700 MB) — if the JS heap balloons past this threshold mid-day, reload before Chromium runs out of headroom.
- **Max uptime** (`kioskMaxUptimeHours`, default 12 h) — reload after this long even if heap looks fine, catching non-JS leaks (detached DOM, GPU resources).

Set any of these to `0` to disable.

**2. Chromium flags that make a real difference on Pi.** Replace the basic invocation with:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --password-store=basic --no-first-run --no-default-browser-check \
  --disable-features=TranslateUI,UserAgentClientHint \
  --disable-pinch --overscroll-history-navigation=0 \
  --enable-features=OverlayScrollbar \
  --disk-cache-size=33554432 \
  --use-gl=egl \
  http://your-server:3000/s/lobby
```

The Pi-specific bits are `--use-gl=egl` (uses the native GPU instead of llvmpipe — major stability win on Bullseye+) and `--disk-cache-size=33554432` (caps the cache at 32 MB so it doesn't eat the SD card).

**3. Run Chromium under systemd so a crash auto-restarts.** Drop this file at `/etc/systemd/system/signage-kiosk.service` and `systemctl enable --now signage-kiosk`:

```ini
[Unit]
Description=Signage kiosk (Chromium)
After=graphical.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/pi/.Xauthority
ExecStartPre=/usr/bin/rm -rf /home/pi/.config/chromium/Singleton*
ExecStart=/usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --password-store=basic --no-first-run --no-default-browser-check \
  --disable-features=TranslateUI \
  --disk-cache-size=33554432 \
  --use-gl=egl \
  http://your-server:3000/s/lobby
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
```

If Chromium ever does crash, systemd restarts it within 5 seconds. Combined with the in-app watchdog above, this is what makes the kiosk survive for weeks.

**4. Hardware tips.**
- Use an SSD over USB 3.0 instead of an SD card if you can — SD cards die when written constantly.
- Use an active cooler / heatsink. Throttling Pi → slow renders → more GPU stalls.
- A 4 GB Pi 4 is fine; an 8 GB is more comfortable if you're showing the Stocks Big Board (500 DOM nodes) regularly.

## Zones

Each screen rotates through whichever **zones** you've enabled, dwelling on each for a configurable interval. Empty zones (e.g. no upcoming sports games, no weather configured) auto-skip. Pick and reorder them in admin → **Zones**.

| Zone | What it shows |
|---|---|
| **Clock** | Big digital, minimal, or analog clock with optional date + small world clocks row |
| **World Clocks** | Pin cities on a dotted world map with their local times |
| **Sun Arc** | Sunrise/sunset arc for the configured location |
| **Weather** | Current weather for a location, optional 3-day forecast |
| **Shipments** | Google Sheet → table of incoming POs (column-A row count + first non-empty rows) |
| **Warehouse Dashboard** | Three visual panels driven by Google Sheets: Receiving, Orders to Pick, Orders to Ship. Each panel shows a hero count + the latest entries as themed chips. |
| **KPI** | Either custom user-defined metrics or auto-derived stats from the Shipments sheet |
| **Today's Number** | One huge number — countup from a date, or a static value |
| **Safety / Motivation** | Rotating quote/message lists |
| **Calendar** | iCal feeds aggregated into a single upcoming-events list (Google Calendar, etc.) |
| **Meeting Rooms** | Per-room Free / Soon / Busy status from each room's iCal — recurring meetings expanded |
| **Sports Results / Sports Upcoming** | Last 24h of finals and next 24h of scheduled games for picked leagues (NFL/NBA/MLB/NHL/MLS via ESPN's public API) |
| **Stocks: Markets** | Live prices for picked indices + custom symbols (Yahoo Finance proxy) |
| **Stocks: Big Board** | Full S&P 500 sector treemap. Snapshot refreshes 3× per US trading day (9:35 / 12:45 / 16:05 ET) |
| **Trends** | Top news headlines + top Google Trends searches |
| **Doors** | UniFi Access door status + Protect camera snapshots in a configurable grid |
| **Radar** | NEXRAD weather radar overlay on a Google Maps base |
| **Traffic** | Google Maps traffic layer for a configured location |
| **Slides** | Embed any published Google Slides deck full-bleed |
| **Slack Messages** | Stack of recent Slack messages broadcast to all TVs |

### Camera & message overlays

Three full-screen overlays paint on top of any zone:

- **Camera overlay** — pops when the Hikvision smart-event listener fires (or when triggered manually). Auto-dismisses after a configurable duration.
- **Message overlay** — Slack broadcast or admin "Send Message" lands as a centered overlay; ticker bar persists at the bottom for the next 30 minutes.
- **Door overlay** — when a door event fires from UniFi Access.

## Appearance

Admin → **Appearance**:

- **Theme presets** — about 14 curated dark and light themes (Midnight, Slate, Sunset, Forest, Mint, Twilight, Magenta, Pure Black, Industrial, Daylight, Paper, …) plus custom hex pickers for `--bg` and `--accent`. Light themes auto-flip text and card surfaces to dark-on-light by luminance detection — Daylight and Paper read cleanly without any manual override.
- **Top header size** — small / medium / large / xl scales the logo, time, weather, and date together.
- **Font** — pick from a curated Google Fonts list. Loaded from CDN; for offline operation drop self-hosted woff2 files under `public/fonts/woff2/` and edit `public/fonts/fonts.js`.
- **Logo** — upload from Assets, paste a URL, or leave blank.
- **Ambient Background Motion** — optional CSS-only drifting overlay on every zone. Five patterns (Drift / Aurora / Stars / Grid / Waves) with an intensity slider. Pure GPU transforms — no JS, no CPU on the kiosk. Off by default.

## File uploads (logos, images)

The **Assets** sidebar item lets you upload PNG, JPG, SVG, GIF, or WebP up to 8 MB. They're stored on disk under `data/uploads/` and served at stable URLs like `/files/<id>.png`.

In any image-using setting (logo) click **Choose from Assets** to pick from your library, or **Upload** to upload a new one inline.

## Slack integration (Slack ↔ TVs)

Mirror messages from a Slack channel onto every TV, **and** post Slack alerts when the Hikvision camera fires. Useful for company-wide announcements, urgent alerts, or letting the warehouse team broadcast something from their phone.

The integration uses **Socket Mode**, which means the server connects out to Slack. **No inbound port required** — works behind any firewall or NAT.

### One-time Slack app setup (~5 minutes)

1. Go to **api.slack.com/apps** and click **Create New App** → **From scratch**. Name it "Signage" (or whatever) and pick your workspace.

2. **Enable Socket Mode**:
   - Left sidebar → **Socket Mode** → toggle on
   - Generate an **App-Level Token** with the `connections:write` scope. Starts with `xapp-…`.

3. **Add bot scopes** under **OAuth & Permissions** → **Bot Token Scopes**:
   - `channels:read`, `channels:history` — public channel access
   - `groups:read`, `groups:history` — private channel access
   - `users:read` — resolve user IDs to display names
   - `chat:write` — post messages (incl. Hikvision alert text)
   - `files:write` — required to attach the snapshot to Hikvision alerts

4. **Subscribe to events** → toggle on → add `message.channels` and/or `message.groups`. Save.

5. **Install the app to your workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`).
   - **If you change scopes later**, Slack shows a yellow "Reinstall app" banner — you must reinstall before new scopes take effect.

6. **Invite the bot to the channel** you want to mirror:
   ```
   /invite @YourSignageApp
   ```

7. **Get the channel ID**: right-click the channel name → **View channel details** → bottom of the panel.

### Configure in admin

8. Open admin → **Slack**. Paste the three values:
   - **Bot Token** (`xoxb-…`)
   - **App Token** (`xapp-…`)
   - **Channel ID** (`C0123456789`)
9. Click **Test Connection**, then **Save & Connect**. The status indicator should flip to "● Connected".

Behaviour notes:
- Only top-level posts in the configured channel are mirrored. Thread replies, edits, joins/leaves, and bot messages are filtered out.
- The Slack user's display name appears as the sender on the TV.
- Slack-flavored markup (mentions, channel links, URL formatting) is converted to plain text.
- Messages auto-expire after 30 minutes (same as messages sent from the admin panel).

## Hikvision smart-event camera + Slack alerts

When a Hikvision IP camera fires a Line Crossing or Intrusion Detection event, every signage screen pops the camera overlay with a live snapshot, and the configured Slack channel receives a snapshot + message. Boundaries and target classification (person / vehicle) live on the camera, not in this app — we subscribe to its ISAPI alertStream.

### Configure on the camera

In the Hikvision web UI (`http://<camera-ip>`):

1. **Configuration → Event → Smart Event** → enable **Line Crossing Detection** or **Intrusion Detection**.
2. Draw your boundary on the live preview.
3. Tick the **Detection Target Type** (Human / Vehicle / Both).
4. Under **Linkage Method** ensure **Notify Surveillance Center** is checked. *This is what publishes events on the alertStream.*
5. Save.

### Configure in admin

1. Admin → **Hikvision Cam** tab.
2. Fill in the connection card — host (IP, optionally `:port`), username, password, display label.
3. Click **Test Connection** — should report camera model + firmware.
4. Toggle **Listener enabled** on, click **Save**. Indicator flips to "● Connected".
5. Slack Notification card — toggle **Send Slack alert on trigger** and paste the Slack channel ID. The bot must be a member of the channel and have `files:write` (the helper falls back to a text-only message with a warning if the scope is missing).
6. **Fire Test Trigger** to verify the end-to-end path without walking past the camera.

Filters in the Event Filters card:
- **Event types** — comma-separated whitelist (`linedetection`, `fielddetection`, `regionEntrance`, `regionExiting`, `VMD`). Empty = accept everything.
- **Target classes** — comma-separated whitelist (`person`, `vehicle`, `motorVehicle`, `nonMotorVehicle`). Empty = accept everything.
- **Debounce** — same class won't re-trigger within this window (default 30 s).
- **Overlay duration** — how long the popup stays on screen (default 15 s).

The signage browser polls a server-proxied snapshot at ~2 fps for the duration of the overlay. The camera credentials never leave the server.

## Warehouse Dashboard

A three-panel visual zone driven by three Google Sheets — Receiving, Orders to Pick, Orders to Ship.

Each panel shows:
- A hero count of rows whose **column A** is non-empty.
- The latest 5 entries as accent-themed chips.
- A subtle blurred orb in the corner for visual punch.

Configure under admin → **Warehouse**:
- Paste a Google Sheets share URL into each of the three fields. Sheets must be shared as "Anyone with the link can view" so the kiosk browser can fetch the CSV export.
- Display columns are hard-coded per panel in [`public/signage/app.js`](public/signage/app.js) under `WAREHOUSE_PANELS` — currently:
  - Receiving: `Manufacturer DBA — Product Name`
  - Pick: `Planned Pick Date — Inventory Account — Picklist — Planned Ship Date`
  - Ship: `Inventory Account — Planned Ship Date`
- The header matcher is fuzzy (case + punctuation insensitive) — `Part Number` matches `PartNumber`, `Part #`, `PART_NUMBER`, etc. If a column isn't found the chip falls back to column A and a `[warehouse]` line appears in the browser console listing the actual sheet headers.

The zone auto-skips in rotation when none of the three URLs are configured.

## Stocks: S&P 500 Big Board

A sector-grouped treemap of the entire S&P 500. The 503-symbol snapshot is refreshed by the server **3 × per US trading day**:

- 9:35 ET (5 minutes after the bell — past opening-cross volatility)
- 12:45 ET (mid-day)
- 16:05 ET (just after the close)

Between scheduled refreshes the same snapshot is served to every caller, so `/api/stocks/sp500` is effectively free. The server does the fan-out (concurrent fetches with a 20-way limit), per-symbol cache bypass on a scheduled refresh so prices are actually fresh, and a boot pre-warm so the first user request doesn't pay the cold-fetch cost. Weekends are skipped.

## "Last refreshed" badge

Every zone with refreshable data shows a centered `Last refreshed: HH:MM` line at the bottom of the screen, reflecting that zone's most recent successful fetch. Live zones (clock, world clocks, sun arc, motivational quotes, slides) hide the badge.

## Migrating from the standalone `signage.fixed.html`

If you have the old single-file version with localStorage settings:

1. Open `signage.fixed.html` in your browser
2. DevTools → Application → Local Storage → `signage-tv-v1`
3. Copy the JSON value
4. POST to the server:

```bash
curl -b 'sid=<your session cookie>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Warehouse TV", "legacy": <paste JSON here>}' \
  http://localhost:3000/api/migrate/legacy
```

A new screen appears in the admin Screens list with the old settings preserved.

## API routes (for the curious)

| Route | Auth | Purpose |
|---|---|---|
| `GET  /login` | none | Login / first-run setup page |
| `GET  /admin` | session | Admin SPA |
| `GET  /s/:slug` | none (slug acts as access token) | Public signage page |
| `WS   /ws/:slug` | none | Live updates for that screen |
| `GET / POST /api/auth/...` | mixed | setup-status, setup, login, logout, me |
| `GET  /api/screens` | session | List screens |
| `POST /api/screens` | session | Create |
| `GET  /api/screens/:slug` | session | Fetch full config |
| `PUT  /api/screens/:slug` | session | Update name + config (broadcasts CONFIG_UPDATE) |
| `POST /api/screens/:slug/rename` | session | Change slug (broadcasts SLUG_CHANGED) |
| `DELETE /api/screens/:slug` | session | Delete |
| `POST /api/screens/:slug/event` | session | Fire-and-forget WS event (e.g. SHOW_CAMERA, SHOW_ZONE) |
| `GET  /api/screens/public/:slug` | none | What signage page calls on boot |
| `GET / PUT /api/settings` | session | Global server settings |
| `POST /api/settings/test/unifi-access`, `/unifi-protect` | session | Test UniFi credentials before saving |
| `GET  /api/calendar/public/:slug` | none | iCal events (recurrences expanded) |
| `GET  /api/calendar/rooms/public/:slug` | none | Per-room status (recurrences expanded) |
| `GET / PUT /api/slack` | session | Slack credentials |
| `GET / PUT /api/hik` | session | Hikvision config |
| `POST /api/hik/test` | session | Validate Hikvision creds |
| `POST /api/hik/trigger` | session | Manually fire a test trigger |
| `GET  /api/hik/snapshot` | none (server holds creds) | JPEG snapshot proxy for the signage page |
| `GET  /api/stocks/quotes`, `/sp500` | none | Yahoo Finance proxy |
| `POST /api/uploads`, `GET /api/uploads`, `DELETE /api/uploads/:id` | session | File library |
| `GET  /api/uploads/:id/view` | none | Public asset URL |
| `POST /api/messages/:slug` | session | Broadcast a message (`*` = all screens) |
| `GET  /api/messages/public/:slug` | none | Recent messages |
| `GET / POST /api/templates` | session | Save / list / apply screen templates |

## Dev mode (without Docker)

```bash
cd server
npm install
npm run dev
# server now at http://localhost:3000
```

`npm run dev` uses Node's `--watch` so it restarts on file changes. No env vars are required to start; sessions and data go into `./data/` (created on first run). Optionally export `COOKIE_SECURE=1` if you're running behind an HTTPS terminator in dev.

## Design notes

- **Single Node process** serves admin, signage, REST, WebSocket, and static files. Fewer moving parts, easier to deploy.
- **WebSocket per screen** — admin watches the same WS channel as the TV when you're editing, so multiple admins see each other's changes too.
- **Slug as access token** — anyone with the slug can view a screen. Pick non-obvious slugs for sensitive screens (e.g. `lobby-x7k3`).
- **SQLite** — single-file database. Suits one server with a handful of TVs perfectly. Migrate to PostgreSQL later if you spread across multiple servers.
- **Session cookies** — opaque random tokens, server-side store, 30-day TTL by default. No shared secret. Revoking is just a row delete in the `sessions` table.
- **Defence in depth on credentials** — UniFi and Hikvision passwords stay server-side; the signage browser only ever sees a server-proxied JPEG. The Slack bot token lives in the global settings table and is masked on read.
- **Auto-skipping zones** — the rotation knows which zones have content right now (e.g. no Slack messages in the last 30 minutes, no upcoming sports games) and skips past empty ones automatically.
