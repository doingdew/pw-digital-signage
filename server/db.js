// SQLite layer using better-sqlite3 (synchronous, fast, well-suited for a single
// server with a handful of TVs). Schema is auto-migrated on startup.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'signage.db');

// Make sure the data + uploads directories exist before we open the DB.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── schema ────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS screens (
     id INTEGER PRIMARY KEY,
     slug TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY,
     screen_id INTEGER REFERENCES screens(id) ON DELETE CASCADE,
     sender TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL,
     priority TEXT NOT NULL DEFAULT 'normal',
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_screen_created
     ON messages(screen_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS uploads (
     id TEXT PRIMARY KEY,
     filename TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     path TEXT NOT NULL,
     uploaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
  // Server-wide settings (Slack config etc.) — single row keyed by name.
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
  // Reusable display configurations users can create new screens from.
  `CREATE TABLE IF NOT EXISTS templates (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
   )`,
];

for (const stmt of SCHEMA) db.exec(stmt);

// Quick health probe at boot — fail fast if the DB is unwritable.
db.exec(`INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (-1, '__probe__', '')`);
db.exec(`DELETE FROM users WHERE id = -1`);

// ── default screen config ─────────────────────────────────────────
// Mirrors the structure that signage uses today, with defaults that
// match a freshly-pulled signage.fixed.html.
function defaultScreenConfig() {
  return {
    // visual
    fontFamily: 'Inter',
    bgColor: '#0a0e1a',
    accentColor: '#00aaff',
    logoUploadId: '',   // preferred — references uploads.id
    logoUrl: '',        // alternative — explicit URL

    // zone rotation
    // Order grouped by purpose:
    //   Time / location:     clock, worldclocks, sunarc
    //   Operational content: shipments, kpi, bignum, safety, calendar, slack
    //   Inspiration:         motivation
    //   Live data:           weather, sports, trends
    //   Surveillance / maps: doors, radar, traffic
    zoneIds: [
      'zone-clock','zone-worldclocks','zone-sunarc',
      'zone-shipments','zone-kpi','zone-bignum','zone-safety','zone-calendar','zone-meetings','zone-slack',
      'zone-motivation',
      'zone-weather','zone-sports-results','zone-sports-upcoming','zone-trends',
      'zone-stocks-overview','zone-stocks-bigboard',
      'zone-doors','zone-radar','zone-traffic',
      'zone-slides',
    ],
    rotationMs: 15000,
    // Per-zone dwell time overrides (ms). Zone IDs not in this map use rotationMs.
    zoneDwell: {},

    // clock
    clockStyle: 'digital',  // 'digital' | 'minimal' | 'analog'
    timezone: '',           // empty = browser local
    showWorldClocksOnClock: false,  // also show small world clock row under main clock

    // weather
    weatherLocation: 'Sydney',
    weatherUnits: 'imperial',
    showForecast: true,

    // shipments
    googleSheetUrl: '',

    // Google Slides — embed a published presentation as a zone.
    // Accepts share/edit/embed URLs; the client extracts the presentation ID.
    slidesUrl: '',
    slidesSeconds: 5,

    // Meeting rooms — one tile per room, status driven by each room's iCal.
    // 6 empty slots by default; admin Tab will let you fill them in.
    meetingRooms: Array.from({ length: 6 }, () => ({ name: '', url: '' })),
    meetingRoomsSoonMins: 30,

    // Calendar listing
    calendarDaysAhead: 14,
    calendarMaxEvents: 8,

    // Sports — which leagues to fetch and whether to show betting odds
    sportsLeagues: ['nfl','nba','mlb','nhl','mls'],
    sportsShowOdds: false,
    // Layout for sports tiles. 'auto' = pick column count based on tile count
    // and let CSS grid stretch them to fill the zone height. 'compact' /
    // 'standard' / 'large' / 'hero' force a fixed tile size.
    sportsLayout: 'auto',

    // Camera grid — list of { id, name, shape, enabled }. shape is one of
    // 'wide' (2x1, default landscape), 'tall' (1x2, doorbell-style portrait),
    // 'square' (1x1). Empty list means "auto-discover from UniFi Protect" on
    // first signage load — admin can then reorder + tweak.
    cameraList: [],

    // Persistent message footer — how many minutes a broadcast message stays
    // pinned at the bottom of every page after the 15s overlay finishes.
    messageFooterMinutes: 15,

    // Today's Number sizing — small / medium / large / xl. Default sizing
    // matches what was hard-coded before; users can scale up or down.
    bigNumSize: 'large',
    // Weather sizing — small / medium / large / xl. Scales the temperature,
    // icon, descriptions, hi/lo row, and detail tiles together.
    weatherSize: 'medium',
    // Clock sizing — applies to whichever clock style is active (digital,
    // minimal, analog).
    clockSize: 'medium',
    // World clock card sizing — small / medium / large.
    worldClockSize: 'medium',
    // Top header bar size — small / medium / large / xl.
    headerSize: 'medium',
    // Sun arc page size — scales the arc, meta row, and 3-day forecast cards.
    sunArcSize: 'medium',

    // KPI
    kpiItems: [],

    // safety
    safetyMessages: defaultSafetyMessages(),

    // camera + UniFi
    cameraUrl: '',
    unifiHost: '',
    unifiApiKey: '',
    unifiProxyUrl: 'http://localhost:8081',
    unifiDoors: [],

    // trends
    trendsCountry: 'US',

    // Stocks — markets overview row + selectable big-board grid
    // Yahoo Finance symbols. Indices use ^ prefix; crypto is BTC-USD style;
    // forex via ticker like DX-Y.NYB (US dollar index).
    stockIndices: ['^DJI', '^IXIC', '^GSPC', 'DX-Y.NYB', 'BTC-USD'],
    stockOverviewSymbols: [],
    stockBigBoardSymbols: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'BRK-B'],
    stockBigBoardMode: 'percent',  // 'percent' | 'dollar'

    // radar
    radarLat: 41.4789,
    radarLon: -73.4062,
    radarLabel: 'Brookfield, CT',
    radarStation: 'auto',

    // traffic
    trafficLat: 41.4789,
    trafficLon: -73.4062,
    trafficZoom: 11,
    trafficLabel: 'Brookfield, CT',

    // shared
    googleMapsApiKey: '',

    // World Clocks zone — defaults plotted on the world map
    worldClocks: [
      { label: 'New York', tz: 'America/New_York',  lat: 40.7128, lon: -74.0060,  style: 'digital' },
      { label: 'London',   tz: 'Europe/London',     lat: 51.5074, lon: -0.1278,   style: 'digital' },
      { label: 'Tokyo',    tz: 'Asia/Tokyo',        lat: 35.6762, lon: 139.6503,  style: 'digital' },
      { label: 'Sydney',   tz: 'Australia/Sydney',  lat: -33.8688, lon: 151.2093, style: 'digital' },
    ],

    // Sun Arc zone — defaults to traffic location when its own coords are blank
    sunArcLat: null,
    sunArcLon: null,
    sunArcLabel: '',

    // Calendar zone — list of public iCal URLs
    calendars: [],   // [{ name, url, color }]

    // Today's Number zone
    bigNumMode:     'countup',           // 'countup' | 'static'
    bigNumLabel:    'Days since last incident',
    bigNumValue:    '0',                 // used when bigNumMode === 'static'
    bigNumUnit:     'days',
    bigNumSubline:  '',
    bigNumStartDate: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD; used in countup mode

    // Idle / overnight mode
    quietEnabled:  false,
    quietStart:    '20:00',     // 24h HH:MM, screen-local
    quietEnd:      '06:00',
    quietMode:     'minimal',   // 'black' | 'minimal' | 'message'
    quietMessage:  '',
  };
}

