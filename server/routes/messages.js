// Messages — sent from admin to a specific screen (or all screens if screen_id null).
// Persisted in DB so a freshly-connecting TV can fetch its recent history.

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const wsHub = require('../ws');

const router = express.Router();

const stmts = {
  bySlug: db.prepare('SELECT * FROM screens WHERE slug = ?'),
  byId:   db.prepare('SELECT * FROM messages WHERE id = ?'),
  screenById: db.prepare('SELECT slug, name FROM screens WHERE id = ?'),
  insert: db.prepare('INSERT INTO messages (screen_id, sender, body, priority) VALUES (?, ?, ?, ?)'),
  recent: db.prepare(`
    SELECT id, sender, body, priority, created_at
    FROM messages
    WHERE (screen_id = ? OR screen_id IS NULL)
      AND created_at > ?
    ORDER BY created_at DESC
    LIMIT 50
  `),
  // Admin view: every message (regardless of age) with the target screen
  // joined in. screen_name/screen_slug are NULL for all-screens broadcasts.
  allRecent: db.prepare(`
    SELECT m.id, m.sender, m.body, m.priority, m.created_at, m.screen_id,
           s.name AS screen_name, s.slug AS screen_slug
    FROM messages m
    LEFT JOIN screens s ON s.id = m.screen_id
    ORDER BY m.created_at DESC
    LIMIT ?
  `),
  deleteOne: db.prepare('DELETE FROM messages WHERE id = ?'),
  clearAll:  db.prepare('DELETE FROM messages WHERE screen_id = ? OR screen_id IS NULL'),
};

// Public — TV pulls recent messages on connect (last 60 min). Matches the
// client-side expireOldMessages cutoff so a TV that wakes up sees the same
// set of messages that other TVs are already displaying.
router.get('/public/:slug', (req, res) => {
  const screen = stmts.bySlug.get(req.params.slug);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  const cutoff = Date.now() - 60 * 60 * 1000;
  const rows = stmts.recent.all(screen.id, cutoff).map(rowToApi);
  res.json({ messages: rows });
});

// Admin — send to one screen, or to all screens (slug = '*').
router.post('/:slug', requireAuth, (req, res) => {
  const slug = req.params.slug;
  const { sender, body, priority } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });

  const screen = slug === '*' ? null : stmts.bySlug.get(slug);
  if (slug !== '*' && !screen) return res.status(404).json({ error: 'Screen not found' });

  const screenId = screen ? screen.id : null;
  const info = stmts.insert.run(screenId, String(sender || '').trim(), String(body).trim(), priority || 'normal');
  const message = {
    id: info.lastInsertRowid,
    sender: String(sender || '').trim(),
    body: String(body).trim(),
    priority: priority || 'normal',
    timestamp: Date.now(),
  };
  // Broadcast over WS to either one room or all rooms.
  if (screen) {
    wsHub.broadcast(screen.slug, { type: 'MESSAGE', message });
  } else {
    // Broadcast to every connected slug
    for (const s of db.prepare('SELECT slug FROM screens').all()) {
      wsHub.broadcast(s.slug, { type: 'MESSAGE', message });
    }
  }
  res.json(message);
});

// Admin: list every message across all screens. Used by the Broadcast page.
router.get('/all', requireAuth, (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const rows = stmts.allRecent.all(limit).map(r => ({
    id: r.id,
    sender: r.sender,
    body: r.body,
    priority: r.priority,
    timestamp: r.created_at,
    target: r.screen_id
      ? { kind: 'screen', slug: r.screen_slug, name: r.screen_name }
      : { kind: 'all' },
  }));
  res.json({ messages: rows });
});

// Delete a single message. The :slug param is ignored — we look up the
// message itself to figure out which clients need a DELETE_MESSAGE event.
// All-screens broadcasts get propagated to every connected room.
router.delete('/:slug/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const msg = stmts.byId.get(id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  stmts.deleteOne.run(id);
  if (msg.screen_id) {
    const s = stmts.screenById.get(msg.screen_id);
    if (s) wsHub.broadcast(s.slug, { type: 'DELETE_MESSAGE', id });
  } else {
    for (const s of db.prepare('SELECT slug FROM screens').all()) {
      wsHub.broadcast(s.slug, { type: 'DELETE_MESSAGE', id });
    }
  }
  res.json({ ok: true });
});

router.delete('/:slug', requireAuth, (req, res) => {
  const slug = req.params.slug;
  const screen = slug === '*' ? null : stmts.bySlug.get(slug);
  const screenId = screen ? screen.id : null;
  stmts.clearAll.run(screenId);
  if (screen) wsHub.broadcast(screen.slug, { type: 'CLEAR_MESSAGES' });
  else for (const s of db.prepare('SELECT slug FROM screens').all()) {
    wsHub.broadcast(s.slug, { type: 'CLEAR_MESSAGES' });
  }
  res.json({ ok: true });
});

function rowToApi(r) {
  return {
    id: r.id,
    sender: r.sender,
    body: r.body,
    priority: r.priority,
    timestamp: r.created_at,
  };
}

module.exports = router;
