// Cookie-based session auth. One admin user is bootstrapped on first run via
// the /api/setup endpoint when the users table is empty.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;  // 30 days

const stmts = {
  userByName:    db.prepare('SELECT * FROM users WHERE username = ?'),
  userById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  userCount:     db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser:    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionByToken:db.prepare('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

// Run a quick prune on boot.
stmts.pruneSessions.run(Date.now());

function hasUsers() {
  return stmts.userCount.get().n > 0;
}

async function createUser(username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (!username || username.length < 2) throw new Error('Username too short');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const hash = await bcrypt.hash(password, 10);
  try {
    const info = stmts.insertUser.run(username, hash);
    return info.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('Username already exists');
    throw e;
  }
}

async function verifyLogin(username, password) {
  const user = stmts.userByName.get(String(username || '').trim().toLowerCase());
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  return ok ? user : null;
}

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  stmts.insertSession.run(token, userId, expiresAt);
  return { token, expiresAt };
}

function revokeSession(token) {
  if (token) stmts.deleteSession.run(token);
}

function sessionFromCookie(req) {
  const token = req.cookies?.sid;
  if (!token) return null;
  return stmts.sessionByToken.get(token, Date.now()) || null;
}

// Express middleware — attaches req.user, or 401s.
function requireAuth(req, res, next) {
  const session = sessionFromCookie(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = { id: session.user_id, username: session.username };
  req.sessionToken = session.token;
  next();
}

// For HTML pages — redirects to /login instead of returning JSON.
function requireAuthPage(req, res, next) {
  const session = sessionFromCookie(req);
  if (!session) {
    return res.redirect('/login');
  }
  req.user = { id: session.user_id, username: session.username };
  next();
}

// Cookie `secure` flag is environment-driven so production HTTPS deployments
// can opt in without a code change. Defaults to off to keep working over plain
// HTTP on the LAN, which is the typical signage setup.
//   COOKIE_SECURE=1  → cookie only sent over HTTPS
//   TRUST_PROXY=1 + cookie_secure=1 is the right pair behind a TLS terminator.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

function setSessionCookie(res, token, expiresAt) {
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    expires: new Date(expiresAt),
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie('sid', { path: '/' });
}

module.exports = {
  hasUsers,
  createUser,
  verifyLogin,
  issueSession,
  revokeSession,
  sessionFromCookie,
  requireAuth,
  requireAuthPage,
  setSessionCookie,
  clearSessionCookie,
};