function defaultSafetyMessages() {
  return [
    'Always wear PPE in the loading dock and warehouse floor.',
    'Steel-toed boots are required everywhere beyond the office.',
    'High-visibility vests must be worn in forklift zones.',
    'Safety glasses required when using power tools or strapping machines.',
    'Wear cut-resistant gloves when opening banded pallets.',
    'Forklift zone — pedestrians keep clear and make eye contact with operators.',
    'Never walk behind a moving forklift — stay in the painted walkways.',
    'Pedestrians have right of way, but never assume the operator saw you.',
    'Sound the horn at every blind corner and doorway.',
    'Speed limit in warehouse: 5 mph / 8 km/h.',
    'Do not ride on the forks or frame of any forklift — ever.',
    'Lower forks fully before leaving the forklift unattended.',
    'Lift with your legs, not your back — keep the load close to your body.',
    'Break loads over 50 lb into smaller portions or grab a helper.',
    'Use a pallet jack or cart for anything you cannot lift comfortably.',
    'Stretch before your shift — tight muscles cause injuries.',
    'Keep emergency exits and fire lanes clear at all times.',
    'Clean up spills immediately — report anything you cannot handle.',
    'Do not stack pallets or product above the red painted line.',
    'Return tools and pallet jacks to their home location after use.',
    'Check load security (shrink wrap, banding) before moving pallets.',
    'Never climb the racking — use an approved ladder or order picker.',
    'Inspect the forklift before each shift: horn, brakes, leaks, tires.',
    'Damaged pallets go to the repair pile — do not put them back in the rack.',
    'Do not daisy-chain power strips or run extension cords across walkways.',
    'Keep the area within 3 ft of every electrical panel clear.',
    'Know where the nearest fire extinguisher and pull station are.',
    'If you smell smoke or see fire, pull the nearest alarm immediately.',
    'Do not block sprinkler heads — 18-inch clearance is required.',
    'Read the SDS before handling any new chemical.',
    'Store flammables in the yellow cabinet — not on the shelves.',
    'Report unlabelled drums or containers to your supervisor today.',
    'Eyewash station location: check the nearest wall map.',
    'Report near-misses — they prevent the next accident.',
    'If in doubt, stop and ask your supervisor.',
    'No phones in the forklift seat or on the dock plate.',
    'Hydrate — especially in summer on the dock.',
    'Take your scheduled breaks. Fatigue causes most injuries.',
    'Close dock doors and set the dock lock before loading a trailer.',
    'Never walk under a raised load.',
    'Secure long items (pipes, lumber) so they cannot shift or fall.',
    'When in doubt about a load’s weight, look at the label or ask.',
  ];
}

