# Pittwater Signage Server

Multi-screen digital signage. One server, many TVs, one admin panel.

```
admin  →  server  →  TV 1  ("Lobby")
         (Node +    TV 2  ("Reception")
          SQLite)   TV 3  ("Meeting Room 1")
                    …
```

Each TV has its own URL (`/s/<slug>`), its own config (zones, fonts, colors, logos, locations), and its own live WebSocket for instant updates. Admin pushes a change → server saves it to SQLite → all TVs viewing that screen update in <1 second.

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

- `data/signage.db` — SQLite database (screens, users, sessions, messages, upload metadata)
- `data/uploads/` — uploaded logo and image files

Mounted as a volume in `docker-compose.yml`. To back up:

```bash
# Stop briefly to ensure consistent SQLite state
docker compose stop signage
tar czf signage-backup-$(date +%F).tar.gz data/
docker compose start signage
```

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Listen port inside the container |
| `SESSION_SECRET` | (placeholder) | **Change this**. Long random string used for session integrity |
| `TRUST_PROXY` | `0` | Set to `1` if you put nginx/Traefik in front |
| `DATA_DIR` | `/app/data` | Where the DB + uploads live (don't change unless you also change the volume mount) |

## Adding a new screen

1. Open admin → **+ New Screen**
2. Enter a name like "Lobby" — server picks a slug automatically (you can override it)
3. Click into the screen → adjust zones, font, colors, integrations, etc.
4. On the TV browser, open `http://<server>:3000/s/<slug>`
5. Any changes you save in admin appear on the TV in <1 second over WebSocket

## Pointing a TV at a screen

Most modern TVs and small kiosk PCs work well as signage clients:

- **Chromebox / NUC / Raspberry Pi 4 with Chromium** — best option. Boot into a kiosk-mode browser pointing at the URL.
- **Smart TV with built-in browser** — works if it's a recent enough model. Older Tizen/WebOS may not support BroadcastChannel… (we don't use that anymore — WebSocket works on anything from ~2018+).
- **Fire TV / Apple TV with browser sideload** — works but more fiddly.

Kiosk mode example for Chromium on Linux:

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  http://your-server:3000/s/lobby
```

## File uploads (logos, images)

The **Assets** sidebar item lets you upload PNG, JPG, SVG, GIF, or WebP up to 8 MB. They're stored on disk under `data/uploads/` and served at stable URLs like `/files/<id>.png`.

In any image-using setting (logo, …) click **Choose from Assets** to pick from your library, or **Upload** to upload a new one inline.

## Fonts

Each screen has its own font from a curated list (Inter, Roboto, Open Sans, Source Sans 3, Manrope, IBM Plex Sans, JetBrains Mono, Bebas Neue, Oswald, Montserrat, Lato, Poppins). Loaded from Google Fonts CDN — works on any internet-connected TV. To go fully offline, drop self-hosted woff2 files under `public/fonts/woff2/` and edit `public/fonts/fonts.js` to point at the local paths.

## Slack integration (Slack → TVs)

Mirror messages from a Slack channel onto every TV. Useful for company-wide announcements, urgent alerts, or just letting the warehouse team broadcast something from their phone.

The integration uses **Socket Mode**, which means the server connects out to Slack. **No inbound port required** — works behind any firewall or NAT.

### One-time Slack app setup (~5 minutes)

1. Go to **api.slack.com/apps** and click **Create New App** → **From scratch**. Name it "Signage" (or whatever) and pick your workspace.

2. **Enable Socket Mode**:
   - Left sidebar → **Socket Mode** → toggle on
   - It'll prompt you to generate an **App-Level Token** with the `connections:write` scope
   - Name it (e.g. "signage-socket") and copy the token. Starts with `xapp-…`.

3. **Add bot scopes**:
   - Left sidebar → **OAuth & Permissions**
   - Under "Bot Token Scopes" add ALL of these:
     - `channels:read` — get public channel info
     - `channels:history` — read messages in public channels the bot is in
     - `groups:read` — get private channel info
     - `groups:history` — read messages in private channels
     - `users:read` — resolve user IDs to display names
     - `chat:write` — required for some Slack ack flows
   - Adding both `channels:` and `groups:` scopes lets the integration work with either public or private channels — pick whichever fits your use case.

4. **Subscribe to events**:
   - Left sidebar → **Event Subscriptions** → toggle on
   - Under "Subscribe to bot events" add: `message.channels` (for public channels) and/or `message.groups` (for private channels)
   - Save changes

5. **Install the app to your workspace**:
   - Top of the OAuth & Permissions page → **Install to Workspace** → approve
   - Copy the **Bot User OAuth Token** (starts with `xoxb-…`)
   - **If you change scopes later**, Slack will show a yellow "Reinstall app" banner — you must reinstall for new scopes to take effect.

6. **Invite the bot to the channel** you want to mirror:
   ```
   /invite @YourSignageApp
   ```

7. **Get the channel ID**:
   - In Slack, right-click the channel name → **View channel details**
   - Scroll to the bottom — the channel ID looks like `C0123456789`

### Configure in admin

8. Open admin → sidebar → **Slack** (under Integrations)
9. Paste the three values:
   - **Bot Token** — the `xoxb-…` from step 5
   - **App Token** — the `xapp-…` from step 2
   - **Channel ID** — from step 7
10. Click **Test Connection** to confirm — it'll show your workspace name and the channel name
11. Click **Save & Connect**

The Slack page shows live status. Within a second of saving you should see "● Connected" and the bot user ID. Test it: post a message in that Slack channel and watch every TV pop the message overlay within a second.

Behaviour notes:
- Only top-level posts in the configured channel are mirrored. Thread replies, edits, joins/leaves, and bot messages are filtered out.
- The Slack user's display name appears as the sender on the TV.
- Slack-flavored markup (mentions, channel links, URL formatting) is converted to plain text.
- Messages auto-expire after 30 minutes (same as messages sent from the admin panel).

## Migrating from the standalone signage.fixed.html

If you have the old single-file version with localStorage settings you don't want to lose:

1. Open `signage.fixed.html` in your browser
2. Open DevTools → Application → Local Storage → `signage-tv-v1`
3. Copy the JSON value
4. Send it to the server:

```bash
curl -b 'sid=<your session cookie>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Warehouse TV", "legacy": <paste JSON here>}' \
  http://localhost:3000/api/migrate/legacy
