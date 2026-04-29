// Global, server-wide app settings — shared across all screens.
// Keys exposed here used to live in each screen's per-screen config; they are
// now stored once and merged into screen-config responses on read so existing
// signage client code continues to work unchanged.

const https = require('https');
const express = require('express');
const { getSetting, setSetting, db } = require('../db');
const { requireAuth } = require('../auth');
const wsHub = require('../ws');

// Self-signed certs are normal on UniFi controllers — accept them.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const router = express.Router();

const KEY = 'app';
const FIELDS = ['googleMapsApiKey', 'unifiHost', 'unifiAccessApiKey', 'unifiProtectApiKey', 'unifiProxyUrl'];

function loadAll() {
  const cur = getSetting(KEY) || {};
  const out = {};
  for (const f of FIELDS) out[f] = cur[f] || '';
  // Backward-compat: legacy single 'unifiApiKey' field. If present and no
  // new-style key is set, treat it as the Protect key (most users set it
  // for cameras originally) — Access has its own bridge and was separately
  // configured via the UNIFI_TOKEN env var.
  if (cur.unifiApiKey) {
    if (!out.unifiProtectApiKey) out.unifiProtectApiKey = cur.unifiApiKey;
  }
  // Also expose the legacy combined field so older clients keep working.
  out.unifiApiKey = out.unifiProtectApiKey || cur.unifiApiKey || '';
  return out;
}

router.get('/', requireAuth, (req, res) => {
  res.json({ settings: loadAll() });
});

router.put('/', requireAuth, (req, res) => {
  const cur = getSetting(KEY) || {};
  const patch = req.body || {};
  const next = { ...cur };
  for (const f of FIELDS) {
    if (typeof patch[f] === 'string') next[f] = patch[f].trim();
  }
  // Detect changes that require restarting the UniFi Access door bridge.
  const accessChanged =
    (cur.unifiAccessApiKey || '') !== (next.unifiAccessApiKey || '') ||
    (cur.unifiHost || '') !== (next.unifiHost || '');
  setSetting(KEY, next);

  // Push a CONFIG_UPDATE to every connected signage screen so they pick
  // up the new credentials live (no reload required).
  const allScreens = db.prepare('SELECT slug, config_json FROM screens').all();
  for (const s of allScreens) {
    const merged = { ...JSON.parse(s.config_json), ...next };
    wsHub.broadcast(s.slug, { type: 'CONFIG_UPDATE', config: merged });
  }

  // Reconnect the Access door bridge with the new credentials.
  if (accessChanged) {
    try { require('../unifi').restart(); } catch (e) { console.warn('[settings] unifi restart failed:', e.message); }
  }
  res.json({ settings: loadAll() });
});

// ── Test connection endpoints ────────────────────────────────────
// Each accepts an optional override body so the user can test credentials
// before saving them. Falls back to currently-stored globals.

function fetchAsBuffer(url, headers, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const req = lib.request({
      method: 'GET',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: headers || {},
      agent: isHttps ? insecureAgent : undefined,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.end();
  });
}

function normalizeHost(h) {
  if (!h) return '';
  let v = h.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

router.post('/test/unifi-access', requireAuth, async (req, res) => {
  const cur = { ...loadAll(), ...(req.body || {}) };
  const host = normalizeHost(cur.unifiHost);
  const token = cur.unifiAccessApiKey;
  if (!host || !token) return res.status(400).json({ ok: false, error: 'Host and Access API key required' });
  try {
    const r = await fetchAsBuffer(`${host}:12445/api/v1/developer/doors`, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    if (r.status === 401 || r.status === 403) return res.json({ ok: false, error: `Auth failed (HTTP ${r.status}). Make sure this is a UniFi ACCESS API token, not Protect.` });
    if (r.status !== 200) return res.json({ ok: false, error: `HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 300)}` });
    let json; try { json = JSON.parse(r.body.toString('utf8')); } catch { return res.json({ ok: false, error: 'Non-JSON response' }); }
    const doors = (json.data || []).map(d => d.name);
    res.json({ ok: true, detail: `${doors.length} door${doors.length === 1 ? '' : 's'} found: ${doors.join(', ') || '(none)'}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/test/unifi-protect', requireAuth, async (req, res) => {
  const cur = { ...loadAll(), ...(req.body || {}) };
  const host = normalizeHost(cur.unifiHost);
  const token = cur.unifiProtectApiKey;
  if (!host || !token) return res.status(400).json({ ok: false, error: 'Host and Protect API key required' });
  try {
    const r = await fetchAsBuffer(`${host}/proxy/protect/integration/v1/cameras`, { 'X-API-KEY': token, Accept: 'application/json' });
    if (r.status === 401 || r.status === 403) return res.json({ ok: false, error: `Auth failed (HTTP ${r.status}). Make sure this is a UniFi PROTECT API token (issued via OS Settings → Control Plane → Integrations).` });
    if (r.status !== 200) return res.json({ ok: false, error: `HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 300)}` });
    let json; try { json = JSON.parse(r.body.toString('utf8')); } catch { return res.json({ ok: false, error: 'Non-JSON response' }); }
    const cams = Array.isArray(json) ? json : (json.cameras || json.data || []);
    res.json({ ok: true, detail: `${cams.length} camera${cams.length === 1 ? '' : 's'} found` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/test/maps', requireAuth, async (req, res) => {
  const cur = { ...loadAll(), ...(req.body || {}) };
  const key = cur.googleMapsApiKey;
  if (!key) return res.status(400).json({ ok: false, error: 'Maps API key required' });
  try {
    // Use Geocoding API — it's enabled by default with most keys and returns
    // a clear status string we can interpret.
    const r = await fetchAsBuffer(`https://maps.googleapis.com/maps/api/geocode/json?address=Sydney&key=${encodeURIComponent(key)}`);
    if (r.status !== 200) return res.json({ ok: false, error: `HTTP ${r.status}` });
    let json; try { json = JSON.parse(r.body.toString('utf8')); } catch { return res.json({ ok: false, error: 'Non-JSON response' }); }
    if (json.status === 'OK')              return res.json({ ok: true, detail: 'Key valid (Geocoding API)' });
    if (json.status === 'REQUEST_DENIED')  return res.json({ ok: false, error: json.error_message || 'Key denied. Enable Geocoding + Maps JS API in Google Cloud Console.' });
    if (json.status === 'OVER_QUERY_LIMIT')return res.json({ ok: false, error: 'Quota exceeded. Check billing in Google Cloud Console.' });
    return res.json({ ok: false, error: `Unexpected status: ${json.status}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.loadGlobalSettings = loadAll;
