// Migration helper — converts the legacy `signage-tv-v1` localStorage shape
// (from the standalone signage.fixed.html) into a new screen on this server.

const express = require('express');
const { db, defaultScreenConfig } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const LEGACY_KEYS = [
  'zoneIds','rotationMs','bgColor','accentColor','weatherLocation','weatherUnits',
  'timezone','showForecast','clockStyle','googleSheetUrl','cameraUrl','logoUrl',
  'kpiItems','safetyMessages','unifiHost','unifiApiKey','unifiProxyUrl',
  'googleMapsApiKey','trendsCountry',
  'radarLat','radarLon','radarLabel','radarStation',
  'trafficLat','trafficLon','trafficZoom','trafficLabel',
];

router.post('/legacy', requireAuth, (req, res) => {
  const { name, slug, legacy } = req.body || {};
  if (!name || !legacy || typeof legacy !== 'object') return res.status(400).json({ error: 'name + legacy JSON required' });

  const finalSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported';
  // Refuse if slug exists
  if (db.prepare('SELECT id FROM screens WHERE slug = ?').get(finalSlug)) {
    return res.status(409).json({ error: 'Slug already exists' });
  }
  const config = defaultScreenConfig();
  for (const k of LEGACY_KEYS) if (legacy[k] !== undefined) config[k] = legacy[k];
  // logoUrl from legacy maps to logoUrl in new (logoUploadId stays empty)
  const info = db.prepare('INSERT INTO screens (slug, name, config_json) VALUES (?, ?, ?)')
    .run(finalSlug, String(name).trim(), JSON.stringify(config));
  res.json({ ok: true, slug: finalSlug, id: info.lastInsertRowid });
});

module.exports = router;
