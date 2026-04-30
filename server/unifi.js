// Bridges UniFi Access controller events into the signage WS hub.
// One outbound WSS connection per server process; reconnects with backoff.
//
// Configuration sources (in priority order):
//   1. Global Settings record (admin → Settings → "UniFi Access API Key")
//   2. Env vars: UNIFI_HOST, UNIFI_TOKEN
//
// The Settings page calls restart() on save so updated credentials take
// effect immediately without a server restart.
//
// Public message broadcast to signage clients:
//   { type: 'DOOR_STATUS', doors: [{ id, name, lock, position, updatedAt }] }

const https = require('https');
const WebSocket = require('ws');
const wsHub = require('./ws');
const { getSetting } = require('./db');

const PORT = process.env.UNIFI_PORT || 12445;

function loadConfig() {
  const cfg = getSetting('app') || {};
  let host = (cfg.unifiHost || process.env.UNIFI_HOST || '').trim()
    .replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host) host = '192.168.10.1';
  const token = cfg.unifiAccessApiKey || process.env.UNIFI_TOKEN || '';
  return { host, token };
}

// Self-signed cert on the controller is normal — accept it.
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// id → { id, name, lock, position, updatedAt }
const doors = new Map();
let socket = null;
let backoff = 1000;
let pingTimer = null;
let reconnectTimer = null;     // pending setTimeout(connect, ...) — must be cleared in teardown
let stopRequested = false;

function snapshot() { return [...doors.values()]; }

function fetchInitialDoors() {
  return new Promise((resolve, reject) => {
    const { host, token } = loadConfig();
    if (!token) return reject(new Error('No Access API key'));
    const req = https.request(`https://${host}:${PORT}/api/v1/developer/doors`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      agent: tlsAgent,
      // Without this, a stalled controller hangs the request indefinitely and
      // pins a TCP socket — and reconnect attempts pile new ones on top.
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const json = JSON.parse(body);
          doors.clear();
          for (const d of json.data || []) {
            doors.set(d.id, {
              id: d.id, name: d.name,
              lock: d.door_lock_relay_status,
              position: d.door_position_status,
              updatedAt: Date.now(),
            });
          }
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('UniFi doors fetch timeout')); } catch (_) {} });
    req.on('error', reject);
    req.end();
  });
}

function broadcastDoors() {
  wsHub.broadcastAll({ type: 'DOOR_STATUS', doors: snapshot() });
}

function handleEvent(evt) {
  const data = evt && evt.data;
  if (data && data.id && doors.has(data.id)) {
    const cur = doors.get(data.id);
    let changed = false;
    if (data.door_lock_relay_status && data.door_lock_relay_status !== cur.lock) {
      cur.lock = data.door_lock_relay_status; changed = true;
    }
    if (data.door_position_status && data.door_position_status !== cur.position) {
      cur.position = data.door_position_status; changed = true;
    }
    if (changed) {
      cur.updatedAt = Date.now();
      doors.set(data.id, cur);
      broadcastDoors();
    }
    return;
  }
  const text = JSON.stringify(evt);
  for (const id of doors.keys()) {
    if (text.includes(id)) {
      fetchInitialDoors().then(broadcastDoors).catch(() => {});
      return;
    }
  }
}

function teardown() {
  stopRequested = true;
  clearInterval(pingTimer); pingTimer = null;
  // Cancel any pending reconnect attempt — otherwise it would fire after
  // restart() and create a parallel orphan socket (with its own pingTimer).
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) {
    try { socket.removeAllListeners(); } catch (_) {}
    try { socket.terminate(); } catch (_) {}
    socket = null;
  }
}

function connect() {
  const { host, token } = loadConfig();
  if (!token) { console.warn('[unifi] No Access API key — bridge idle'); return; }
  stopRequested = false;
  // When called from reconnect(), the previous socket's 'close' fired but its
  // other listeners are still attached. Detach + terminate before reassigning
  // so a late event from the old instance can't re-trigger reconnect logic
  // and so the old socket can be GC'd promptly.
  if (socket) {
    try { socket.removeAllListeners(); } catch (_) {}
    try { socket.terminate(); } catch (_) {}
    socket = null;
  }
  socket = new WebSocket(`wss://${host}:${PORT}/api/v1/developer/devices/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
    agent: tlsAgent,
  });

  socket.on('open', () => {
    backoff = 1000;
    console.log('[unifi] WS connected');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.ping(); } catch (_) {}
      }
    }, 20000);
    fetchInitialDoors().then(broadcastDoors).catch((e) => {
      console.error('[unifi] reseed failed:', e.message);
    });
  });

  socket.on('message', (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }
    handleEvent(evt);
  });

  const reconnect = () => {
    if (stopRequested) return;
    clearInterval(pingTimer);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const delay = Math.min(backoff, 30000);
    backoff *= 2;
    console.log(`[unifi] WS down, reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };
  socket.on('close', reconnect);
  socket.on('error', (e) => { console.error('[unifi] WS error:', e.message); });
}

function start() {
  const { token } = loadConfig();
  if (!token) {
    console.warn('[unifi] No UniFi Access API key set (Settings → UniFi or UNIFI_TOKEN env) — door integration disabled');
    return;
  }
  fetchInitialDoors()
    .then(() => { broadcastDoors(); connect(); })
    .catch((e) => {
      console.error('[unifi] initial fetch failed:', e.message);
      setTimeout(start, 5000);
    });
}

// Called from Settings PUT when host/Access key change.
function restart() {
  console.log('[unifi] restart requested (Settings change)');
  teardown();
  // Tiny delay so the close handlers don't try to schedule a reconnect.
  setTimeout(start, 200);
}

module.exports = { start, restart, snapshot };
