// Server-side proxy for UniFi Protect camera APIs. Browsers can't reach the
// UniFi controller directly (self-signed cert + custom auth header), so the
// signage page fetches snapshots from this Node process which then talks to
// the controller using credentials from global Settings.

const https = require('https');
const express = require('express');
const { getSetting } = require('../db');

const router = express.Router();

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getCreds() {
  const cfg = getSetting('app') || {};
  let host = (cfg.unifiHost || '').trim().replace(/\/+$/, '');
  if (host && !/^https?:\/\//i.test(host)) host = 'https://' + host;
  // Protect-specific key first; legacy combined field as fallback.
  const key = cfg.unifiProtectApiKey || cfg.unifiApiKey || '';
  return { host, key };
}

// Pipe a request through to UniFi Protect, streaming the response back.
function proxyTo(path, contentTypeFallback, req, res) {
  const { host, key } = getCreds();
  if (!host || !key) return res.status(503).json({ error: 'UniFi not configured. Set host and API key in Settings.' });
  const u = new URL(host + path);
  const r = https.request({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    headers: { 'X-API-KEY': key, Accept: '*/*' },
    agent: insecureAgent,
    timeout: 8000,
  }, (upstream) => {
    res.status(upstream.statusCode || 502);
    const ct = upstream.headers['content-type'] || contentTypeFallback;
    if (ct) res.setHeader('Content-Type', ct);
    // Snapshots change frequently — never cache.
    res.setHeader('Cache-Control', 'no-store');
    upstream.pipe(res);
  });
  r.on('error', (e) => {
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else res.end();
  });
  r.on('timeout', () => { r.destroy(new Error('upstream timeout')); });
  r.end();
}

// Camera list — used by admin to pick which cameras a screen displays.
router.get('/cameras', (req, res) => {
  proxyTo('/proxy/protect/integration/v1/cameras', 'application/json', req, res);
});

// Snapshot for a single camera.
router.get('/cameras/:id/snapshot', (req, res) => {
  const id = encodeURIComponent(req.params.id);
  proxyTo(`/proxy/protect/integration/v1/cameras/${id}/snapshot`, 'image/jpeg', req, res);
});

module.exports = router;
