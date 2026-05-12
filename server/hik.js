// Hikvision IP camera integration — ISAPI alertStream listener + snapshot
// helper + Slack notification on smart-event triggers.
//
// Architecture:
//   1. The camera runs its own Smart Event analytics (Line Crossing /
//      Intrusion Detection) configured via its web UI. Boundaries and target
//      classification (person / vehicle) live on the camera, not here.
//   2. We hold a long-running HTTP connection to /ISAPI/Event/notification/
//      alertStream which streams multipart events as analytics fire.
//   3. Each event passes through two filters: the configured event-type list
//      and the configured target-class list. Surviving events are debounced
//      (per class) so a person walking past doesn't generate ten alerts.
//   4. On a surviving event we (a) broadcast a CAMERA_TRIGGER WS message to
//      every connected signage page so the overlay pops, and (b) post a Slack
//      message + snapshot to the configured channel.
//
// Settings live under the 'hikvision' key in the settings table.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { getSetting, db } = require('./db');
const wsHub = require('./ws');
let slackPostCameraAlert = null;
try { slackPostCameraAlert = require('./slack').postCameraAlert; } catch (_) {}

// Default IANA timezone used when neither the global config nor the process
// TZ env var has been set. Picked because the rest of the deployment is on
// US Eastern (S&P 500 schedule etc.) — change LOCAL_TZ_FALLBACK below or set
// the TZ env var in docker-compose to override.
const LOCAL_TZ_FALLBACK = 'America/New_York';

