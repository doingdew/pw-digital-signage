// Pittwater Signage server — Express + WebSocket bootstrap.
// Single Node process serves admin, signage, REST API, and WS sync.

const path = require('path');
const http = require('http');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, UPLOADS_DIR } = require('./db');
const { requireAuth, requireAuthPage, sessionFromCookie } = require('./auth');
const wsHub = require('./ws');

const authRoutes = require('./routes/auth');
const screensRoutes = require('./routes/screens');
const uploadsRoutes = require('./routes/uploads');
const messagesRoutes = require('./routes/messages');
const migrateRoutes = require('./routes/migrate');
const calendarRoutes = require('./routes/calendar');
const slackRoutes = require('./routes/slack');
const settingsRoutes = require('./routes/settings');
const templatesRoutes = require('./routes/templates');
const unifiProxyRoutes = require('./routes/unifi');
const stocksRoutes = require('./routes/stocks');
const slack = require('./slack');
const unifi = require('./unifi');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// uncaughtException leaves the process in an undefined state — log and exit so
// Docker (`restart: unless-stopped`) brings up a clean instance. Swallowing it
// hides the root cause and lets corrupted state cause delayed crashes elsewhere.
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack || e);
  process.exit(1);
});
// Promise rejections from long-running integrations (Slack Socket Mode, UniFi
// WSS) are usually transient — log without exiting.
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e?.stack || e));

const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ── REST API ──────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/screens', screensRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/migrate', migrateRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/slack', slackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/unifi', unifiProxyRoutes);
app.use('/api/stocks', stocksRoutes);

// Diagnostic snapshot — memory + active handles + WS counts. Used to spot
// slow leaks while the process is running. Auth-gated since it leaks process
// internals.
app.get('/api/_debug/health', requireAuth, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    memoryMb: {
      rss:        Math.round(mem.rss / 1024 / 1024),
      heapTotal:  Math.round(mem.heapTotal / 1024 / 1024),
      heapUsed:   Math.round(mem.heapUsed / 1024 / 1024),
      external:   Math.round(mem.external / 1024 / 1024),
      arrayBuffers: Math.round((mem.arrayBuffers || 0) / 1024 / 1024),
    },
    activeHandles:  typeof process._getActiveHandles  === 'function' ? process._getActiveHandles().length  : null,
    activeRequests: typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : null,
    wsClients: wsHub.clientCounts(),
  });
});

// ── Static asset serving ──────────────────────────────────────────
// Uploaded files. fallthrough: true so a missing file falls through to our
// own 404 handler below — keeps the error log clean.
app.use('/files', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.get('/files/*', (req, res) => res.status(404).end());
// Bundled fonts and other public assets
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), { maxAge: '30d' }));

// ── Static assets (CSS/JS) — must be mounted BEFORE the HTML routes
//    so they take priority over the catch-all /admin/* matcher.
//    These are not sensitive (just CSS + the SPA bundle that gates itself
//    behind /api/auth/me) so we don't require auth here.
app.use('/admin/static',   express.static(path.join(PUBLIC_DIR, 'admin'),   { maxAge: '1h' }));
app.use('/signage/static', express.static(path.join(PUBLIC_DIR, 'signage'), { maxAge: '1h' }));

// ── HTML pages ────────────────────────────────────────────────────
// Login: served unauthenticated.
app.get('/login', (req, res) => {
  // If already logged in, jump to admin.
  if (sessionFromCookie(req)) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// Admin: requires auth (browser redirect on miss).
app.get(['/', '/admin', '/admin/*'], requireAuthPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

// Signage: public — slug is the access token.
app.get('/s/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'signage', 'index.html'));
});

// 404 fallthrough for everything else
app.use((req, res) => res.status(404).send('Not found'));

// Express error handler — keeps stack traces out of responses.
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Server error' });
});

// ── HTTP + WebSocket server ───────────────────────────────────────
const server = http.createServer(app);
wsHub.attach(server);

server.listen(PORT, () => {
  console.log(`▶ Pittwater Signage server listening on http://0.0.0.0:${PORT}`);
  console.log(`  data dir: ${process.env.DATA_DIR || path.join(__dirname, '..', 'data')}`);
  // Start the Slack Socket Mode connection if configured. Errors don't block boot.
  slack.start().catch((e) => console.warn('[slack] start error:', e.message));
  // UniFi Access door-lock bridge — no-op if UNIFI_TOKEN is not set.
  unifi.start();
});

// Clean shutdown.
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('Shutting down…');
  slack.stop().catch(() => {});
  server.close(() => {
    try { db.close(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