// Server-wide settings helpers.
const _getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function getSetting(key, fallback = null) {
  const row = _getSetting.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (_) { return row.value; }
}
function setSetting(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  _setSetting.run(key, v, Date.now());
}

// One-time: replace legacy zone-sports in each saved screen's zoneIds with
// the two new split zones (zone-sports-results + zone-sports-upcoming). The
// default config already has them, but existing screens persist their custom
// rotation order, so they need an explicit upgrade.
(function migrateSplitSportsZones() {
  try {
    const updateStmt = db.prepare('UPDATE screens SET config_json = ?, updated_at = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, config_json FROM screens').all();
    let touched = 0;
    for (const r of rows) {
      let cfg; try { cfg = JSON.parse(r.config_json); } catch { continue; }
      const ids = cfg.zoneIds;
      if (!Array.isArray(ids)) continue;
      const idx = ids.indexOf('zone-sports');
      if (idx < 0) continue;
      const hasResults  = ids.includes('zone-sports-results');
      const hasUpcoming = ids.includes('zone-sports-upcoming');
      const replacement = [];
      if (!hasResults)  replacement.push('zone-sports-results');
      if (!hasUpcoming) replacement.push('zone-sports-upcoming');
      cfg.zoneIds = [...ids.slice(0, idx), ...replacement, ...ids.slice(idx + 1)];
      updateStmt.run(JSON.stringify(cfg), Date.now(), r.id);
      touched++;
    }
    if (touched) console.log(`[migrate] split sports zones in ${touched} screen(s)`);
  } catch (e) {
    console.warn('[migrate] split sports zones skipped:', e.message);
  }
})();

// One-time: promote per-screen googleMapsApiKey/unifi* values into the global
// `app` settings record. Runs at boot. Picks the first non-empty value across
// all screens for each field. No-op if a global value is already set.
(function migratePerScreenToGlobal() {
  const PROMOTE = ['googleMapsApiKey', 'unifiHost', 'unifiApiKey', 'unifiProxyUrl'];
  try {
    const cur = getSetting('app') || {};
    const next = { ...cur };
    let touched = false;
    const rows = db.prepare('SELECT config_json FROM screens').all();
    for (const r of rows) {
      let cfg; try { cfg = JSON.parse(r.config_json); } catch { continue; }
      for (const k of PROMOTE) {
        if (!next[k] && cfg[k]) { next[k] = cfg[k]; touched = true; }
      }
    }
    if (touched) {
      setSetting('app', next);
      console.log('[migrate] promoted per-screen settings to global:', Object.keys(next).filter(k => next[k]));
    }
  } catch (e) {
    console.warn('[migrate] per-screen → global skipped:', e.message);
  }
})();

module.exports = {
  db,
  DATA_DIR,
  UPLOADS_DIR,
  DB_PATH,
  defaultScreenConfig,
  getSetting,
  setSetting,
};