// Format a wall-clock time-of-day string in the server's local timezone for
// human-facing Slack alerts. Node inside Docker defaults to UTC unless TZ is
// set, so we resolve in priority order: app setting → TZ env → fallback.
function formatLocalTime(ms) {
  const cfg = (typeof getSetting === 'function' && getSetting('hikvision')) || {};
  const tz = (cfg.timezone || process.env.TZ || LOCAL_TZ_FALLBACK || '').trim();
  try {
    return new Date(ms).toLocaleTimeString('en-US', {
      timeZone: tz || undefined,
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch (_) {
    // Bogus IANA name — fall back to the host's default behaviour rather
    // than throwing inside the alert path.
    return new Date(ms).toLocaleTimeString();
  }
}

const STREAM_RECONNECT_BASE_MS = 3000;
const STREAM_RECONNECT_MAX_MS  = 60 * 1000;
const SNAPSHOT_TIMEOUT_MS      = 6000;
const STREAM_REQUEST_TIMEOUT_MS = 0;   // no socket timeout — long-poll

let streamReq = null;
let streamRetry = 0;
let stopping = false;
const lastTriggerAt = new Map();   // class → ms

function getConfig() {
  const cfg = getSetting('hikvision') || {};
  return {
    enabled:     !!cfg.enabled,
    host:        (cfg.host || '').trim(),     // e.g. "10.0.91.238" or "10.0.91.238:80"
    user:        cfg.user || '',
    pass:        cfg.pass || '',
    eventTypes:  Array.isArray(cfg.eventTypes)    && cfg.eventTypes.length    ? cfg.eventTypes
                                                                              : ['linedetection', 'fielddetection'],
    classes:     Array.isArray(cfg.classes)       && cfg.classes.length       ? cfg.classes
                                                                              : ['person', 'vehicle', 'motorVehicle'],
    debounceSec: Number.isFinite(+cfg.debounceSec) ? +cfg.debounceSec : 30,
    overlayDurationSec: Number.isFinite(+cfg.overlayDurationSec) ? +cfg.overlayDurationSec : 15,
    slackChannel: (cfg.slackChannel || '').trim(),
    slackEnabled: cfg.slackEnabled !== false,
    label:       cfg.label || 'Loading Bay',
  };
}

// Build a base URL from the configured host. Accepts "1.2.3.4", "1.2.3.4:80",
// "http://1.2.3.4", or "https://example.com:443/" — all normalize to a clean
// origin we can append /ISAPI/... to.
function originOf(host) {
  if (!host) return null;
  let h = host.trim();
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  try {
    const u = new URL(h);
    return `${u.protocol}//${u.host}`;
  } catch (_) { return null; }
}

// Parse RFC 7616 (digest) WWW-Authenticate header values like:
//   Digest realm="...", nonce="...", qop="auth", opaque="...", algorithm="MD5"
function parseDigestHeader(header) {
  const out = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] || '').trim();
  return out;
}

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Build a Digest Authorization header from a server challenge.
function buildDigestHeader({ user, pass, method, path, www, nc = '00000001' }) {
  const realm = www.realm || '';
  const nonce = www.nonce || '';
  const qop = www.qop || '';
  const algorithm = (www.algorithm || 'MD5').toUpperCase();
  const opaque = www.opaque;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${path}`);
  let response;
  if (qop) response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  else     response = md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${path}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop)    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return 'Digest ' + parts.join(', ');
}

// Single-shot HTTP GET that handles a 401 digest challenge transparently.
// Resolves to { status, body, contentType, headers }. body is a Buffer.
function httpGetWithDigest({ origin, path, user, pass, timeoutMs = SNAPSHOT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin + path);
    const lib = u.protocol === 'https:' ? https : http;
    const baseOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      timeout: timeoutMs,
      // Hikvision presents a self-signed cert when HTTPS is on — accept it.
      rejectUnauthorized: false,
    };
    const send = (extraHeaders = {}) => {
      const req = lib.request({ ...baseOpts, headers: extraHeaders }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), contentType: res.headers['content-type'], headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.end();
    };
    // First request — no auth. If we get a 401 with a Digest challenge, retry
    // with the Authorization header. Many cameras also accept Basic, so this
    // would still work even if we're wrong about which scheme they want.
    const probe = lib.request({ ...baseOpts, headers: {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 401 && res.headers['www-authenticate']) {
          const wwwRaw = res.headers['www-authenticate'];
          const isDigest = /^Digest\b/i.test(wwwRaw);
          if (isDigest) {
            const www = parseDigestHeader(wwwRaw.replace(/^Digest\s+/i, ''));
            const auth = buildDigestHeader({ user, pass, method: 'GET', path: baseOpts.path, www });
            send({ Authorization: auth });
          } else {
            // Fall back to Basic.
            const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
            send({ Authorization: auth });
          }
        } else {
          resolve({ status: res.statusCode, body: buf, contentType: res.headers['content-type'], headers: res.headers });
        }
      });
    });
    probe.on('error', reject);
    probe.on('timeout', () => probe.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    probe.end();
  });
}

async function fetchSnapshot() {
  const cfg = getConfig();
  const origin = originOf(cfg.host);
  if (!origin) throw new Error('Camera host not configured');
  // Channel 101 = main stream channel 1, the standard primary channel for
  // most Hikvision firmwares. If users need a sub-stream they can change
  // the path in the admin field.
  const path = '/ISAPI/Streaming/channels/101/picture';
  const r = await httpGetWithDigest({ origin, path, user: cfg.user, pass: cfg.pass });
  if (r.status >= 200 && r.status < 300) return { buffer: r.body, contentType: r.contentType || 'image/jpeg' };
  throw new Error(`Snapshot HTTP ${r.status}`);
}

// Ask the camera for /ISAPI/System/deviceInfo as a connectivity / credentials
// test. Returns { ok, model?, firmware?, error? }.
async function testConnection() {
  const cfg = getConfig();
  const origin = originOf(cfg.host);
  if (!origin) return { ok: false, error: 'Host not configured' };
  if (!cfg.user || !cfg.pass) return { ok: false, error: 'Username + password required' };
  try {
    const r = await httpGetWithDigest({ origin, path: '/ISAPI/System/deviceInfo', user: cfg.user, pass: cfg.pass });
    if (r.status >= 200 && r.status < 300) {
      const xml = r.body.toString('utf8');
      const model    = (xml.match(/<model>([^<]+)<\/model>/i)        || [])[1] || '';
      const firmware = (xml.match(/<firmwareVersion>([^<]+)<\/firmwareVersion>/i) || [])[1] || '';
      return { ok: true, model, firmware };
    }
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── alertStream listener ─────────────────────────────────────────
// Hikvision streams XML or JSON event notifications as multipart parts. We
// accumulate the raw stream and split on the boundary, parse each part's
// payload for known fields, and route to the trigger handler.

function startStreamListener() {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  const origin = originOf(cfg.host);
  if (!origin) return;
  if (!cfg.user || !cfg.pass) {
    console.warn('[hik] alertStream not started — credentials missing');
    return;
  }

  const u = new URL(origin + '/ISAPI/Event/notification/alertStream');
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname,
    method: 'GET',
    headers: { 'Connection': 'keep-alive' },
    rejectUnauthorized: false,
    timeout: STREAM_REQUEST_TIMEOUT_MS,
  };

  // Step 1: probe to learn the auth scheme. Hikvision always uses digest;
  // doing the explicit challenge round-trip keeps the code path identical
  // to the snapshot helper.
  const probe = lib.request(opts, (probeRes) => {
    const drain = (cb) => {
      probeRes.on('data', () => {});
      probeRes.on('end', cb);
    };
    if (probeRes.statusCode === 401 && probeRes.headers['www-authenticate']) {
      const wwwRaw = probeRes.headers['www-authenticate'];
      const www = parseDigestHeader(wwwRaw.replace(/^Digest\s+/i, ''));
      drain(() => {
        const auth = buildDigestHeader({ user: cfg.user, pass: cfg.pass, method: 'GET', path: opts.path, www });
        openStream({ ...opts, headers: { ...opts.headers, Authorization: auth } });
      });
    } else if (probeRes.statusCode >= 200 && probeRes.statusCode < 300) {
      // Camera doesn't require auth (rare). Stream is already open — but we
      // need to handle the data ourselves now.
      handleStreamResponse(probeRes);
    } else {
      console.warn(`[hik] probe got HTTP ${probeRes.statusCode}, retrying`);
      drain(() => scheduleReconnect());
    }
  });
  probe.on('error', (e) => { console.warn('[hik] probe error:', e.message); scheduleReconnect(); });
  probe.end();
}

function openStream(opts) {
  const lib = opts.port === 443 || /^https/.test(opts.protocol || '') ? https : http;
  const req = lib.request(opts, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`[hik] alertStream HTTP ${res.statusCode}`);
      res.resume();
      scheduleReconnect();
      return;
    }
    handleStreamResponse(res);
  });
  req.on('error', (e) => { console.warn('[hik] stream error:', e.message); scheduleReconnect(); });
  streamReq = req;
  req.end();
}

function handleStreamResponse(res) {
  console.log('[hik] alertStream connected');
  streamRetry = 0;
  // Determine the multipart boundary from the Content-Type header. Falls back
  // to the well-known Hikvision default if absent.
  const ct = res.headers['content-type'] || '';
  const m = ct.match(/boundary=([^;]+)/i);
  const boundary = (m ? m[1] : 'MIME_boundary').replace(/^"|"$/g, '');
  const sep = Buffer.from(`--${boundary}`);
  let buf = Buffer.alloc(0);

  res.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    // Walk every boundary-delimited part we've seen so far.
    while ((idx = buf.indexOf(sep)) >= 0) {
      const part = buf.slice(0, idx);
      buf = buf.slice(idx + sep.length);
      // The first part is empty (everything before the first boundary).
      if (part.length === 0) continue;
      // A part has headers, blank line, body. Find the blank line.
      const hdrEnd = part.indexOf(Buffer.from('\r\n\r\n'));
      const body = (hdrEnd >= 0 ? part.slice(hdrEnd + 4) : part).toString('utf8').trim();
      if (!body) continue;
      try { handleEventPayload(body); }
      catch (e) { console.warn('[hik] event parse error:', e.message); }
    }
  });
  res.on('end',   () => { console.log('[hik] alertStream ended'); scheduleReconnect(); });
  res.on('error', (e) => { console.warn('[hik] stream read error:', e.message); scheduleReconnect(); });
}

function scheduleReconnect() {
  if (stopping) return;
  streamReq = null;
  streamRetry++;
  const delay = Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * Math.pow(2, streamRetry - 1));
  console.log(`[hik] reconnecting alertStream in ${Math.round(delay / 1000)}s (attempt ${streamRetry})`);
  setTimeout(() => { if (!stopping) startStreamListener(); }, delay).unref();
}

// Pull the interesting fields out of an event payload. Handles both XML and
// JSON variants (Hikvision firmware varies). Returns null if nothing of
// interest matched.
function handleEventPayload(body) {
  const cfg = getConfig();
  let eventType = '';
  let targetType = '';
  // JSON form (modern firmware with ?format=json).
  if (body.startsWith('{')) {
    try {
      const j = JSON.parse(body);
      eventType  = (j.eventType || '').toString().toLowerCase();
      targetType = (j.DetectionRegionList?.[0]?.DetectionRegionEntry?.detectionTarget || j.targetType || '').toString().toLowerCase();
    } catch (_) { return; }
  } else {
    // XML.
    eventType  = ((body.match(/<eventType>([^<]+)<\/eventType>/i) || [])[1] || '').toLowerCase();
    targetType = ((body.match(/<detectionTarget>([^<]+)<\/detectionTarget>/i)
                || body.match(/<targetType>([^<]+)<\/targetType>/i)
                || [])[1] || '').toLowerCase();
  }
  if (!eventType) return;
  // Heartbeat events fire every couple of seconds — ignore them. They use
  // eventType "videoloss" / "shelteralarm" or simply repeat the configured
  // analytic with eventState=inactive. A whitelist of meaningful types is
  // simpler than an ever-growing blacklist of "boring" ones.
  const wantTypes = (cfg.eventTypes || []).map(s => s.toLowerCase());
  if (wantTypes.length && !wantTypes.includes(eventType)) return;
  // Optional class filter — if the firmware reports a target class and the
  // user has restricted classes, drop ones that don't match. If the firmware
  // doesn't report a class, let it through (better to over-trigger than miss).
  if (targetType && cfg.classes && cfg.classes.length) {
    const wantClasses = cfg.classes.map(s => s.toLowerCase());
    if (!wantClasses.includes(targetType)) return;
  }
  fireTrigger({ eventType, targetType });
}

function fireTrigger({ eventType, targetType }) {
  const cfg = getConfig();
  const key = targetType || eventType;
  const now = Date.now();
  const last = lastTriggerAt.get(key) || 0;
  if (now - last < cfg.debounceSec * 1000) return;
  lastTriggerAt.set(key, now);

  console.log(`[hik] trigger event=${eventType} target=${targetType || '?'}`);

  // Broadcast to every connected signage page so the overlay pops everywhere.
  // Each screen will fetch the snapshot via /api/hik/snapshot and poll it.
  const allScreens = db.prepare('SELECT slug FROM screens').all();
  const payload = {
    eventType, targetType,
    label: cfg.label,
    durationMs: cfg.overlayDurationSec * 1000,
    snapshotUrl: '/api/hik/snapshot',     // signage adds cache-bust query
    triggeredAt: now,
  };
  for (const s of allScreens) {
    wsHub.broadcast(s.slug, { type: 'CAMERA_TRIGGER', payload });
  }

  // Slack alert (best-effort, don't block). The Slack helper resolves to
  // { ok, error } for known API failures (not_in_channel, missing_scope, …)
  // rather than throwing, so we have to inspect the return value too — a
  // silent {ok:false} would otherwise mask the real reason.
  if (!cfg.slackEnabled) {
    console.log('[hik] slack skipped: slackEnabled=false');
  } else if (!cfg.slackChannel) {
    console.log('[hik] slack skipped: slackChannel not configured');
  } else if (!slackPostCameraAlert) {
    console.warn('[hik] slack skipped: slack module missing postCameraAlert export');
  } else {
    fetchSnapshot()
      .then(async snap => {
        const niceClass = targetType ? targetType.replace(/^\w/, c => c.toUpperCase()) : 'Object';
        const niceEvent = eventType.replace(/detection/i, ' detection').replace(/^\w/, c => c.toUpperCase());
        const text = `🚨 *${niceClass} detected* — ${niceEvent} on ${cfg.label} at ${formatLocalTime(now)}`;
        const r = await slackPostCameraAlert({
          channel: cfg.slackChannel,
          text,
          imageBuffer: snap.buffer,
          filename: `hik-${eventType}-${Date.now()}.jpg`,
        });
        if (r && r.ok) console.log(`[hik] slack alert sent to ${cfg.slackChannel}`);
        else            console.warn(`[hik] slack alert failed: ${r && r.error ? r.error : 'unknown error'}`);
      })
      .catch(e => console.warn('[hik] slack notify exception:', e.message));
  }
}

function start() {
  stopping = false;
  if (streamReq) return;
  startStreamListener();
}

function stop() {
  stopping = true;
  if (streamReq) {
    try { streamReq.destroy(); } catch (_) {}
    streamReq = null;
  }
}

// Hot-reload — call this after settings change to apply new config.
function restart() {
  stop();
  // small delay to let socket close
  setTimeout(() => { stopping = false; start(); }, 200).unref();
}

function status() {
  return {
    enabled: getConfig().enabled,
    connected: !!streamReq,
    retryCount: streamRetry,
  };
}

module.exports = { start, stop, restart, status, fetchSnapshot, testConnection };
