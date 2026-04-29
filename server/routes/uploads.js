// File uploads — admin-authenticated. Stored on disk under data/uploads with a
// UUID filename; metadata in the `uploads` table. Served publicly at
// /files/:id (no auth — the URL is unguessable).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, UPLOADS_DIR } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
const MAX_SIZE = 8 * 1024 * 1024;  // 8 MB

const stmts = {
  insert:   db.prepare('INSERT INTO uploads (id, filename, mime, size, path) VALUES (?, ?, ?, ?, ?)'),
  byId:     db.prepare('SELECT * FROM uploads WHERE id = ?'),
  list:     db.prepare('SELECT id, filename, mime, size, uploaded_at FROM uploads ORDER BY uploaded_at DESC'),
  delete:   db.prepare('DELETE FROM uploads WHERE id = ?'),
  rename:   db.prepare('UPDATE uploads SET filename = ? WHERE id = ?'),
};

// Multer config — stream straight to a UUID-named file.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 8);
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('Unsupported file type'));
    cb(null, true);
  },
});

// POST /api/uploads — multipart, field name "file"
router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const id = path.basename(req.file.filename, path.extname(req.file.filename));
  stmts.insert.run(id, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename);
  res.json({
    id,
    url: `/api/uploads/${id}/view`,
    filename: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
  });
});

router.get('/', requireAuth, (req, res) => {
  const rows = stmts.list.all().map(r => ({
    id: r.id,
    url: `/api/uploads/${r.id}/view`,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    uploadedAt: r.uploaded_at,
  }));
  res.json({ uploads: rows });
});

// Rename — only the user-visible `filename` field is editable; the on-disk
// UUID filename is kept as-is so existing /files and /api/uploads/:id/view
// links keep working.
router.patch('/:id', requireAuth, (req, res) => {
  const row = stmts.byId.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const raw = (req.body && typeof req.body.filename === 'string') ? req.body.filename.trim() : '';
  if (!raw) return res.status(400).json({ error: 'filename is required' });
  // Strip path separators just in case — this is a display label, not a path.
  const safe = raw.replace(/[\\/]/g, '_').slice(0, 200);
  stmts.rename.run(safe, row.id);
  res.json({
    id: row.id,
    url: `/api/uploads/${row.id}/view`,
    filename: safe,
    mime: row.mime,
    size: row.size,
    uploadedAt: row.uploaded_at,
  });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = stmts.byId.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, row.path)); } catch (_) {}
  stmts.delete.run(row.id);
  res.json({ ok: true });
});

// Public: resolve a bare upload ID (no extension) to its file. The TV uses this
// for logos because we store the bare ID in screen config — that way the
// extension can change without breaking saved references.
router.get('/:id/view', (req, res) => {
  const row = stmts.byId.get(req.params.id);
  if (!row) return res.status(404).end();
  const full = path.join(UPLOADS_DIR, row.path);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.sendFile(full);
});

// Helper: disk filename = id + extension. We stored just the basename in `path`.
function diskNameForId(id) {
  const row = stmts.byId.get(id);
  return row ? row.path : id;
}

// Multer error handler — returns JSON instead of an HTML error page.
router.use((err, _req, res, _next) => {
  if (err) {
    const msg = err.message || 'Upload error';
    return res.status(400).json({ error: msg });
  }
});

module.exports = router;
