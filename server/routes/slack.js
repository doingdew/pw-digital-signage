// Slack settings + control routes — all admin-authenticated.
const express = require('express');
const { getSetting, setSetting } = require('../db');
const { requireAuth } = require('../auth');
const slack = require('../slack');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const cfg = getSetting('slack') || {};
  // Don't echo full tokens back — only first/last few chars for sanity.
  const mask = (s) => (s && s.length > 12) ? `${s.slice(0,8)}…${s.slice(-4)}` : (s ? '••••' : '');
  res.json({
    config: {
      botTokenMask: mask(cfg.botToken),
      appTokenMask: mask(cfg.appToken),
      channelId: cfg.channelId || '',
    },
    status: slack.status(),
  });
});

router.put('/', requireAuth, async (req, res) => {
  const { botToken, appToken, channelId, clear } = req.body || {};
  if (clear) {
    setSetting('slack', {});
    await slack.stop();
    return res.json({ ok: true, status: slack.status() });
  }
  if (!botToken || !appToken || !channelId) {
    return res.status(400).json({ error: 'botToken, appToken and channelId are required' });
  }
  setSetting('slack', { botToken, appToken, channelId });
  // Restart the connection with the new tokens.
  try {
    await slack.start();
    res.json({ ok: true, status: slack.status() });
  } catch (e) {
    res.status(500).json({ error: e.message, status: slack.status() });
  }
});

router.post('/test', requireAuth, async (req, res) => {
  const { botToken, appToken, channelId } = req.body || {};
  try {
    const info = await slack.testConnection({ botToken, appToken, channelId });
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/status', requireAuth, (req, res) => {
  res.json(slack.status());
});

module.exports = router;
