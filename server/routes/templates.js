// Display templates — reusable configs that new screens can be seeded from.
// All routes require admin auth.

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Keys that are intentionally screen-specific and must NOT be carried into a
// template (or out of one when seeding a new screen).
const SCREEN_SPECIFIC = ['logoUploadId'];

// Keys that are server-global and live elsewhere — exclude so a template
// snapshot doesn't bake stale credentials in.
const GLOBAL_KEYS = ['googleMapsApiKey', 'unifiHost', 'unifiApiKey', 'unifiProxyUrl'];

function stripForTemplate(config) {
  const out = { ...config };
  for (const k of [...SCREEN_SPECIFIC, ...GLOBAL_KEYS]) delete out[k];
  return out;
}

const stmts = {
  list:    db.prepare('SELECT id, name, config_json, created_at, updated_at FROM templates ORDER BY name'),
  byId:    db.prepare('SELECT * FROM templates WHERE id = ?'),
  insert:  db.prepare('INSERT INTO templates (id, name, config_json) VALUES (?, ?, ?)'),
  update:  db.prepare('UPDATE templates SET name = ?, config_json = ?, updated_at = ? WHERE id = ?'),
  delete:  db.prepare('DELETE FROM templates WHERE id = ?'),
};

const screenBySlug = db.prepare('SELECT config_json FROM screens WHERE slug = ?');

function rowToApi(r) {
  return {
    id: r.id,
    name: r.name,
    config: JSON.parse(r.config_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// List all templates.
router.get('/', requireAuth, (req, res) => {
  res.json({ templates: stmts.list.all().map(rowToApi) });
});

// Create a template — body either { name, fromSlug } to snapshot from a
// screen, or { name, config } to provide config directly.
router.post('/', requireAuth, (req, res) => {
  const { name, fromSlug, config } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  let cfg;
  if (fromSlug) {
    const row = screenBySlug.get(fromSlug);
    if (!row) return res.status(404).json({ error: 'Source screen not found' });
    cfg = stripForTemplate(JSON.parse(row.config_json));
  } else if (config && typeof config === 'object') {
    cfg = stripForTemplate(config);
  } else {
    return res.status(400).json({ error: 'fromSlug or config required' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  stmts.insert.run(id, String(name).trim(), JSON.stringify(cfg));
  res.json(rowToApi(stmts.byId.get(id)));
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = stmts.byId.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  stmts.delete.run(row.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.loadTemplateConfig = function loadTemplateConfig(id) {
  const row = stmts.byId.get(id);
  if (!row) return null;
  return stripForTemplate(JSON.parse(row.config_json));
};