```

A new screen "Warehouse TV" appears in the admin Screens list, with all your old settings preserved.

## Routes (for the curious)

- `GET  /login` — login / first-run setup page
- `GET  /admin` — admin SPA (auth required)
- `GET  /s/:slug` — public signage page (slug acts as access token)
- `GET  /api/auth/setup-status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET  /api/screens` (auth) — list
- `POST /api/screens` (auth) — create
- `GET  /api/screens/:slug` (auth) — fetch full
- `PUT  /api/screens/:slug` (auth) — update name + config (broadcasts CONFIG_UPDATE over WS)
- `DELETE /api/screens/:slug` (auth) — delete
- `POST /api/screens/:slug/event` (auth) — fire-and-forget event (e.g. SHOW_CAMERA, SHOW_ZONE)
- `GET  /api/screens/public/:slug` (no auth) — what the signage page calls on boot
- `POST /api/uploads` (auth, multipart) — upload one file
- `GET  /api/uploads` (auth), `DELETE /api/uploads/:id` (auth)
- `POST /api/messages/:slug` (auth) — send to one screen, or `*` for all
- `GET  /api/messages/public/:slug` (no auth) — recent messages for that screen
- `WS   /ws/:slug` — live updates for the screen

## Dev mode (without Docker)

```bash
cd server
npm install
SESSION_SECRET=devsecret npm run dev
# server now at http://localhost:3000
```

`npm run dev` uses Node's `--watch` so it restarts on file changes.

## Design notes

- **Single Node process** serves admin, signage, REST, WebSocket, and static files. Fewer moving parts, easier to deploy.
- **WebSocket per screen** — admin watches the same WS channel as the TV when you're editing, so you see other admins' changes too.
- **Slug as access token** — anyone with the slug can view a screen. Pick non-obvious slugs for sensitive screens (e.g. `lobby-x7k3`).
- **SQLite** — single-file database. Suits one server with a handful of TVs perfectly. Migrate to PostgreSQL later if you spread across multiple servers.
- **Session cookies** — 30-day TTL by default. Stored in DB so revoking is just a row delete.
