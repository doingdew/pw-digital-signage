// Screens CRUD — admin-only.
const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, defaultScreenConfig, UPLOADS_DIR } = require('../db');
const { requireAuth } = require('../auth');
const wsHub = require('../ws');
const { loadGlobalSettings } = require('./settings');
const { loadTemplateConfig } = require('./templates');

// Merge server-wide settings (Maps API key, UniFi creds) on top of per-screen
// config so existing client code that reads `cfg.googleMapsApiKey` etc. keeps
// working unchanged after these were promoted from per-screen to global.
function withGlobals(config) {
  return { ...config, ...loadGlobalSettings() };
}

const router = express.Router();

// Drop any logoUploadId / camera image references whose file no longer exists.
// Mutates `config` in place. Returns true if anything changed.
const lookupUpload = db.prepare('SELECT path FROM uploads WHERE id = ?');
function selfHealAssets(config) {
  let changed = false;
  if (config.logoUploadId) {
    const row = lookupUpload.get(config.logoUploadId);
    const exists = row && fs.existsSync(path.join(UPLOADS_DIR, row.path));
    if (!exists) {
      config.logoUploadId = '';
      changed = true;
    }
  }
  return changed;
}

const stmts = {
  list:    db.prepare('SELECT id, slug, name, updated_at FROM screens ORDER BY name'),
  byId:    db.prepare('SELECT * FROM screens WHERE id = ?'),
  bySlug:  db.prepare('SELECT * FROM screens WHERE slug = ?'),
  insert:  db.prepare('INSERT INTO screens (slug, name, config_json) VALUES (?, ?, ?)'),
  update:  db.prepare('UPDATE screens SET name = ?, config_json = ?, updated_at = ? WHERE id = ?'),
  delete:  db.prepare('DELETE FROM screens WHERE id = ?'),
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'screen';
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (stmts.bySlug.get(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

function rowToApi(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    config: withGlobals(JSON.parse(row.config_json)),
    updatedAt: row.updated_at,
  };
}

// ── PUBLIC: signage page reads its own config by slug, no auth required.
//    The slug acts as a shared secret — keep it non-obvious for sensitive screens.
router.get('/public/:slug', (req, res) => {
  const row = stmts.bySlug.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Screen not found' });
  const config = JSON.parse(row.config_json);
  if (selfHealAssets(config)) {
    // Persist the fix so we don't keep doing this on every poll.
    stmts.update.run(row.name, JSON.stringify(config), Date.now(), row.id);
  }
  res.json({ id: row.id, slug: row.slug, name: row.name, config: withGlobals(config), updatedAt: row.updated_at });
});

// ── ADMIN routes (mounted under /api/screens with requireAuth) ──
router.get('/', requireAuth, (req, res) => {
  const screens = stmts.list.all();
  const statuses = wsHub.allStatuses();
  const counts = wsHub.clientCounts();
  // Annotate each screen with its live status so the index page can show it.
  const enriched = screens.map(s => ({
    ...s,
    status: statuses[s.slug] || null,
    connections: counts[s.slug] || 0,
  }));
  res.json({ screens: enriched });
});

router.get('/status', requireAuth, (req, res) => {
  res.json({ statuses: wsHub.allStatuses(), connections: wsHub.clientCounts() });
});

router.get('/:slug', requireAuth, (req, res) => {
  const row = stmts.bySlug.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Screen not found' });
  res.json(rowToApi(row));
});

router.post('/', requireAuth, (req, res) => {
  const { name, slug, templateId } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const baseSlug = slugify(slug || name);
  const finalSlug = uniqueSlug(baseSlug);
  // Start from the default config, layer the template on top if one was
  // chosen. Template values overwrite defaults; per-screen-specific keys
  // (like logoUploadId) are stripped from templates so each screen still
  // starts with its own logo.
  let config = defaultScreenConfig();
  if (templateId) {
    const tplCfg = loadTemplateConfig(templateId);
    if (tplCfg) config = { ...config, ...tplCfg };
  }
  const info = stmts.insert.run(finalSlug, String(name).trim(), JSON.stringify(config));
  const row = stmts.byId.get(info.lastInsertRowid);
  res.json(rowToApi(row));
});

// Keys that have been promoted to global server-wide settings — silently strip
// them from per-screen config writes so the global value is the sole source.
const GLOBAL_KEYS = ['googleMapsApiKey', 'unifiHost', 'unifiApiKey', 'unifiProxyUrl'];

router.put('/:slug', requireAuth, (req, res) => {
  const row = stmts.bySlug.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Screen not found' });
  const { name, config } = req.body || {};
  const newName = name && String(name).trim() ? String(name).trim() : row.name;
  let configJson = row.config_json;
  if (config && typeof config === 'object') {
    const cleanPatch = { ...config };
    for (const k of GLOBAL_KEYS) delete cleanPatch[k];
    // Merge into existing config so partial updates work.
    const merged = { ...JSON.parse(row.config_json), ...cleanPatch };
    configJson = JSON.stringify(merged);
  }
  stmts.update.run(newName, configJson, Date.now(), row.id);
  const updated = stmts.byId.get(row.id);
  // Push the merged-with-globals config out to connected signage clients.
  wsHub.broadcast(updated.slug, { type: 'CONFIG_UPDATE', config: withGlobals(JSON.parse(updated.config_json)) });
  res.json(rowToApi(updated));
});

router.delete('/:slug', requireAuth, (req, res) => {
  const row = stmts.bySlug.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Screen not found' });
  stmts.delete.run(row.id);
  // Tell any connected clients to reload (they'll then 404 and show a message).
  wsHub.broadcast(row.slug, { type: 'SCREEN_DELETED' });
  res.json({ ok: true });
});

// Trigger a one-off action without persisting (e.g., show camera, send message).
// This proxies through to WS without changing the DB config.
router.post('/:slug/event', requireAuth, (req, res) => {
  const row = stmts.bySlug.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Screen not found' });
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Event type required' });
  wsHub.broadcast(row.slug, { type, payload });
  res.json({ ok: true });
});

module.exports = router;
