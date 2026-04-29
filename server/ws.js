// Per-screen WebSocket hub. Each screen has its own room keyed by slug.
// Clients connect to /ws/:slug and receive JSON messages from the server.
// Admin pushes broadcasts via wsHub.broadcast(slug, msg).
//
// Message shapes (server → client):
//   { type: 'CONFIG_UPDATE', config }
//   { type: 'EVENT', event: { type, payload } }   // one-off triggers
//   { type: 'SCREEN_DELETED' }
//   { type: 'PING' }                              // keepalive

const url = require('url');
const { WebSocketServer } = require('ws');
const { db } = require('./db');

const stmtBySlug = db.prepare('SELECT slug FROM screens WHERE slug = ?');

// rooms: Map<slug, Set<WebSocket>>
const rooms = new Map();
// Latest status reported by each slug's TVs:
//   Map<slug, { lastSeen, currentZone, viewport, errors, ua }>
const statuses = new Map();
let wss = null;

function attach(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    // Expect /ws/:slug
    const m = /^\/ws\/([a-z0-9-]+)\/?$/.exec(pathname || '');
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const slug = m[1];
    const screen = stmtBySlug.get(slug);
    if (!screen) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.slug = slug;
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m && m.type === 'STATUS') {
            statuses.set(slug, {
              lastSeen: Date.now(),
              currentZone: m.currentZone || null,
              viewport: m.viewport || null,
              errors: m.errors || 0,
              ua: m.ua || null,
            });
          }
        } catch (_) {}
      });
      addToRoom(slug, ws);
      ws.on('close', () => removeFromRoom(slug, ws));
      ws.on('error', () => removeFromRoom(slug, ws));
      // Initial hello so the client knows it's connected.
      send(ws, { type: 'CONNECTED' });
      // Seed door status snapshot so a fresh client doesn't have to wait
      // for the next change. unifi module may not be loaded yet.
      try {
        const unifi = require('./unifi');
        send(ws, { type: 'DOOR_STATUS', doors: unifi.snapshot() });
      } catch (_) {}
    });
  });

  // Heartbeat — terminate dead connections every 30s.
  const heartbeat = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, 30000);

  server.on('close', () => {
    clearInterval(heartbeat);
    if (wss) wss.close();
  });
}

function addToRoom(slug, ws) {
  if (!rooms.has(slug)) rooms.set(slug, new Set());
  rooms.get(slug).add(ws);
}

function removeFromRoom(slug, ws) {
  const room = rooms.get(slug);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(slug);
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(slug, obj) {
  const room = rooms.get(slug);
  if (!room) return 0;
  let n = 0;
  for (const ws of room) {
    if (ws.readyState === ws.OPEN) {
      send(ws, obj);
      n++;
    }
  }
  return n;
}

// Broadcast to every connected client across all rooms. Used for global
// state updates (e.g. door lock status) that aren't tied to a single screen.
function broadcastAll(obj) {
  let n = 0;
  for (const room of rooms.values()) {
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) { send(ws, obj); n++; }
    }
  }
  return n;
}

function clientCounts() {
  const out = {};
  for (const [slug, room] of rooms.entries()) out[slug] = room.size;
  return out;
}

function getStatus(slug) {
  return statuses.get(slug) || null;
}

function allStatuses() {
  const out = {};
  for (const [slug, st] of statuses.entries()) out[slug] = st;
  return out;
}

module.exports = { attach, broadcast, broadcastAll, clientCounts, getStatus, allStatuses };
