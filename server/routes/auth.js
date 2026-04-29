const express = require('express');
const auth = require('../auth');

const router = express.Router();

// First-run check: tells the login page whether to show "Set up admin" form
// or "Sign in" form.
router.get('/setup-status', (req, res) => {
  res.json({ needsSetup: !auth.hasUsers() });
});

// First-run only: create the initial admin user. Refuses if a user already exists.
router.post('/setup', async (req, res) => {
  if (auth.hasUsers()) return res.status(403).json({ error: 'Setup already complete' });
  const { username, password } = req.body || {};
  try {
    const id = await auth.createUser(username, password);
    const { token, expiresAt } = auth.issueSession(id);
    auth.setSessionCookie(res, token, expiresAt);
    res.json({ ok: true, user: { id, username } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.verifyLogin(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const { token, expiresAt } = auth.issueSession(user.id);
  auth.setSessionCookie(res, token, expiresAt);
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

router.post('/logout', (req, res) => {
  const session = auth.sessionFromCookie(req);
  if (session) auth.revokeSession(session.token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const session = auth.sessionFromCookie(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: { id: session.user_id, username: session.username } });
});

module.exports = router;
