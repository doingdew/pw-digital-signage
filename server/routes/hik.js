// Admin + signage routes for the Hikvision camera integration.
//
//   GET  /api/hik           — current config (password masked) + listener status
//   PUT  /api/hik           — update config; restarts the alertStream listener
//   POST /api/hik/test      — try /ISAPI/System/deviceInfo with the saved or
//                              supplied creds to validate connectivity
//   GET  /api/hik/snapshot  — auth-free for signage browsers; returns the
//                              latest snapshot fetched server-side via digest
//   POST /api/hik/trigger   — admin-only manual trigger (handy for testing
//                              the signage overlay without walking past the
//                              camera)

const express = require('express');
const { getSetting, setSetting, db } = require('../db');
const { requireAuth } = require('../auth');
const wsHub = require('../ws');
const hik = require('../hik');
// Cache the Slack helper at module-load so the test-trigger route doesn't
// re-resolve the require on every hit. Wrapped in try/catch because the Slack
// packages are optional — see comment at the top of server/slack.js.
let slackPostCameraAlert = null;
try { slackPostCameraAlert = require('../slack').postCameraAlert; } catch (_) {}

const router = express.Router();

const KEY = 'hikvision';

// Fields the admin form is allowed to write. Anything else in the body is
// silently dropped so an old client can't poke unexpected keys into storage.
const FIELDS = [
  'enabled', 'host', 'user', 'pass', 'label',
  'eventTypes', 'classes',
  'debounceSec', 'overlayDurationSec',
  'slackEnabled', 'slackChannel',
];

function loadCleanConfig({ maskPassword = true } = {}) {
  const cur = getSetting(KEY) || {};
  const out = {};
  for (const f of FIELDS) {
    if (f in cur) out[f] = cur[f];
  }
  // Fill defaults so the admin form has predictable values.
  if (typeof out.enabled       !== 'boolean') out.enabled = false;
  if (typeof out.slackEnabled  !== 'boolean') out.slackEnabled = true;
  if (!Array.isArray(out.eventTypes)) out.eventTypes = ['linedetection', 'fielddetection'];
  if (!Array.isArray(out.classes))    out.classes    = ['person', 'vehicle', 'motorVehicle'];
  if (!Number.isFinite(+out.debounceSec))         out.debounceSec = 30;
  if (!Number.isFinite(+out.overlayDurationSec))  out.overlayDurationSec = 15;
  out.host         = out.host || '';
  out.user         = out.user || '';
  out.label        = out.label || 'Loading Bay';
  out.slackChannel = out.slackChannel || '';
  // Mask password on read — never returned in plain text. The admin form sees
  // an empty placeholder which means "leave unchanged on save".
  if (maskPassword) {
    out.passSet = !!out.pass;
    out.pass = '';
  } else {
    out.pass = out.pass || '';
  }
  return out;
}

router.get('/', requireAuth, (req, res) => {
  res.json({
    settings: loadCleanConfig(),
    status: hik.status(),
  });
});

router.put('/', requireAuth, (req, res) => {
  const cur = getSetting(KEY) || {};
  const patch = req.body || {};
  const next = { ...cur };
  for (const f of FIELDS) {
    if (!(f in patch)) continue;
    let v = patch[f];
    if (f === 'pass') {
      // Empty pass on the wire = "keep existing". Only overwrite if the user
      // typed something new. Avoids round-tripping the password through the
      // form on every settings save.
      if (typeof v === 'string' && v.length > 0) next.pass = v;
      continue;
    }
    if (f === 'eventTypes' || f === 'classes') {
      if (Array.isArray(v)) next[f] = v.map(x => String(x).trim()).filter(Boolean);
      continue;
    }
    if (f === 'debounceSec' || f === 'overlayDurationSec') {
      const n = Number(v);
      if (Number.isFinite(n)) next[f] = Math.max(0, Math.min(3600, n));
      continue;
    }
    if (f === 'enabled' || f === 'slackEnabled') {
      next[f] = !!v;
      continue;
    }
    if (typeof v === 'string') next[f] = v.trim();
  }
  setSetting(KEY, next);
  hik.restart();
  res.json({ settings: loadCleanConfig(), status: hik.status() });
});

router.post('/test', requireAuth, async (req, res) => {
  // Accept an override body so the user can validate before saving.
  const override = req.body || {};
  if (Object.keys(override).length) {
    const cur = getSetting(KEY) || {};
    const merged = { ...cur };
    for (const f of FIELDS) {
      if (!(f in override)) continue;
      if (f === 'pass' && (!override.pass || override.pass.length === 0)) continue;
      merged[f] = override[f];
    }
    setSetting(KEY, merged);
  }
  const r = await hik.testConnection();
  res.json(r);
});

// Public snapshot proxy. No auth — the signage page is itself unauthenticated
// (anyone on the LAN with the slug can view it), and the camera credentials
// stay server-side. Returns image bytes with a short cache-control so the
// client can poll at ~2 fps without hammering the camera.
router.get('/snapshot', async (req, res) => {
  try {
    const r = await hik.fetchSnapshot();
    res.setHeader('Content-Type', r.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.buffer);
  } catch (e) {
    res.status(502).json({ error: e.message || 'snapshot failed' });
  }
});

// Manual trigger — useful for testing the overlay + Slack notify without
// having to walk past the camera. Re-uses the same internal path.
router.post('/trigger', requireAuth, (req, res) => {
  const cfg = getSetting(KEY) || {};
  const eventType = (req.body && req.body.eventType) || 'linedetection';
  const targetType = (req.body && req.body.targetType) || 'person';
  // Mirror the broadcast that the live listener does — same payload shape so
  // the signage handler can't tell the two apart.
  const payload = {
    eventType, targetType,
    label: cfg.label || 'Loading Bay',
    durationMs: (Number(cfg.overlayDurationSec) || 15) * 1000,
    snapshotUrl: '/api/hik/snapshot',
    triggeredAt: Date.now(),
    test: true,
  };
  const allScreens = db.prepare('SELECT slug FROM screens').all();
  for (const s of allScreens) wsHub.broadcast(s.slug, { type: 'CAMERA_TRIGGER', payload });
  // Slack message too, if enabled — otherwise the test wouldn't surface the
  // most common configuration mistake (wrong channel id, missing scope).
  // Mirrors the live-event path's logging so admins can diagnose from the
  // same docker logs lines whether they used the test button or a real
  // walk-by trigger.
  if (cfg.slackEnabled === false) {
    console.log('[hik] test slack skipped: slackEnabled=false');
  } else if (!cfg.slackChannel) {
    console.log('[hik] test slack skipped: slackChannel not configured');
  } else {
    if (!slackPostCameraAlert) {
      console.warn('[hik] test slack skipped: slack module missing postCameraAlert export');
    } else {
      hik.fetchSnapshot()
        .then(async snap => {
          const r = await slackPostCameraAlert({
            channel: cfg.slackChannel,
            text: `🧪 *Test trigger* — ${targetType} / ${eventType} at ${cfg.label || 'Loading Bay'}`,
            imageBuffer: snap.buffer,
            filename: `hik-test-${Date.now()}.jpg`,
          });
          if (r && r.ok) console.log(`[hik] test slack alert sent to ${cfg.slackChannel}`);
          else            console.warn(`[hik] test slack alert failed: ${r && r.error ? r.error : 'unknown error'}`);
        })
        .catch(e => console.warn('[hik] test slack send exception:', e.message));
    }
  }
  res.json({ ok: true });
});

module.exports = router;
