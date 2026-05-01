// Pittwater Signage — TV-facing app.
// Boots from URL slug, fetches config from server, subscribes to WebSocket
// for live updates, drives the 12-zone rotation.

(() => {
'use strict';

const SLUG = (location.pathname.match(/^\/s\/([a-z0-9-]+)/) || [])[1] || '';
const QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { text: "Hard work beats talent when talent doesn't work hard.", author: "Tim Notke" },
  { text: "The strength of the team is each individual member.", author: "Phil Jackson" },
  { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "Alone we can do so little; together we can do so much.", author: "Helen Keller" },
  { text: "Talent wins games, but teamwork wins championships.", author: "Michael Jordan" },
  { text: "Coming together is a beginning. Keeping together is progress. Working together is success.", author: "Henry Ford" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "Strive not to be a success, but rather to be of value.", author: "Albert Einstein" },
  { text: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt" },
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { text: "Excellence is not a destination; it's a continuous journey.", author: "Brian Tracy" },
  { text: "The harder I work, the luckier I get.", author: "Samuel Goldwyn" },
  { text: "Continuous improvement is better than delayed perfection.", author: "Mark Twain" },
  { text: "Energy and persistence conquer all things.", author: "Benjamin Franklin" },
  { text: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe" },
  { text: "What gets measured gets managed.", author: "Peter Drucker" },
  { text: "Great things in business are never done by one person. They're done by a team of people.", author: "Steve Jobs" },
  { text: "Whether you think you can or you think you can't, you're right.", author: "Henry Ford" },
  { text: "Fall seven times, stand up eight.", author: "Japanese Proverb" },
  { text: "Eighty percent of success is showing up.", author: "Woody Allen" },
  { text: "You miss 100% of the shots you don't take.", author: "Wayne Gretzky" },
  { text: "Innovation distinguishes between a leader and a follower.", author: "Steve Jobs" },
  { text: "If you can dream it, you can do it.", author: "Walt Disney" },
];

const state = {
  config: null,           // server-fed config (full)
  currentZone: 0,
  rotationInterval: null,
  rotationMs: 15000,
  slackMessages: [],
  safetyIndex: 0,
  motivationIndex: 0,
  slackIndex: 0,
};
const shuffledQuotes = [...QUOTES].sort(() => Math.random() - 0.5);

// ── Utilities ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function setText(id, t) { const el = $(id); if (el) el.textContent = t; }

// ── Boot ─────────────────────────────────────────────────────────
async function boot() {
  if (!SLUG) { document.body.innerHTML = '<div style="padding:40px;color:#aaa;">No screen slug in URL.</div>'; return; }
  try {
    const r = await fetch(`/api/screens/public/${SLUG}`);
    if (!r.ok) throw new Error('Screen not found');
    const screen = await r.json();
    state.config = screen.config;
    document.title = `${screen.name} · Signage`;
    applyConfig(state.config);
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#aaa;">Screen not found: <code>${escHtml(SLUG)}</code></div>`;
    return;
  }
  // Pull recent messages
  try {
    const r = await fetch(`/api/messages/public/${SLUG}`);
    const j = await r.json();
    state.slackMessages = (j.messages || []).map(m => ({
      id: m.id, timestamp: m.timestamp, sender: m.sender, body: m.body, priority: m.priority,
    }));
    renderSlack();
    renderMessageTicker();
  } catch (_) {}

  // Periodic refreshes
  startWeather();
  startSheet();
  startSports();
  startTrends();
  startStocks();
  startWarehouse();
  // Build static parts
  buildAnalogFace();
  buildDots();
  setClockStyle(state.config.clockStyle || 'digital');
  renderSafety();
  renderMotivation();
  renderCustomKpis();
  applyZoneSizes();
  updateForecastVisibility();
  buildCameraGrid();
  startCamRefresh();
  goToZone(0);
  restartRotation();
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(expireOldMessages, 60 * 1000);
  // Nightly self-reload — keeps Chromium on Raspberry Pi (or any memory-
  // constrained kiosk) from gradually OOM-ing over a multi-day uptime.
  setInterval(maybeNightlyReload, 60 * 1000);

  // WebSocket — live updates
  connectWs();

  // Safety / reliability
  window.addEventListener('error', (e) => console.error('Signage error:', e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection:', e.reason));
  let lastVisibleAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (Date.now() - lastVisibleAt > 60 * 60 * 1000) location.reload();
      lastVisibleAt = Date.now();
    } else {
      lastVisibleAt = Date.now();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === ' ') goToZone(state.currentZone + 1, true);
    if (e.key === 'ArrowLeft') goToZone(state.currentZone - 1, true);
    if (e.key === 'Escape') { dismissCamera(); $('message-overlay').classList.remove('active'); }
    if (e.key === 'r' && e.ctrlKey && e.shiftKey) location.reload();
  });
}

// ── Apply config (also called when WS sends a CONFIG_UPDATE) ─────
function applyConfig(cfg) {
  state.config = cfg;
  state.rotationMs = Math.max(3000, cfg.rotationMs || 15000);
  // Colors
  document.documentElement.style.setProperty('--bg', cfg.bgColor || '#0a0e1a');
  document.documentElement.style.setProperty('--accent', cfg.accentColor || '#00aaff');
  document.body.style.background = cfg.bgColor || '#0a0e1a';
  // Light-theme detection — Daylight, Paper, etc. have near-white backgrounds
  // where the default white text + translucent-white cards are invisible.
  // Toggling .light-theme on body lets the CSS override --text / --subtext
  // and the few translucent surfaces that hard-code white tints.
  document.body.classList.toggle('light-theme', isLightColor(cfg.bgColor || '#0a0e1a'));
  applyBgMotion(cfg);
  // Font
  if (cfg.fontFamily && window.loadFontFamily) {
    window.loadFontFamily(cfg.fontFamily);
    document.documentElement.style.setProperty('--font', `'${cfg.fontFamily}', system-ui, sans-serif`);
  }
  // Logo
  const slot = $('header-logo');
  slot.innerHTML = '';
  let src = '';
  if (cfg.logoUploadId) src = `/api/uploads/${cfg.logoUploadId}/view`;
  else if (cfg.logoUrl) src = cfg.logoUrl;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Logo';
    img.onerror = () => img.remove();
    slot.appendChild(img);
  }
  // Zones
  buildDots();
}

// ── Last-refreshed badge ─────────────────────────────────────────
// Centered "Last refreshed" indicator at the bottom of the screen. Each zone
// that pulls remote data calls markRefreshed(zid) after a successful fetch;
// when a zone activates the badge shows that zone's most recent fetch time.
// Zones without remote data (clock, sun arc, etc.) hide the badge.
const REFRESHABLE_ZONES = new Set([
  'zone-shipments', 'zone-warehouse', 'zone-kpi', 'zone-weather',
  'zone-sports-results', 'zone-sports-upcoming',
  'zone-stocks-overview', 'zone-stocks-bigboard',
  'zone-trends', 'zone-meetings', 'zone-calendar',
  'zone-doors', 'zone-radar', 'zone-traffic',
  'zone-slack', 'zone-bignum',
]);
function markRefreshed(zid, ts) {
  if (!state.zoneRefreshedAt) state.zoneRefreshedAt = {};
  state.zoneRefreshedAt[zid] = ts || Date.now();
  // Immediately repaint the badge if the just-refreshed zone is the visible one.
  const cur = state.config?.zoneIds?.[state.currentZone];
  if (cur === zid) updateLastRefreshedDisplay(zid);
}
function updateLastRefreshedDisplay(zid) {
  const el = document.getElementById('last-refreshed');
  if (!el) return;
  if (!REFRESHABLE_ZONES.has(zid)) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  const ts = state.zoneRefreshedAt && state.zoneRefreshedAt[zid];
  if (!ts) { el.textContent = 'Last refreshed: —'; return; }
  const t = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last refreshed: ${t}`;
}

// True if the given hex colour is light enough that white-on-X text becomes
// unreadable. Uses luminance-weighted average per ITU-R BT.601 (Y'=0.299R +
// 0.587G + 0.114B). Cutoff at 0.6 picks up #f6f8fa (Daylight) and #fdfaf3
// (Paper) while leaving Slate (#1a1f2e) firmly on the dark side.
function isLightColor(hex) {
  const m = /^#?([a-f0-9]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

const BG_MOTION_PATTERNS = ['drift','aurora','stars','grid','waves'];
function applyBgMotion(cfg) {
  // Migrate legacy `bgMotion: true` flag → 'drift' pattern.
  let pattern = cfg.bgMotionPattern;
  if (!pattern && cfg.bgMotion) pattern = 'drift';
  if (!BG_MOTION_PATTERNS.includes(pattern)) pattern = 'off';
  for (const p of BG_MOTION_PATTERNS) document.body.classList.remove(`bg-motion-${p}`);
  if (pattern !== 'off') document.body.classList.add(`bg-motion-${pattern}`);
  // Slider value 0-100 maps to 0-1.2 multiplier (1.2 lets users push beyond
  // the design baseline if they want it more obvious on bright displays).
  const rawI = Number.isFinite(+cfg.bgMotionIntensity) ? +cfg.bgMotionIntensity : 60;
  const intensity = Math.max(0, Math.min(100, rawI)) / 100 * 1.2;
  document.documentElement.style.setProperty('--bg-motion-intensity', intensity.toFixed(3));
}

// ── WebSocket ────────────────────────────────────────────────────
let ws = null;
let wsRetry = 0;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/${SLUG}`);
  ws.onopen = () => { wsRetry = 0; };
  ws.onclose = () => {
    wsRetry++;
    setTimeout(connectWs, Math.min(30000, 1000 * Math.pow(2, wsRetry)));
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      handleWsMessage(m);
    } catch (_) {}
  };
}

function handleWsMessage(m) {
  switch (m.type) {
    case 'DOOR_STATUS':
      renderDoors(m.doors);
      break;
    case 'CONFIG_UPDATE':
      applyConfig(m.config);
      // Re-init pieces that depend on config
      setClockStyle(state.config.clockStyle || 'digital');
      renderSafety();
      renderCustomKpis();
      updateForecastVisibility();
      fetchWeather();
      if (state.config.googleSheetUrl) fetchSheetData();
      buildCameraGrid();
      startCamRefresh();
      restartRotation();
      // Force refresh of map zones if currently active
      if ($('zone-radar').classList.contains('active')) initRadar();
      if ($('zone-traffic').classList.contains('active')) updateTrafficMap();
      // Slides — rebuild iframe src whenever URL or seconds change.
      renderSlides();
      // Re-apply size classes (weather, big number, clock, world clocks).
      applyZoneSizes();
      break;
    case 'MESSAGE': {
      const msg = m.message;
      state.slackMessages.unshift({ ...msg, timestamp: msg.timestamp || Date.now() });
      if (state.slackMessages.length > 50) state.slackMessages.pop();
      renderSlack();
      showMessageOverlay(msg);
      renderMessageTicker();
      playAlertSound(msg.priority || 'info');
      break;
    }
    case 'CLEAR_MESSAGES':
      state.slackMessages = []; state.slackIndex = 0; renderSlack(); renderMessageTicker(); break;
    case 'DELETE_MESSAGE':
      state.slackMessages = state.slackMessages.filter(x => x.id !== m.id);
      state.slackIndex = 0; renderSlack(); renderMessageTicker(); break;
    case 'SHOW_CAMERA':
    case 'CAMERA_SHOW':
      showCamera(m.payload?.url, m.payload?.label); playAlertSound('camera'); break;
    case 'CAMERA_TRIGGER':
      // Hikvision smart-event fired — show the overlay with a server-proxied
      // snapshot poll for a near-live preview.
      showCameraSnapshot(m.payload || {}); playAlertSound('camera'); break;
    case 'HIDE_CAMERA':
    case 'CAMERA_HIDE':
      dismissCamera(); break;
    case 'SHOW_ZONE': {
      const id = m.payload?.id;
      const zoneIds = state.config.zoneIds || [];
      const idx = zoneIds.indexOf(id);
      if (idx >= 0) goToZone(idx, true);
      break;
    }
    case 'SCREEN_DELETED':
      document.body.innerHTML = '<div style="padding:40px;color:#aaa;">This screen was deleted.</div>';
      break;
    case 'SLUG_CHANGED':
      // Admin renamed this screen — point the browser at the new URL so the
      // bookmark / kiosk shortcut updates after one more reload cycle.
      if (m.slug && typeof m.slug === 'string') {
        location.replace(`/s/${encodeURIComponent(m.slug)}`);
      }
      break;
  }
}

// ── Clock ────────────────────────────────────────────────────────
function setClockStyle(style) {
  $('clock-digital').style.display = style === 'digital' ? 'flex' : 'none';
  $('clock-minimal').style.display = style === 'minimal' ? 'flex' : 'none';
  $('clock-analog').style.display  = style === 'analog'  ? 'flex' : 'none';
  renderClockWorldClocksRow();
}

// Inline row of mini world-clock cards under the main clock face.
// Only shown when the screen has the toggle enabled.
function renderClockWorldClocksRow() {
  const row = $('clock-worldclocks-row'); if (!row) return;
  const cfg = state.config;
  const list = cfg?.worldClocks || [];
  if (!cfg?.showWorldClocksOnClock || !list.length) {
    row.classList.remove('visible');
    row.innerHTML = '';
    return;
  }
  row.classList.add('visible');
  row.innerHTML = list.map((c, i) => `
    <div class="cwr-card" data-i="${i}">
      <div class="cwr-label">${escHtml(c.label || c.tz)}</div>
      <div class="cwr-time" data-cwr-time="${i}">--:--</div>
    </div>
  `).join('');
  tickClockWorldClocksRow();
}
function tickClockWorldClocksRow() {
  const row = $('clock-worldclocks-row'); if (!row || !row.classList.contains('visible')) return;
  const list = state.config?.worldClocks || [];
  const now = new Date();
  list.forEach((c, i) => {
    let h = '00', m = '00', ampm = 'AM';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: c.tz || 'UTC' }).formatToParts(now);
      const get = t => parts.find(p => p.type === t)?.value || '';
      h = get('hour'); m = get('minute'); ampm = get('dayPeriod');
    } catch (_) {}
    const t = document.querySelector(`[data-cwr-time="${i}"]`);
    if (t) t.textContent = `${h}:${m} ${ampm}`;
  });
}
// Tick the inline row every second when the Clock zone is active.
setInterval(() => {
  if ($('zone-clock')?.classList.contains('active')) tickClockWorldClocksRow();
}, 1000);

function buildAnalogFace() {
  const ticksG = $('hour-ticks'), minTicksG = $('minute-ticks'), labelsG = $('hour-labels');
  if (!ticksG) return;
  const cx = 210, cy = 210, r = 190;
  for (let i = 0; i < 60; i++) {
    const angle = (i * 6 - 90) * Math.PI / 180;
    const isHour = i % 5 === 0;
    const innerR = isHour ? r - 22 : r - 10;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + innerR * Math.cos(angle), y2 = cy + innerR * Math.sin(angle);
    const el = document.createElementNS('http://www.w3.org/2000/svg','line');
    el.setAttribute('x1', x1); el.setAttribute('y1', y1);
    el.setAttribute('x2', x2); el.setAttribute('y2', y2);
    el.setAttribute('stroke', isHour ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)');
    el.setAttribute('stroke-width', isHour ? '2.5' : '1');
    (isHour ? ticksG : minTicksG).appendChild(el);
  }
  for (let i = 1; i <= 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const lx = cx + (r - 42) * Math.cos(angle);
    const ly = cy + (r - 42) * Math.sin(angle);
    const txt = document.createElementNS('http://www.w3.org/2000/svg','text');
    txt.setAttribute('x', lx); txt.setAttribute('y', ly);
    txt.textContent = i;
    labelsG.appendChild(txt);
  }
}

function updateAnalogHands(h, m, s) {
  const cx = 210, cy = 210;
  const secAngle = (s * 6 - 90) * Math.PI / 180;
  const minAngle = ((m + s/60) * 6 - 90) * Math.PI / 180;
  const hourAngle = ((h % 12 + m/60) * 30 - 90) * Math.PI / 180;
  const setHand = (id, angle, len) => {
    const el = $(id); if (!el) return;
    el.setAttribute('x2', cx + len * Math.cos(angle));
    el.setAttribute('y2', cy + len * Math.sin(angle));
  };
  setHand('hand-hour',   hourAngle, 110);
  setHand('hand-minute', minAngle,  155);
  setHand('hand-second', secAngle,  165);
  const secEl = $('hand-second');
  if (secEl) {
    secEl.setAttribute('x1', cx - 28 * Math.cos(secAngle));
    secEl.setAttribute('y1', cy - 28 * Math.sin(secAngle));
  }
}

function updateClock() {
  if (!state.config) return;
  const now = new Date();
  const tz = state.config.timezone || undefined;
  const parts = new Intl.DateTimeFormat('en-US', { hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true, timeZone: tz }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value || '0';
  const h = get('hour'), mn = get('minute'), s = get('second'), ampm = get('dayPeriod');
  const h12 = parseInt(h);
  const h24 = ampm === 'AM' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
  setText('header-time', `${h}:${mn}:${s} ${ampm}`);
  setText('clock-big', `${h}:${mn}`);
  setText('clock-ampm', ampm);
  setText('clock-minimal-time', `${h}:${mn}`);
  setText('clock-minimal-ampm', ampm);
  updateAnalogHands(h24, parseInt(mn), parseInt(s));
  setText('clock-analog-digital', `${h}:${mn} ${ampm}`);

  const dParts = new Intl.DateTimeFormat('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone: tz }).formatToParts(now);
  const dGet = t => dParts.find(p => p.type === t)?.value || '';
  const dStr = `${dGet('weekday')}, ${dGet('day')} ${dGet('month')} ${dGet('year')}`;
  setText('clock-date-big', dStr);
  setText('clock-minimal-date', dStr);
  setText('clock-analog-date', dStr);
  setText('header-date-str', dStr);
}

// Reload the page once a day at the configured local hour:minute. Cheap,
// reliable workaround for browsers on memory-constrained hardware (Pi,
// Chromebox, fanless mini-PCs) where Chromium accumulates memory over hours
// of dynamic DOM mutation and image swaps. Industry-standard kiosk pattern.
let _lastReloadCheck = 0;
function maybeNightlyReload() {
  const cfg = state.config; if (!cfg) return;
  const hour = Number(cfg.reloadHour);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;   // disabled
  const minute = Math.max(0, Math.min(59, Number(cfg.reloadMinute) || 0));
  const now = new Date();
  if (now.getHours() !== hour || now.getMinutes() !== minute) return;
  // Don't fire twice within the same minute (this function runs every 60s).
  if (Date.now() - _lastReloadCheck < 90 * 1000) return;
  _lastReloadCheck = Date.now();
  console.log(`[signage] nightly reload @ ${hour}:${String(minute).padStart(2,'0')}`);
  // Hard reload — bypasses cache so any code/CSS update gets picked up too.
  setTimeout(() => location.reload(), 500);
}

// Drop messages older than 60 min so the Team Messages zone clears itself
// and gets skipped by the rotation when there's nothing fresh to show.
function expireOldMessages() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const before = state.slackMessages.length;
  state.slackMessages = state.slackMessages.filter(m => !m.timestamp || m.timestamp > cutoff);
  if (state.slackMessages.length !== before) { state.slackIndex = 0; renderSlack(); renderMessageTicker(); }
}

// ── Weather ──────────────────────────────────────────────────────
function startWeather() { fetchWeather(); setInterval(fetchWeather, 15 * 60 * 1000); }
// Apply per-screen size class onto the relevant zones + body. Idempotent —
// safe to call any time the config might have changed.
function applyZoneSizes() {
  const cfg = state.config || {};
  const apply = (id, key, def, sizes) => {
    const el = document.getElementById(id); if (!el) return;
    sizes.forEach(s => el.classList.remove(`size-${s}`));
    el.classList.add(`size-${cfg[key] || def}`);
  };
  apply('zone-weather', 'weatherSize', 'medium', ['small','medium','large','xl']);
  apply('zone-bignum',  'bigNumSize',  'large',  ['small','medium','large','xl']);
  apply('zone-clock',   'clockSize',   'medium', ['small','medium','large','xl']);
  apply('zone-worldclocks', 'worldClockSize', 'medium', ['small','medium','large']);
  apply('zone-sunarc',  'sunArcSize',  'medium', ['small','medium','large','xl']);
  // Header size lives on body so the --header-pad CSS variable cascades to
  // every zone's padding-top.
  const body = document.body;
  ['small','medium','large','xl'].forEach(s => body.classList.remove(`header-size-${s}`));
  body.classList.add(`header-size-${cfg.headerSize || 'medium'}`);
}

async function fetchWeather() {
  const cfg = state.config; if (!cfg) return;
  const loc = (cfg.weatherLocation || 'Sydney').trim();
  const imperial = cfg.weatherUnits === 'imperial';
  const wmoIcon = c => c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 49 ? '🌫️' : c <= 55 ? '🌦️' : c <= 65 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌧️' : c <= 86 ? '❄️' : '⛈️';
  const wmoDesc = c => c === 0 ? 'Clear sky' : c === 1 ? 'Mainly clear' : c === 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c <= 49 ? 'Foggy' : c <= 55 ? 'Drizzle' : c <= 65 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Rain showers' : c <= 86 ? 'Snow showers' : 'Thunderstorm';
  try {
    const geoR = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1`);
    const geo = await geoR.json();
    const place = geo.results?.[0]; if (!place) throw new Error('Location not found');
    const { latitude: lat, longitude: lon, timezone: tz, name: city, country } = place;
    const tu = imperial ? 'fahrenheit' : 'celsius';
    const wu = imperial ? 'mph' : 'kmh';
    const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=${encodeURIComponent(tz || 'auto')}&forecast_days=7&temperature_unit=${tu}&wind_speed_unit=${wu}`;
    const fcR = await fetch(fcUrl);
    if (!fcR.ok) throw new Error(`HTTP ${fcR.status}`);
    const fd = await fcR.json();
    const cur = fd.current;
    const code = cur.weather_code;
    const icon = wmoIcon(code), desc = wmoDesc(code);
    const sfx = imperial ? 'F' : 'C';
    setText('weather-icon', icon);
    setText('weather-temp', `${Math.round(cur.temperature_2m)}°${sfx}`);
    setText('weather-desc', desc);
    setText('weather-location-el', country ? `${city}, ${country}` : city);
    setText('weather-humidity', `${cur.relative_humidity_2m}%`);
    setText('weather-wind', `${Math.round(cur.wind_speed_10m)} ${imperial ? 'mph' : 'km/h'}`);
    setText('weather-feels', `${Math.round(cur.apparent_temperature)}°${sfx}`);
    setText('weather-uv', cur.uv_index ?? '—');
    setText('header-weather-mini', `${icon} ${Math.round(cur.temperature_2m)}°${sfx} · ${desc}`);
    const d = fd.daily;
    if (d) {
      setText('weather-hi', `${Math.round(d.temperature_2m_max[0])}°${sfx}`);
      setText('weather-lo', `${Math.round(d.temperature_2m_min[0])}°${sfx}`);
      setText('weather-sunrise', (d.sunrise[0] || '').split('T')[1] || '—');
      setText('weather-sunset',  (d.sunset[0] || '').split('T')[1] || '—');
      const fcHtml = d.time.slice(1, 4).map((dt, i) => {
        const idx = i + 1;
        const dn = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dt + 'T12:00:00').getDay()];
        return `<div class="fc-day"><div class="fc-name">${dn}</div><div class="fc-icon">${wmoIcon(d.weather_code[idx])}</div><div class="fc-hi">${Math.round(d.temperature_2m_max[idx])}°</div><div class="fc-lo">${Math.round(d.temperature_2m_min[idx])}°</div></div>`;
      }).join('');
      $('weather-forecast').innerHTML = fcHtml;
      updateForecastVisibility();
    }
    markRefreshed('zone-weather');
  } catch (e) {
    setText('weather-desc', 'Weather unavailable');
    setText('header-weather-mini', '—');
  }
}
function updateForecastVisibility() {
  const sec = $('weather-forecast-section');
  if (state.config?.showForecast) sec.classList.add('visible');
  else sec.classList.remove('visible');
}

// ── Shipments / KPI ──────────────────────────────────────────────
function startSheet() { fetchSheetData(); setInterval(fetchSheetData, 5 * 60 * 1000); }
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else { if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch; }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// Sheet data lives here so the admin "discover columns" tooling can poke at
// the same headers the renderer is using.
let _sheetHeaders = [];
let _sheetRows = [];

async function fetchSheetData() {
  const url = state.config?.googleSheetUrl; if (!url) return;
  try {
    let csvUrl = url;
    if (url.includes('docs.google.com/spreadsheets') && !url.includes('output=csv')) {
      const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (m) csvUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
    }
    const r = await fetch(csvUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parsed = parseCsv(await r.text()).map(r => r.map(c => (c || '').trim()));
    if (parsed.length < 2) return;
    _sheetHeaders = parsed[0];
    // Skip rows whose first column (column A) is empty — that's the signal
    // the row is a spacer / total / blank entry rather than a real shipment.
    _sheetRows = parsed.slice(1).filter(r => r[0] && r[0].length);
    renderShipments(_sheetHeaders, _sheetRows);
    renderKPIs(_sheetHeaders, _sheetRows);
    markRefreshed('zone-shipments');
    markRefreshed('zone-kpi');
  } catch (e) {
    $('shipments-body').innerHTML = `<tr><td style="color:#ff5050;text-align:center;padding:30px;">Error: ${escHtml(e.message)}</td></tr>`;
  }
}

// Display labels — strip Salesforce's "Object: Field" prefix so the table
// header reads "Purchase Order" instead of "Purchase Order: Purchase Order".
function shipmentColumnLabel(name) {
  const m = String(name || '').match(/:\s*(.+)$/);
  return (m ? m[1] : name).trim();
}

function renderShipments(headers, data) {
  const cfg = state.config || {};
  // Pick the configured columns (case-insensitive match against actual headers
  // so a small label drift doesn't blank everything). Falls back to the first
  // 6 columns if the config is empty or none match.
  const wanted = (cfg.shipmentsColumns && cfg.shipmentsColumns.length)
    ? cfg.shipmentsColumns
    : headers.slice(0, 6);
  let cols = wanted.map(want => {
    const idx = headers.findIndex(h => h.toLowerCase() === String(want).toLowerCase());
    return idx >= 0 ? { name: headers[idx], idx } : null;
  }).filter(Boolean);
  // If none of the configured columns match the sheet (e.g. default Salesforce
  // labels vs a custom sheet), fall back to the sheet's actual row-1 headers
  // so the table never renders without a header row.
  if (!cols.length) {
    cols = headers.slice(0, 6).map((h, i) => ({ name: h, idx: i }));
  }

  // Build header row.
  const thead = `<tr>${cols.map(c => `<th>${escHtml(shipmentColumnLabel(c.name))}</th>`).join('')}</tr>`;
  $('shipments-head').innerHTML = thead;

  if (!data.length) {
    $('shipments-body').innerHTML = `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--subtext);padding:30px;">No data</td></tr>`;
    return;
  }

  // Up to 12 rows — table will scroll if exceeded by zone height (rarely happens).
  const rowsHtml = data.slice(0, 12).map(row => {
    const cells = cols.map(c => {
      const v = row[c.idx];
      return `<td>${escHtml(v && v.length ? v : '—')}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  $('shipments-body').innerHTML = rowsHtml;
}
function renderKPIs(headers, data) {
  if (state.config?.kpiItems?.length) { renderCustomKpis(); return; }
  // Derive default KPIs from the Salesforce-style PO sheet:
  //   Total POs        = row count
  //   Fully Delivered  = rows where Open Balance Qty == 0
  //   Partial          = rows where 0 < Open Balance Qty < Order Qty
  //   Open / Pending   = rows where Open Balance Qty == Order Qty
  const openIdx  = headers.findIndex(h => /open\s*balance\s*qty/i.test(h));
  const totalIdx = headers.findIndex(h => /^order\s*qty$/i.test(h));
  if (openIdx < 0) return;   // not a recognized shipments sheet — leave KPIs as-is

  let delivered = 0, partial = 0, pending = 0;
  for (const row of data) {
    const open  = parseFloat(row[openIdx]);
    const total = totalIdx >= 0 ? parseFloat(row[totalIdx]) : NaN;
    if (Number.isFinite(open) && open === 0)                                    delivered++;
    else if (Number.isFinite(open) && Number.isFinite(total) && open < total)   partial++;
    else                                                                        pending++;
  }
  renderDefaultKpiGrid();
  setText('kpi-orders', data.length);
  setText('kpi-deliveries', delivered);
  setText('kpi-ontime', partial);
  setText('kpi-pending', pending);
}
function renderDefaultKpiGrid() {
  const g = $('kpi-grid'); if (!g || g.dataset.mode === 'default') return;
  g.dataset.mode = 'default';
  g.innerHTML = `
    <div class="kpi-card"><div class="kpi-val" id="kpi-orders">—</div><div class="kpi-label">Open POs</div></div>
    <div class="kpi-card"><div class="kpi-val" id="kpi-deliveries">—</div><div class="kpi-label">Fully Delivered</div></div>
    <div class="kpi-card"><div class="kpi-val" id="kpi-ontime">—</div><div class="kpi-label">Partial</div></div>
    <div class="kpi-card"><div class="kpi-val" id="kpi-pending">—</div><div class="kpi-label">Pending</div></div>`;
}
function renderCustomKpis() {
  const g = $('kpi-grid'); if (!g) return;
  const items = state.config?.kpiItems || [];
  if (!items.length) { renderDefaultKpiGrid(); return; }
  g.dataset.mode = 'custom';
  g.innerHTML = items.map(k => `
    <div class="kpi-card">
      <div class="kpi-val">${escHtml(k.value || '—')}${k.unit ? ` <span style="font-size:22px;color:var(--subtext);font-weight:300;">${escHtml(k.unit)}</span>` : ''}</div>
      <div class="kpi-label">${escHtml(k.label || '')}</div>
    </div>`).join('');
}

// ── Warehouse Dashboard ──────────────────────────────────────────
// Three Google Sheet feeds (Receiving / Pick / Ship) collapsed into a single
// at-a-glance panel grid. We don't try to interpret the sheet schema — we just
// count rows whose column A is non-empty (same convention as Shipments) and
// surface the latest five column-A values as chips. This makes the dashboard
// resilient to changes in the upstream sheet format.
// `displayColumns` controls what each chip in the panel's "latest" list reads.
// Names match against sheet headers case-insensitively; missing columns fall
// back to column A so a header rename in the sheet doesn't blank the panel.
// Multiple columns are joined with " — ".
const WAREHOUSE_PANELS = [
  { key: 'recv', cfgKey: 'warehouseReceivingUrl', displayColumns: ['Manufacturer DBA', 'Product Name']                                              },
  { key: 'pick', cfgKey: 'warehousePickUrl',      displayColumns: ['Planned Pick Date', 'Inventory Account', 'Picklist', 'Planned Ship Date']       },
  { key: 'ship', cfgKey: 'warehouseShipUrl',      displayColumns: ['Inventory Account', 'Planned Ship Date']                                        },
];

function startWarehouse() {
  refreshWarehouse();
  // 5 min — these sheets are updated by warehouse staff, not real-time systems.
  setInterval(refreshWarehouse, 5 * 60 * 1000);
}

// Same Google Sheets share-URL → CSV transform used by Shipments. Pulled out
// so both call sites stay in sync if Google ever changes the export path.
function googleSheetCsvUrl(url) {
  if (!url) return '';
  if (url.includes('docs.google.com/spreadsheets') && !url.includes('output=csv')) {
    const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
  }
  return url;
}

async function fetchWarehouseSheet(url, displayColumns) {
  const csvUrl = googleSheetCsvUrl(url);
  const r = await fetch(csvUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const parsed = parseCsv(await r.text()).map(row => row.map(c => (c || '').trim()));
  if (parsed.length < 2) return { count: 0, latest: [] };
  const headers = parsed[0];
  // Skip header row (row 1), then keep only rows whose column A is non-empty.
  const rows = parsed.slice(1).filter(r => r[0] && r[0].length);
  // Fuzzy header match — strip every non-alphanumeric character and lowercase
  // both sides. So "Part Number" matches "PartNumber", "PART_NUMBER",
  // "Part #", "Part No.", and "part-number". If a header changes shape in the
  // sheet (added punctuation, casing edits) the chip stays correct.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normalizedHeaders = headers.map(norm);
  const colIndices = [];
  const missing = [];
  for (const name of (displayColumns || [])) {
    const idx = normalizedHeaders.indexOf(norm(name));
    if (idx >= 0) colIndices.push(idx);
    else          missing.push(name);
  }
  // Surface unmatched names in the browser console so the actual sheet
  // headers are obvious when a chip falls back to column A. One log per
  // refresh — not flooding.
  if (missing.length) {
    console.warn('[warehouse] column(s) not found in sheet:', missing, '— sheet headers were:', headers);
  }
  const formatRow = (row) => {
    if (!colIndices.length) return row[0];
    const parts = colIndices.map(i => row[i] || '').filter(Boolean);
    return parts.length ? parts.join(' — ') : row[0];
  };
  // "Latest" = last 5 entries in sheet order. Most warehouse sheets append
  // newest rows at the bottom; if a user prepends, swap to .slice(0,5).
  const latest = rows.slice(-5).map(formatRow).filter(Boolean).reverse();
  return { count: rows.length, latest };
}

function renderWarehousePanel(key, payload, error) {
  const panel = document.querySelector(`.wh-panel[data-panel="${key}"]`);
  if (!panel) return;
  const countEl = panel.querySelector('[data-role="count"]');
  const listEl  = panel.querySelector('[data-role="list"]');
  if (error) {
    if (countEl) countEl.textContent = '—';
    if (listEl)  listEl.innerHTML = `<li class="wh-error">${escHtml(error)}</li>`;
    return;
  }
  if (countEl) countEl.textContent = payload.count.toLocaleString();
  if (listEl) {
    if (!payload.latest.length) {
      listEl.innerHTML = `<li class="wh-empty">No entries</li>`;
    } else {
      listEl.innerHTML = payload.latest.map(v => `<li>${escHtml(v)}</li>`).join('');
    }
  }
}

async function refreshWarehouse() {
  const cfg = state.config || {};
  // No URLs configured at all → leave the placeholder values; the rotation
  // will skip this zone via shouldSkipZone().
  if (!WAREHOUSE_PANELS.some(p => cfg[p.cfgKey])) return;
  await Promise.all(WAREHOUSE_PANELS.map(async ({ key, cfgKey, displayColumns }) => {
    const url = cfg[cfgKey];
    if (!url) {
      renderWarehousePanel(key, { count: 0, latest: [] });
      return;
    }
    try {
      const payload = await fetchWarehouseSheet(url, displayColumns);
      renderWarehousePanel(key, payload);
    } catch (e) {
      renderWarehousePanel(key, null, `Sheet error: ${e.message}`);
    }
  }));
  markRefreshed('zone-warehouse');
}

// ── Messages display ─────────────────────────────────────────────
// Renders every active message as a stacked list (newest at top) so the
// whole conversation is visible at once. Replaces the previous one-message-
// at-a-time carousel that required the rotation to land on this zone N times.
function renderSlack() {
  markRefreshed('zone-slack');
  const msgs = state.slackMessages;
  const empty = $('slack-empty'), content = $('slack-content'), countEl = $('slack-msg-count');
  if (!msgs.length) { empty.style.display = 'block'; content.style.display = 'none'; countEl.textContent = ''; return; }
  empty.style.display = 'none'; content.style.display = 'block';
  content.innerHTML = msgs.map(msg => {
    const sender = msg.sender || msg.from || 'Warehouse';
    const text = msg.body || msg.text || '';
    const ago = msg.timestamp ? Math.round((Date.now() - msg.timestamp) / 60000) : null;
    const agoStr = ago === null ? '' : (ago < 1 ? 'Just now' : `${ago}m ago`);
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const prio = msg.priority || 'info';
    return `<div class="slack-msg prio-${escHtml(prio)}">
      <div class="slack-msg-head">
        <span class="slack-msg-sender">📢 ${escHtml(sender)}</span>
        <span class="slack-msg-time">${escHtml(time)}${agoStr ? ` · ${escHtml(agoStr)}` : ''}</span>
      </div>
      <div class="slack-msg-body">${escHtml(text)}</div>
    </div>`;
  }).join('');
  countEl.textContent = msgs.length === 1 ? '1 message' : `${msgs.length} messages`;
}

// ── Safety ───────────────────────────────────────────────────────
function renderSafety() {
  // Accept both legacy strings and new {text, enabled} objects.
  const all = state.config?.safetyMessages || [];
  const active = all
    .map(x => typeof x === 'string' ? { text: x, enabled: true } : x)
    .filter(x => x && x.text && x.enabled !== false)
    .map(x => x.text);
  if (!active.length) { setText('safety-text', ''); return; }
  setText('safety-text', active[state.safetyIndex % active.length]);
}

// ── Meeting rooms zone ───────────────────────────────────────────
// Polls /api/calendar/rooms/public/:slug and renders one tile per room.
// Refreshes whenever the zone activates AND on a 60s timer once data exists,
// so the page stays accurate even if it sits on this zone for a while.
let _meetingRoomsTimer = null;
async function refreshMeetingRooms() {
  const grid = document.getElementById('meetings-grid');
  if (!grid) return;
  try {
    const r = await fetch(`/api/calendar/rooms/public/${SLUG}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderMeetingRooms(j.rooms || [], j.soonMins || 30);
    markRefreshed('zone-meetings');
  } catch (e) {
    grid.innerHTML = `<div class="trend-empty">Couldn't load room status: ${escHtml(e.message)}</div>`;
  }
  if (!_meetingRoomsTimer) {
    _meetingRoomsTimer = setInterval(refreshMeetingRooms, 60 * 1000);
  }
}
function renderMeetingRooms(rooms, soonMins) {
  const grid = document.getElementById('meetings-grid');
  if (!grid) return;
  if (!rooms.length) {
    grid.innerHTML = '<div class="trend-empty">Configure meeting rooms in admin → Meeting Rooms</div>';
    return;
  }
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  grid.innerHTML = rooms.map(r => {
    const cls = r.status;
    let label = '—', detail = '';
    if (cls === 'busy')    { label = 'In Use';        detail = r.currentEnd ? `Until ${fmtTime(r.currentEnd)}` : ''; }
    else if (cls === 'soon'){ label = 'Upcoming';     detail = r.nextStart  ? `At ${fmtTime(r.nextStart)}`    : ''; }
    else if (cls === 'free'){ label = 'Available';    detail = r.nextStart  ? `Next ${fmtTime(r.nextStart)}`  : 'Open all day'; }
    else if (cls === 'unconfigured') { label = 'No calendar'; }
    else if (cls === 'error')        { label = 'Unavailable'; detail = r.error || ''; }
    return `<div class="room-tile ${cls}">
      <div class="room-name">${escHtml(r.name || 'Room')}</div>
      <div class="room-state">${escHtml(label)}</div>
      <div class="room-detail">${escHtml(detail)}</div>
    </div>`;
  }).join('');
  setText('meetings-updated', `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · "Upcoming" = next ${soonMins} min`);
}

// ── Google Slides zone ───────────────────────────────────────────
// Accepts share, edit, or embed URLs and rebuilds the iframe src so the deck
// auto-plays at the user-configured pace. We only re-set src when the
// effective URL changes — otherwise the iframe would restart from slide 1
// every time the zone activates.
function parseSlidesId(url) {
  if (!url) return null;
  // Common forms:
  //   /presentation/d/{ID}/edit
  //   /presentation/d/{ID}/edit#slide=...
  //   /presentation/d/{ID}/embed?...
  //   /presentation/d/e/{PUBID}/pub
  //   /presentation/d/e/{PUBID}/embed
  let m = url.match(/\/presentation\/d\/e\/([\w-]+)/);
  if (m) return { id: m[1], published: true };
  m = url.match(/\/presentation\/d\/([\w-]+)/);
  if (m) return { id: m[1], published: false };
  return null;
}
function buildSlidesEmbedUrl(url, seconds) {
  const parsed = parseSlidesId(url);
  if (!parsed) return null;
  const delayms = Math.max(1000, Math.round((Number(seconds) || 5) * 1000));
  const base = parsed.published
    ? `https://docs.google.com/presentation/d/e/${parsed.id}/embed`
    : `https://docs.google.com/presentation/d/${parsed.id}/embed`;
  return `${base}?start=true&loop=true&delayms=${delayms}`;
}
function renderSlides() {
  const zone = $('zone-slides');
  const iframe = $('slides-iframe');
  if (!zone || !iframe) return;
  const target = buildSlidesEmbedUrl(state.config?.slidesUrl, state.config?.slidesSeconds);
  if (!target) {
    zone.classList.add('no-slides');
    if (iframe.src) iframe.src = '';
    return;
  }
  zone.classList.remove('no-slides');
  // Compare against current src so we don't reset playback on every zone visit.
  if (iframe.src !== target) iframe.src = target;
}

// ── Door lock status (header) ───────────────────────────────────
// Driven by DOOR_STATUS messages from the server's UniFi Access bridge.
// Also detects state changes vs. the previous snapshot and triggers a 5s
// full-page popup so a passing-by employee sees the change unmissably.
const _doorState = new Map();   // id → { lock, position, name }
let _doorStateSeeded = false;   // skip popup on the very first snapshot

function doorEffectiveState(d) {
  if (d.position === 'open') return 'open';
  return d.lock === 'lock' ? 'locked' : 'unlocked';
}
function doorShortName(d) {
  return String(d.name || 'Door').replace(/\s*Controller$/i, '');
}

function renderDoors(doors) {
  const el = document.getElementById('header-doors');
  if (!doors || !doors.length) { if (el) el.innerHTML = ''; _doorStateSeeded = true; return; }

  // Diff against last snapshot. The very first snapshot only seeds; we don't
  // want a popup avalanche when the page first loads.
  if (_doorStateSeeded) {
    for (const d of doors) {
      const prev = _doorState.get(d.id);
      const nowState = doorEffectiveState(d);
      if (!prev) continue;  // newly-discovered door, no prior to diff against
      const prevState = doorEffectiveState(prev);
      if (prevState !== nowState) {
        console.log('[doors] state change:', doorShortName(d), prevState, '→', nowState);
        showDoorOverlay({ name: doorShortName(d), state: nowState });
        break;  // one popup per batch even if multiple doors changed
      }
    }
  } else {
    console.log('[doors] seeded:', doors.map(d => `${doorShortName(d)}=${doorEffectiveState(d)}`).join(', '));
  }
  for (const d of doors) _doorState.set(d.id, { lock: d.lock, position: d.position, name: d.name });
  _doorStateSeeded = true;

  if (!el) return;
  el.innerHTML = doors.map(d => {
    const cls = doorEffectiveState(d);
    const label = cls === 'open' ? 'OPEN' : cls === 'locked' ? 'LOCKED' : 'UNLOCKED';
    const short = doorShortName(d);
    return `<span class="door-chip ${cls}">`
      + `<span class="dot-led"></span>`
      + `<span class="door-name">${short}</span>`
      + `<span class="door-state">${label}</span>`
      + `</span>`;
  }).join('');
}

// Full-page popup for 5 seconds (matches the messages overlay pattern).
let _doorOverlayTimer = null;
function showDoorOverlay({ name, state }) {
  const overlay = document.getElementById('door-overlay');
  if (!overlay) return;
  const icon = state === 'open' ? '🚪' : state === 'unlocked' ? '🔓' : '🔒';
  const label = state === 'open' ? 'OPEN' : state === 'unlocked' ? 'UNLOCKED' : 'LOCKED';
  setText('door-overlay-icon', icon);
  setText('door-overlay-name', name);
  setText('door-overlay-state', label);
  overlay.classList.remove('state-locked', 'state-unlocked', 'state-open');
  overlay.classList.add('state-' + state, 'active');
  if (_doorOverlayTimer) clearTimeout(_doorOverlayTimer);
  _doorOverlayTimer = setTimeout(() => {
    overlay.classList.remove('active');
    _doorOverlayTimer = null;
  }, 5000);
}

// ── Motivation ───────────────────────────────────────────────────
function renderMotivation() {
  const q = shuffledQuotes[state.motivationIndex % shuffledQuotes.length];
  setText('motivation-text', q.text);
  setText('motivation-author', q.author ? `— ${q.author}` : '');
}

// ── UniFi cameras ────────────────────────────────────────────────
// Camera list is driven by per-screen config (state.config.cameraList).
// If empty, we auto-discover from the server's UniFi Protect proxy and
// render with sensible defaults — admin can then reorder + tweak shapes.
let _autoDiscoveryAttempted = false;
function getActiveCameras() {
  const list = (state.config?.cameraList || []).filter(c => c && c.enabled !== false && c.id);
  return list.map(c => ({ id: c.id, name: c.name || 'Camera', shape: c.shape || 'wide' }));
}
async function autoDiscoverCameras() {
  if (_autoDiscoveryAttempted) return [];
  _autoDiscoveryAttempted = true;
  try {
    const r = await fetch('/api/unifi/cameras');
    if (!r.ok) return [];
    const j = await r.json();
    const cams = Array.isArray(j) ? j : (j.cameras || j.data || []);
    return cams.map((c, i) => ({
      id: c.id, name: c.name || `Camera ${i+1}`, shape: 'wide',
    }));
  } catch (_) { return []; }
}
// Cameras are now proxied through this server (/api/unifi/cameras/:id/snapshot)
// using credentials from the global Settings page. From the browser's POV the
// only thing that matters is that the server-side UniFi config is present.
function unifiConfigured() { const c = state.config; return !!(c && c.unifiHost && c.unifiApiKey); }
async function buildCameraGrid() {
  const grid = $('camera-grid'); if (!grid) return;
  if (!unifiConfigured()) {
    grid.innerHTML = `<div style="color:#666;font-size:18px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;grid-column:1/-1;grid-row:1/-1;">Configure UniFi in admin</div>`;
    return;
  }
  let cams = getActiveCameras();
  // First-time auto-discovery: if no list configured, fetch from server.
  if (!cams.length) {
    grid.innerHTML = `<div style="color:#666;font-size:14px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;grid-column:1/-1;grid-row:1/-1;">Discovering cameras…</div>`;
    cams = await autoDiscoverCameras();
    if (!cams.length) {
      grid.innerHTML = `<div style="color:#666;font-size:14px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;grid-column:1/-1;grid-row:1/-1;">No cameras configured. Open admin → Cameras to set up.</div>`;
      return;
    }
  }
  grid.innerHTML = cams.map(cam =>
    `<div class="cam-cell shape-${escHtml(cam.shape || 'wide')}"><img id="snap-${escHtml(cam.id)}" src="" alt="${escHtml(cam.name)}" onerror="this.style.opacity='0.15'"><div class="cam-label">${escHtml(cam.name)}</div></div>`
  ).join('');
  refreshSnapshots();
}
function snapshotUrl(cam) {
  // Always go through this server's proxy — works for any browser, no
  // separate local proxy required.
  return `/api/unifi/cameras/${encodeURIComponent(cam.id)}/snapshot?ts=${Date.now()}`;
}
function refreshSnapshots() {
  if (!unifiConfigured()) return;
  const cams = getActiveCameras();
  cams.forEach(cam => {
    const img = $(`snap-${cam.id}`); if (!img) return;
    fetch(snapshotUrl(cam), { cache: 'no-store' })
      .then(r => r.ok ? r.blob() : Promise.reject(r.status))
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const old = img.src; img.src = url; img.style.opacity = '1';
        if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
      })
      .catch(() => { img.style.opacity = '0.15'; });
  });
  setText('cam-updated', new Date().toLocaleTimeString());
  markRefreshed('zone-doors');
}
let camRefreshTimer = null;
function startCamRefresh() {
  if (camRefreshTimer) { clearInterval(camRefreshTimer); camRefreshTimer = null; }
  if (!unifiConfigured()) return;
  camRefreshTimer = setInterval(refreshSnapshots, 10000);
}

// ── Zone rotation ────────────────────────────────────────────────
function buildDots() {
  const c = $('zone-dots'); c.innerHTML = '';
  (state.config?.zoneIds || []).forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'dot'; d.id = `dot-${i}`;
    d.onclick = () => goToZone(i, true);
    c.appendChild(d);
  });
}
function goToZone(index, manual = false) {
  const zoneIds = state.config?.zoneIds || [];
  if (!zoneIds.length) return;
  $(zoneIds[state.currentZone])?.classList.remove('active');
  $(`dot-${state.currentZone}`)?.classList.remove('active');
  state.currentZone = ((index % zoneIds.length) + zoneIds.length) % zoneIds.length;
  const zid = zoneIds[state.currentZone];
  $(zid)?.classList.add('active');
  $(`dot-${state.currentZone}`)?.classList.add('active');
  if (zid === 'zone-safety') { state.safetyIndex++; renderSafety(); }
  if (zid === 'zone-motivation') { state.motivationIndex++; renderMotivation(); }
  if (zid === 'zone-slack') renderSlack();   // refresh "5m ago" labels
  if (zid === 'zone-sports-results' || zid === 'zone-sports-upcoming') fetchSportsScores();
  if (zid === 'zone-trends') refreshTrends();
  if (zid === 'zone-stocks-overview') refreshStocksOverview();
  if (zid === 'zone-stocks-bigboard') {
    // Zone just became visible — re-layout the treemap with non-zero size.
    if (state.sp500) renderBigBoardTreemap(); else refreshStocksBigBoard();
  }
  if (zid === 'zone-radar')  initRadar();
  if (zid === 'zone-traffic') updateTrafficMap();
  if (zid === 'zone-worldclocks') renderWorldClocks();
  if (zid === 'zone-sunarc')      renderSunArc();
  if (zid === 'zone-calendar')    renderCalendar();
  if (zid === 'zone-bignum')      renderBigNum();
  if (zid === 'zone-slides')      renderSlides();
  if (zid === 'zone-meetings')    refreshMeetingRooms();
  if (zid === 'zone-warehouse')   refreshWarehouse();
  // Update the global "Last refreshed" badge for the newly-active zone.
  updateLastRefreshedDisplay(zid);
  if (manual) restartRotation();
}
// Whether the rotation should skip past a given zone right now (because it
// has no content to show). Kept here so all skip rules live in one place.
function shouldSkipZone(zid) {
  if (zid === 'zone-slack') {
    // Filter inline by 60-min cutoff so we skip even if expireOldMessages
    // hasn't fired yet — also catches messages that were dismissed in the
    // ticker but still linger in the array because of an event ordering race.
    const cutoff = Date.now() - 60 * 60 * 1000;
    const fresh = (state.slackMessages || []).filter(m => !m.timestamp || m.timestamp > cutoff);
    return fresh.length === 0;
  }
  if (zid === 'zone-sports-results')  return !(state.sportsZoneCounts?.results > 0);
  if (zid === 'zone-sports-upcoming') return !(state.sportsZoneCounts?.upcoming > 0);
  if (zid === 'zone-warehouse') {
    const c = state.config || {};
    return !(c.warehouseReceivingUrl || c.warehousePickUrl || c.warehouseShipUrl);
  }
  if (zid === 'zone-stocks-overview') {
    const cfg = state.config || {};
    const n = (cfg.stockIndices?.length || 0) + (cfg.stockOverviewSymbols?.length || 0);
    return n === 0;
  }
  // The big board now always has content (full S&P 500), so never skip.
  if (zid === 'zone-safety') {
    const all = state.config?.safetyMessages || [];
    const active = all.filter(x => typeof x === 'string' ? true : x?.enabled !== false);
    return active.length === 0;
  }
  return false;
}
function nextZone() {
  const zoneIds = state.config?.zoneIds || [];
  if (!zoneIds.length) return;
  let next = (state.currentZone + 1) % zoneIds.length;
  let safety = zoneIds.length;
  while (safety-- > 0 && shouldSkipZone(zoneIds[next])) {
    next = (next + 1) % zoneIds.length;
    if (next === state.currentZone) break;
  }
  goToZone(next);
}
// Per-zone dwell support: schedule the next advance based on the current zone's
// configured dwell time (falling back to global rotationMs).
function restartRotation() {
  if (state.rotationInterval) { clearTimeout(state.rotationInterval); state.rotationInterval = null; }
  scheduleNext();
}
function scheduleNext() {
  const zoneIds = state.config?.zoneIds || [];
  if (!zoneIds.length) return;
  const zid = zoneIds[state.currentZone];
  const dwell = state.config?.zoneDwell?.[zid];
  const ms = (dwell && dwell >= 3000) ? dwell : (state.rotationMs || 15000);
  state.rotationInterval = setTimeout(() => { nextZone(); scheduleNext(); }, ms);
}

// ── Camera + Message overlays ────────────────────────────────────
let cameraDismissTimer = null;
let _camHls = null;

// rtmp://host[:port]/app/stream  →  http(s)://<browser-host>:8888/app/stream/index.m3u8
// MediaMTX serves HLS on :8888 from the same Docker host the signage is
// served from, so we reuse window.location.hostname.
function rtmpToHlsUrl(url) {
  const m = url.match(/^rtmp:\/\/([^/]+?)(?::\d+)?\/(.+)$/);
  if (!m) return null;
  return `${location.protocol}//${location.hostname}:8888/${m[2]}/index.m3u8`;
}

function showCamera(url) {
  const overlay = $('camera-overlay');
  const iframe  = $('camera-iframe');
  const video   = $('camera-video');
  const ph      = $('camera-placeholder');
  const feedUrl = url || state.config?.cameraUrl;
  console.log('[camera] showCamera', { url, feedUrl, hasOverlay: !!overlay, hasVideo: !!video });
  if (!overlay) { console.warn('[camera] #camera-overlay missing'); return; }

  // Tear down any previous player.
  if (_camHls) { try { _camHls.destroy(); } catch (_) {} _camHls = null; }
  iframe.src = ''; iframe.style.display = 'none';
  if (video) { video.removeAttribute('src'); try { video.load(); } catch (_) {} video.style.display = 'none'; }

  // Decide which player to use.
  let hlsUrl = null;
  if (feedUrl) {
    if (feedUrl.startsWith('rtmp://'))      hlsUrl = rtmpToHlsUrl(feedUrl);
    else if (feedUrl.endsWith('.m3u8'))     hlsUrl = feedUrl;
  }

  if (hlsUrl && video) {
    video.style.display = 'block';
    ph.style.display = 'none';
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari, iOS).
      video.src = hlsUrl;
      video.play().catch(() => {});
    } else if (window.Hls && window.Hls.isSupported()) {
      _camHls = new window.Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 });
      _camHls.loadSource(hlsUrl);
      _camHls.attachMedia(video);
      _camHls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      _camHls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data?.fatal) console.error('[hls] fatal', data.type, data.details);
      });
    } else {
      ph.style.display = 'flex'; ph.style.flexDirection = 'column'; ph.style.alignItems = 'center';
      video.style.display = 'none';
    }
  } else if (feedUrl) {
    iframe.src = feedUrl; iframe.style.display = 'block'; ph.style.display = 'none';
  } else {
    ph.style.display = 'flex'; ph.style.flexDirection = 'column'; ph.style.alignItems = 'center';
  }

  overlay.classList.add('active');
  if (cameraDismissTimer) clearTimeout(cameraDismissTimer);
  // Auto-dismiss after 15s — signage is unattended, no manual close.
  cameraDismissTimer = setTimeout(dismissCamera, 15000);
}
// Show the overlay with a server-proxied Hikvision snapshot polling at ~2 fps.
// payload: { snapshotUrl, label, durationMs, eventType, targetType }
let _camSnapshotTimer = null;
function showCameraSnapshot(payload) {
  const overlay = $('camera-overlay');
  const img     = $('camera-snapshot');
  const iframe  = $('camera-iframe');
  const video   = $('camera-video');
  const ph      = $('camera-placeholder');
  const banner  = $('camera-alert-banner');
  if (!overlay || !img) return;

  // Tear down the other player paths so they don't paint on top.
  if (_camHls) { try { _camHls.destroy(); } catch (_) {} _camHls = null; }
  if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
  if (video)  { video.removeAttribute('src'); try { video.load(); } catch (_) {} video.style.display = 'none'; }
  if (ph) ph.style.display = 'none';

  // Customise the banner text to reflect what fired. Keeps the existing 🚨
  // styling and audio cue from the legacy SHOW_CAMERA path.
  if (banner) {
    const cls = (payload.targetType || '').toString();
    const niceClass = cls
      ? (cls.toLowerCase() === 'person' ? 'PERSON' :
         /vehicle/i.test(cls)            ? 'VEHICLE' : cls.toUpperCase())
      : 'OBJECT';
    const where = payload.label ? ` AT ${String(payload.label).toUpperCase()}` : '';
    banner.innerHTML = `<span class="alert-icon">🚨</span> ${niceClass} DETECTED${where} <span class="alert-icon">🚨</span>`;
  }

  // Snapshot URL with a cache-busting query string. The proxy is server-side
  // so we don't need credentials; the browser just sees fresh JPEGs.
  const baseUrl = payload.snapshotUrl || '/api/hik/snapshot';
  const tickUrl = () => `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
  img.style.display = 'block';
  img.src = tickUrl();
  if (_camSnapshotTimer) clearInterval(_camSnapshotTimer);
  // ~2 fps. The camera + LAN are easily fast enough; if a single fetch fails
  // the next one is only 500 ms behind, so the UX is "live-ish" without RTSP.
  _camSnapshotTimer = setInterval(() => {
    if (!overlay.classList.contains('active')) return;
    img.src = tickUrl();
  }, 500);

  overlay.classList.add('active');
  if (cameraDismissTimer) clearTimeout(cameraDismissTimer);
  const dur = Number(payload.durationMs) > 0 ? Number(payload.durationMs) : 15000;
  cameraDismissTimer = setTimeout(dismissCamera, dur);
}

function dismissCamera() {
  if (cameraDismissTimer) { clearTimeout(cameraDismissTimer); cameraDismissTimer = null; }
  if (_camSnapshotTimer)  { clearInterval(_camSnapshotTimer); _camSnapshotTimer  = null; }
  if (_camHls) { try { _camHls.destroy(); } catch (_) {} _camHls = null; }
  const v = $('camera-video');
  if (v) { v.removeAttribute('src'); try { v.load(); } catch (_) {} v.style.display = 'none'; }
  const img = $('camera-snapshot');
  if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
  $('camera-overlay').classList.remove('active');
  $('camera-iframe').src = '';
}

// ── Persistent message ticker (footer bar) ──────────────────────
// Driven off state.slackMessages so admin "Clear All" automatically empties
// it. Shows messages within the last `messageFooterMinutes` (default 15);
// cycles through them every 8s if more than one is active.
let _tickerCycleTimer = null;
let _tickerExpireTimer = null;
let _tickerIndex = 0;

function activeTickerMessages() {
  const ttlMs = (Number(state.config?.messageFooterMinutes) || 15) * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  return (state.slackMessages || []).filter(m => (m.timestamp || 0) >= cutoff);
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function renderMessageTicker() {
  const active = activeTickerMessages();
  const body = document.body;
  if (!active.length) {
    body.classList.remove('has-ticker');
    if (_tickerCycleTimer) { clearInterval(_tickerCycleTimer); _tickerCycleTimer = null; }
    if (_tickerExpireTimer) { clearTimeout(_tickerExpireTimer); _tickerExpireTimer = null; }
    return;
  }
  body.classList.add('has-ticker');
  _tickerIndex = _tickerIndex % active.length;
  const msg = active[_tickerIndex];
  const bar = document.getElementById('message-ticker');
  if (!bar) return;
  bar.classList.remove('priority-urgent','priority-normal','priority-info');
  bar.classList.add('priority-' + (msg.priority || 'info'));
  const icon = msg.priority === 'urgent' ? '🚨' : msg.priority === 'normal' ? '📢' : 'ℹ️';
  setText('ticker-icon', icon);
  setText('ticker-body', `${msg.sender ? msg.sender + ': ' : ''}${msg.body || msg.text || ''}`);
  setText('ticker-meta', `${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${relativeTime(msg.timestamp)}`);
  setText('ticker-count', active.length > 1 ? `${_tickerIndex + 1} / ${active.length}` : '');

  // Cycle through multiple messages.
  if (_tickerCycleTimer) clearInterval(_tickerCycleTimer);
  if (active.length > 1) {
    _tickerCycleTimer = setInterval(() => {
      _tickerIndex = (_tickerIndex + 1) % activeTickerMessages().length;
      renderMessageTicker();
    }, 8000);
  }
  // Re-check for expiry every 30s so old messages disappear without needing an event.
  if (!_tickerExpireTimer) {
    _tickerExpireTimer = setInterval(renderMessageTicker, 30_000);
  }
}

let msgDismissTimer = null;
function showMessageOverlay(msg) {
  const overlay = $('message-overlay');
  const sender = msg.sender || msg.from || '';
  const text = msg.body || msg.text || '';
  const priority = msg.priority || 'info';
  overlay.classList.remove('priority-urgent', 'priority-normal', 'priority-info');
  overlay.classList.add('priority-' + priority);
  const badge = $('message-priority-badge');
  badge.textContent = ({ urgent: '🚨 Urgent', normal: '✅ Message', info: 'ℹ️ Info' })[priority] || '';
  setText('message-from', sender ? `Message from ${sender}` : 'Message');
  setText('message-body', text);
  overlay.classList.add('active');
  let remaining = Math.max(3, msg.duration || 12);
  setText('message-dismiss-auto', `Auto-dismissing in ${remaining}s`);
  if (msgDismissTimer) clearInterval(msgDismissTimer);
  msgDismissTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) setText('message-dismiss-auto', `Auto-dismissing in ${remaining}s`);
    else { clearInterval(msgDismissTimer); msgDismissTimer = null; setText('message-dismiss-auto', ''); overlay.classList.remove('active'); }
  }, 1000);
}

// ── Audio alerts ─────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { audioCtx = new C(); } catch (_) { return null; }
  }
  return audioCtx;
}
function primeAudio() {
  const c = getAudioCtx();
  if (c && c.state === 'suspended') c.resume().catch(()=>{});
  ['click','keydown','touchstart'].forEach(e => window.removeEventListener(e, primeAudio));
}
['click','keydown','touchstart'].forEach(e => window.addEventListener(e, primeAudio));
function playTone(f, t, dur, gain, type, c) {
  const o = c.createOscillator(), g = c.createGain();
  o.connect(g); g.connect(c.destination);
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.start(t); o.stop(t + dur + 0.05);
}
function playAlertSound(type) {
  try {
    const c = getAudioCtx(); if (!c) return;
    if (c.state === 'suspended') c.resume().catch(()=>{});
    const t = c.currentTime;
    if (type === 'urgent') {
      for (let i = 0; i < 4; i++) { const b = t + i * 0.25; playTone(960, b, 0.11, 0.5, 'square', c); playTone(480, b + 0.13, 0.11, 0.5, 'square', c); }
    } else if (type === 'normal') {
      [523.25,659.25,783.99,1046.5].forEach((f, i) => playTone(f, t + i * 0.18, 0.18, 0.35, 'sine', c));
    } else if (type === 'info') {
      playTone(440, t, 0.2, 0.25, 'sine', c); playTone(550, t + 0.22, 0.3, 0.25, 'sine', c);
    } else if (type === 'camera') {
      for (let i = 0; i < 3; i++) { const b = t + i * 0.28; playTone(880, b, 0.12, 0.4, 'square', c); playTone(440, b + 0.14, 0.12, 0.4, 'square', c); }
    } else { playTone(523.25, t, 0.18, 0.3, 'sine', c); }
  } catch (_) {}
}

// ── Sports ───────────────────────────────────────────────────────
// ESPN serves league logos at predictable URLs. We use the 500px PNG variants;
// the layout shrinks them via CSS. logo is fallback-friendly: if the URL
// fails to load, the .sports-league-title styles still display the text label.
const ESPN_LOGO = (slug) => `https://a.espncdn.com/i/teamlogos/leagues/500/${slug}.png`;
const SPORTS_LEAGUES = [
  { id: 'nfl',  sport: 'football',   league: 'nfl',       label: 'NFL',     emoji: '🏈', logo: ESPN_LOGO('nfl') },
  { id: 'cfb',  sport: 'football',   league: 'college-football', label: 'NCAAF', emoji: '🏈', logo: ESPN_LOGO('ncaa') },
  { id: 'nhl',  sport: 'hockey',     league: 'nhl',       label: 'NHL',     emoji: '🏒', logo: ESPN_LOGO('nhl') },
  { id: 'nba',  sport: 'basketball', league: 'nba',       label: 'NBA',     emoji: '🏀', logo: ESPN_LOGO('nba') },
  { id: 'wnba', sport: 'basketball', league: 'wnba',      label: 'WNBA',    emoji: '🏀', logo: ESPN_LOGO('wnba') },
  { id: 'cbb',  sport: 'basketball', league: 'mens-college-basketball', label: 'NCAAM', emoji: '🏀', logo: ESPN_LOGO('ncaa') },
  { id: 'mlb',  sport: 'baseball',   league: 'mlb',       label: 'MLB',     emoji: '⚾', logo: ESPN_LOGO('mlb') },
  { id: 'mls',  sport: 'soccer',     league: 'usa.1',     label: 'MLS',     emoji: '⚽', logo: ESPN_LOGO('mls') },
  { id: 'epl',  sport: 'soccer',     league: 'eng.1',     label: 'EPL',     emoji: '⚽', logo: ESPN_LOGO('eng.1') },
  { id: 'lal',  sport: 'soccer',     league: 'esp.1',     label: 'La Liga', emoji: '⚽', logo: ESPN_LOGO('esp.1') },
  { id: 'ucl',  sport: 'soccer',     league: 'uefa.champions', label: 'UCL', emoji: '⚽', logo: ESPN_LOGO('uefa.champions') },
  { id: 'f1',   sport: 'racing',     league: 'f1',        label: 'F1',      emoji: '🏎️', logo: ESPN_LOGO('f1') },
  { id: 'pga',  sport: 'golf',       league: 'pga',       label: 'PGA',     emoji: '⛳', logo: ESPN_LOGO('pga') },
];
function startSports() { fetchSportsScores(); setInterval(fetchSportsScores, 2 * 60 * 1000); }
function espnDate(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
// Tracks which sports zones have content so the rotation can skip empties
// and so we can consolidate into one zone when the total game count is small.
state.sportsZoneCounts = { results: 0, upcoming: 0, combined: 0 };

async function fetchSportsScores() {
  const now = new Date();
  // Pull a wider window so we have both yesterday's finals and tomorrow's games.
  const back = new Date(now - 36 * 60 * 60 * 1000);
  const fwd  = new Date(now + 36 * 60 * 60 * 1000);
  const dates = `${espnDate(back)}-${espnDate(fwd)}`;
  // Filter to user-enabled leagues. Default = all if config absent.
  const enabled = (state.config?.sportsLeagues && state.config.sportsLeagues.length)
    ? new Set(state.config.sportsLeagues)
    : null;
  const showOdds = !!state.config?.sportsShowOdds;
  const activeLeagues = enabled ? SPORTS_LEAGUES.filter(l => enabled.has(l.id)) : SPORTS_LEAGUES;
  // limit caps total events across the whole date range, not per day. MLB and
  // college football can have 15+ games/day, so a low cap returned the earliest
  // day's games only — already too old for the results bucket and not 'pre'
  // enough for upcoming, leaving those zones empty.
  const results = await Promise.allSettled(activeLeagues.map(async lg => {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${lg.sport}/${lg.league}/scoreboard?dates=${dates}&limit=200`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { lg, events: (await r.json()).events || [] };
  }));
  // Bucket each event into "results" (live or final) vs "upcoming" (pre,
  // in the next 24h). Two zones own one bucket each:
  //   - zone-sports-results  (last ~24h of finals + currently-live)
  //   - zone-sports-upcoming (next ~24h of scheduled games)
  const byBucket = { results: [], upcoming: [] }; // each entry = { lg, events: [...] }
  let totalGames = 0;
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    const { lg, events } = res.value;
    const finals = [], upcomings = [];
    for (const ev of events) {
      const s = ev.status?.type?.state;
      const dt = new Date(ev.date);
      if (s === 'in' || s === 'post') {
        // Only include finals from the last 24h to keep the list fresh.
        if ((now - dt) <= 36 * 60 * 60 * 1000) finals.push(ev);
      } else if (s === 'pre') {
        if ((dt - now) <= 24 * 60 * 60 * 1000 && (dt - now) > -10 * 60 * 1000) upcomings.push(ev);
      }
    }
    // No per-league cap — show every game. The tile grid wraps to as many
    // rows as needed; CSS density class keeps tiles readable for the count.
    if (finals.length)    { byBucket.results.push({ lg, events: finals });    totalGames += finals.length; }
    if (upcomings.length) { byBucket.upcoming.push({ lg, events: upcomings }); totalGames += upcomings.length; }
  }

  // Renders one "league section" string from a {lg, events} entry.
  const renderLeague = (lg, evs) => {
    const games = evs.map(ev => {
      const comp = ev.competitions?.[0]; if (!comp) return '';
      const cs = comp.competitors || [];
      const st = ev.status?.type;
      const isLive = st?.state === 'in', isFinal = st?.state === 'post';
      const away = cs.find(c => c.homeAway === 'away') || cs[0];
      const home = cs.find(c => c.homeAway === 'home') || cs[1];
      if (!away || !home) return '';
      const aS = parseInt(away.score) || 0, hS = parseInt(home.score) || 0;
      const aW = isFinal && aS > hS, hW = isFinal && hS > aS;
      const aA = away.team?.abbreviation || '???', hA = home.team?.abbreviation || '???';
      const aL = away.team?.logo, hL = home.team?.logo;
      const lH = (url, abb) => url ? `<img src="${escHtml(url)}" style="width:28px;height:28px;object-fit:contain;" onerror="this.style.display='none'">` : `<span style="width:28px;height:28px;display:inline-block;font-size:10px;font-weight:700;color:var(--subtext);">${escHtml(abb.slice(0,2))}</span>`;
      const score = (s, w) => (isFinal||isLive) ? `<span class="sports-team-score ${w?'win':''}">${s}</span>` : '<span class="sports-team-score">–</span>';
      const status = isLive ? `<div class="sports-game-status live">🔴 ${escHtml(st?.shortDetail||'')}</div>` :
                     isFinal ? `<div class="sports-game-status final">Final</div>` :
                     `<div class="sports-game-status upcoming">${escHtml(new Date(ev.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</div>`;
      // Betting odds — only for upcoming games and only if user opted in.
      let oddsHtml = '';
      if (showOdds && !isLive && !isFinal) {
        const od = comp.odds && comp.odds[0];
        if (od) {
          const parts = [];
          if (od.details)   parts.push(`<span class="odds-spread">${escHtml(od.details)}</span>`);
          if (od.overUnder) parts.push(`<span class="odds-ou">O/U ${od.overUnder}</span>`);
          if (parts.length) oddsHtml = `<div class="sports-odds">${parts.join(' · ')}</div>`;
        }
      }
      return `<div class="sports-game ${isLive?'live-game':''}">${status}<div class="sports-teams"><div class="sports-team ${aW?'winner':''}">${lH(aL,aA)}<span class="sports-team-name">${escHtml(aA)}</span>${score(aS,aW)}</div><div class="sports-team ${hW?'winner':''}">${lH(hL,hA)}<span class="sports-team-name">${escHtml(hA)}</span>${score(hS,hW)}</div></div>${oddsHtml}</div>`;
    }).filter(Boolean).join('');
    const titleInner = lg.logo
      ? `<img class="league-logo" src="${escHtml(lg.logo)}" alt="${escHtml(lg.label)}" onerror="this.outerHTML='${escHtml(lg.emoji)} '+'${escHtml(lg.label)}'">`
      : `${escHtml(lg.emoji)} ${escHtml(lg.label)}`;
    return games ? `<div class="sports-league"><div class="sports-league-title">${titleInner}</div><div class="sports-games">${games}</div></div>` : '';
  };
  const renderBucket = (entries) => entries.map(({ lg, events: evs }) => renderLeague(lg, evs)).join('');
  const empty = '<div style="color:var(--subtext);font-size:20px;font-weight:200;text-align:center;padding:40px 0;">No games to show.</div>';
  const stamp = `Updated: ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;

  const resultsCount  = byBucket.results.reduce((n, b) => n + b.events.length, 0);
  const upcomingCount = byBucket.upcoming.reduce((n, b) => n + b.events.length, 0);

  // Tag each container with a layout class. 'auto' picks tile size based
  // on count so the whole league stack fills the zone; explicit layouts
  // ('compact'/'standard'/'large'/'hero') force a fixed tile size.
  const layout = state.config?.sportsLayout || 'auto';
  const setDensity = (el, count) => {
    if (!el) return;
    el.classList.remove('layout-auto-xl', 'layout-auto-lg', 'layout-auto-md', 'layout-auto-sm',
                        'layout-compact', 'layout-standard', 'layout-large', 'layout-hero');
    if (layout === 'auto') {
      if (count <= 2)      el.classList.add('layout-auto-xl');
      else if (count <= 4) el.classList.add('layout-auto-lg');
      else if (count <= 8) el.classList.add('layout-auto-md');
      else                 el.classList.add('layout-auto-sm');
    } else {
      el.classList.add(`layout-${layout}`);
    }
  };

  // Each zone strictly shows only its own bucket. Empty zones
  // get skipped automatically by the rotation via shouldSkipZone().
  const rEl = $('sports-results-leagues');
  const uEl = $('sports-upcoming-leagues');
  if (rEl) rEl.innerHTML = renderBucket(byBucket.results)  || empty;
  if (uEl) uEl.innerHTML = renderBucket(byBucket.upcoming) || empty;
  setDensity(rEl, resultsCount);
  setDensity(uEl, upcomingCount);
  state.sportsZoneCounts = { results: resultsCount, upcoming: upcomingCount, combined: totalGames };
  setText('sports-results-updated',  stamp);
  setText('sports-upcoming-updated', stamp);
  markRefreshed('zone-sports-results');
  markRefreshed('zone-sports-upcoming');
}

// ── Stocks ───────────────────────────────────────────────────────
// Two zones share one fetch: the "markets" overview row and the big-board
// grid. Symbols are deduped before hitting the server-side proxy so each
// price is fetched once even if both zones include it.
const STOCK_INDEX_LABELS = {
  '^DJI':      'DOW',
  '^IXIC':     'NASDAQ',
  '^GSPC':     'S&P 500',
  '^RUT':      'RUSSELL 2000',
  'DX-Y.NYB':  'US DOLLAR',
  'DX=F':      'US DOLLAR',
  'BTC-USD':   'BITCOIN',
  'ETH-USD':   'ETHEREUM',
  'GC=F':      'GOLD',
  'SI=F':      'SILVER',
  'CL=F':      'OIL (WTI)',
  'BZ=F':      'OIL (BRENT)',
  '^VIX':      'VIX',
  '^FTSE':     'FTSE 100',
  '^N225':     'NIKKEI 225',
  '^HSI':      'HANG SENG',
  '^GDAXI':    'DAX',
};

function startStocks() {
  refreshStocksOverview();
  refreshStocksBigBoard();
  // Markets overview is live (BTC + indices); big board snapshot only updates
  // server-side at market open / mid-day / close, so a 5-min client poll is
  // plenty to pick up the new snapshot quickly.
  setInterval(refreshStocksOverview, 60 * 1000);
  setInterval(refreshStocksBigBoard, 5 * 60 * 1000);
  // Re-layout the treemap on viewport changes (orientation flip, font load).
  window.addEventListener('resize', () => { renderBigBoardTreemap(); });
}

// Canonical order — keeps sector blocks in the same on-screen position from
// one render to the next, even as weights shift.
const GICS_SECTOR_ORDER = [
  'Information Technology',
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Health Care',
  'Financials',
  'Industrials',
  'Energy',
  'Utilities',
  'Materials',
  'Real Estate',
];

function fmtPrice(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1)    return n.toFixed(2);
  return n.toFixed(4);
}

function fmtSignedPrice(n) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return sign + fmtPrice(Math.abs(n));
}

// ── Markets overview (small list of indices + extra tickers) ─────
async function refreshStocksOverview() {
  const cfg = state.config || {};
  const indices = (cfg.stockIndices && cfg.stockIndices.length) ? cfg.stockIndices : [];
  const ovExtra = cfg.stockOverviewSymbols || [];
  const overviewSymbols = [...indices, ...ovExtra];
  if (!overviewSymbols.length) return;

  let quotes;
  try {
    const r = await fetch(`/api/stocks/quotes?symbols=${encodeURIComponent(overviewSymbols.join(','))}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    quotes = (await r.json()).quotes || [];
  } catch (e) {
    return;
  }
  const bySymbol = new Map(quotes.map(q => [q.symbol, q]));

  const ovEl = $('stocks-overview-list');
  if (!ovEl) return;
  ovEl.innerHTML = overviewSymbols.map(sym => {
    const q = bySymbol.get(sym);
    const label = STOCK_INDEX_LABELS[sym] || (q?.name && q.name.length <= 24 ? q.name : sym);
    if (!q || q.error) {
      return `<div class="stock-row flat">
        <div class="stock-label">${escHtml(label)}</div>
        <div class="stock-price">—</div>
        <div class="stock-change">—</div>
      </div>`;
    }
    const ch = q.change ?? 0;
    const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat';
    const arrow = ch > 0 ? '▲' : ch < 0 ? '▼' : '•';
    const pct = q.changePercent != null ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : '—';
    return `<div class="stock-row ${cls}">
      <div class="stock-label">${escHtml(label)}</div>
      <div class="stock-price">${escHtml(fmtPrice(q.price))}</div>
      <div class="stock-change">${arrow} ${escHtml(pct)}</div>
    </div>`;
  }).join('');
  setText('stocks-overview-updated', `Updated: ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`);
  markRefreshed('zone-stocks-overview');
}

// ── Big board: full S&P 500 sector treemap ────────────────────────
// state.sp500 caches the latest payload so a layout-only re-render (e.g. on
// resize, or when the zone first becomes visible) doesn't trigger a refetch.
state.sp500 = null;

async function refreshStocksBigBoard() {
  try {
    const r = await fetch('/api/stocks/sp500', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.sp500 = j.stocks || [];
    state.sp500At = j.snapshotAt || Date.now();
    state.sp500Session = j.snapshotSession || null;
  } catch (e) {
    return;
  }
  renderBigBoardTreemap();
}

const SP500_SESSION_LABEL = {
  open:   'Market Open',
  midday: 'Mid-Day',
  close:  'Market Close',
  boot:   '',   // boot-time pre-warm has no nice label
};

// Squarified treemap (Bruls et al.). Returns absolute-positioned rects that
// fill the {x,y,w,h} container, sized by each item's `value`.
function squarify(items, x, y, w, h) {
  if (!items.length || w <= 0 || h <= 0) return [];
  const sorted = [...items].sort((a, b) => b.value - a.value).filter(i => i.value > 0);
  if (!sorted.length) return [];
  const totalValue = sorted.reduce((s, i) => s + i.value, 0);
  const scale = (w * h) / totalValue;
  const out = [];

  let remaining = sorted.map(it => ({ ref: it, area: it.value * scale }));
  let cx = x, cy = y, cw = w, ch = h;

  const worstAspect = (sumArea, row, side) => {
    const stripDim = sumArea / side;
    let worst = 1;
    for (const it of row) {
      const itDim = it.area / stripDim;
      const ar = Math.max(itDim, stripDim) / Math.max(0.0001, Math.min(itDim, stripDim));
      if (ar > worst) worst = ar;
    }
    return worst;
  };

  while (remaining.length) {
    const side = Math.min(cw, ch);
    if (side <= 0) break;
    let row = [remaining[0]];
    let rowSum = remaining[0].area;
    let bestRatio = worstAspect(rowSum, row, side);
    let i = 1;
    for (; i < remaining.length; i++) {
      const next = remaining[i];
      const newSum = rowSum + next.area;
      const newRow = row.concat([next]);
      const newRatio = worstAspect(newSum, newRow, side);
      if (newRatio > bestRatio) break;
      row = newRow;
      rowSum = newSum;
      bestRatio = newRatio;
    }

    if (cw >= ch) {
      const colW = rowSum / ch;
      let py = cy;
      for (const it of row) {
        const itH = it.area / colW;
        out.push({ x: cx, y: py, w: colW, h: itH, ref: it.ref });
        py += itH;
      }
      cx += colW; cw -= colW;
    } else {
      const rowH = rowSum / cw;
      let px = cx;
      for (const it of row) {
        const itW = it.area / rowH;
        out.push({ x: px, y: cy, w: itW, h: rowH, ref: it.ref });
        px += itW;
      }
      cy += rowH; ch -= rowH;
    }
    remaining = remaining.slice(row.length);
  }
  return out;
}

// Pick a tile background colour from change percent. Capped at ±3% so the
// extremes don't all look identical to a 10% mover. Magenta-ish = no data.
function bbTileColor(changePct) {
  if (changePct == null || !isFinite(changePct)) return 'rgba(120,120,140,0.25)';
  const pct = Math.max(-3, Math.min(3, changePct));
  if (Math.abs(pct) < 0.05) return 'rgba(80,90,110,0.55)';
  const intensity = Math.min(1, Math.abs(pct) / 3);   // 0..1
  if (pct > 0) {
    // Green: blend toward bright #16c784
    const a = 0.30 + intensity * 0.55;
    return `rgba(22, 199, 132, ${a.toFixed(3)})`;
  } else {
    const a = 0.30 + intensity * 0.55;
    return `rgba(234, 57, 67, ${a.toFixed(3)})`;
  }
}

function renderBigBoardTreemap() {
  const bbEl = $('stocks-bigboard-grid');
  if (!bbEl) return;
  const stocks = state.sp500;
  if (!stocks || !stocks.length) {
    bbEl.innerHTML = '<div class="trend-empty">Loading S&amp;P 500…</div>';
    return;
  }
  const cfg = state.config || {};
  const mode = cfg.stockBigBoardMode === 'dollar' ? 'dollar' : 'percent';
  setText('stocks-bigboard-mode-tag', mode === 'dollar' ? 'BY $ CHANGE' : 'BY % CHANGE');

  // Container size is required for layout. If hidden (display:none on a
  // non-active zone) the rect is 0×0 — defer until the zone becomes active.
  const rect = bbEl.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) return;
  const W = rect.width, H = rect.height;

  // Group by sector and sum weights for the top-level treemap.
  const bySector = new Map();
  for (const s of stocks) {
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(s);
  }
  const sectors = GICS_SECTOR_ORDER
    .filter(name => bySector.has(name))
    .concat([...bySector.keys()].filter(name => !GICS_SECTOR_ORDER.includes(name)))
    .map(name => {
      const list = bySector.get(name);
      const value = list.reduce((s, x) => s + (x.weight || 0), 0);
      return { name, list, value };
    });

  const sectorRects = squarify(sectors, 0, 0, W, H);
  const SECTOR_LABEL_H = 22;
  const TILE_GAP = 1;

  let html = '';
  for (const sr of sectorRects) {
    const sec = sr.ref;
    // Sector wrapper — relative-positioned, with label band on top.
    html += `<div class="bb-sector" style="left:${sr.x}px;top:${sr.y}px;width:${sr.w}px;height:${sr.h}px;">
      <div class="bb-sector-label">${escHtml(sec.name.toUpperCase())}</div>
      <div class="bb-sector-tiles" style="width:${sr.w}px;height:${Math.max(0, sr.h - SECTOR_LABEL_H)}px;">`;
    const items = sec.list.map(s => ({ ...s, value: s.weight || 0 }));
    const tileRects = squarify(items, 0, 0, sr.w, Math.max(0, sr.h - SECTOR_LABEL_H));
    for (const tr of tileRects) {
      const s = tr.ref;
      const color = bbTileColor(s.changePercent);
      const tw = Math.max(0, tr.w - TILE_GAP);
      const th = Math.max(0, tr.h - TILE_GAP);
      // Choose what fits: full tile shows symbol + price + change; medium
      // drops the price; tiny tiles show just the symbol.
      const showLines = tw >= 60 && th >= 50 ? 3 : (tw >= 40 && th >= 30 ? 2 : 1);
      // Symbol size scales with the smaller dimension so big tiles draw bold.
      const symFs = Math.max(8, Math.min(28, Math.floor(Math.min(tw, th) * 0.32)));
      const subFs = Math.max(8, Math.min(16, Math.floor(symFs * 0.55)));
      const ch = s.change ?? 0;
      const arrow = ch > 0 ? '▲' : ch < 0 ? '▼' : '';
      const display = s.changePercent == null
        ? '—'
        : (mode === 'dollar'
            ? fmtSignedPrice(s.change)
            : `${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%`);
      html += `<div class="bb-tm-tile" style="left:${tr.x}px;top:${tr.y}px;width:${tw}px;height:${th}px;background:${color};">`;
      html += `<div class="bb-tm-symbol" style="font-size:${symFs}px;">${escHtml(s.symbol)}</div>`;
      if (showLines >= 3) html += `<div class="bb-tm-price" style="font-size:${Math.floor(subFs * 0.85)}px;">${escHtml(fmtPrice(s.price))}</div>`;
      if (showLines >= 2) html += `<div class="bb-tm-change" style="font-size:${subFs}px;">${escHtml(arrow)} ${escHtml(display)}</div>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  bbEl.innerHTML = html;
  // Show the *snapshot* time, not the poll time, since the data only updates
  // 3x per trading day (open / mid-day / close).
  if (state.sp500At) {
    const when = new Date(state.sp500At).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const session = SP500_SESSION_LABEL[state.sp500Session];
    setText('stocks-bigboard-updated', session ? `${session} · ${when}` : `Snapshot · ${when}`);
    markRefreshed('zone-stocks-bigboard', state.sp500At);
  }
}

// ── Trends ───────────────────────────────────────────────────────
function startTrends() { refreshTrends(); setInterval(refreshTrends, 10 * 60 * 1000); }
async function fetchNewsHeadlines() {
  try {
    const c = (state.config?.trendsCountry || 'US').toUpperCase();
    const rss = encodeURIComponent(`https://news.google.com/rss?hl=en-${c}&gl=${c}&ceid=${c}:en`);
    const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rss}`);
    if (!r.ok) throw 0;
    const j = await r.json();
    const items = (j.items || []).map(it => ({
      title: (it.title || '').replace(/\s*-\s*[^-]+$/, '').trim(),
      source: (it.author || (it.title || '').match(/-\s*([^-]+)$/)?.[1] || '').trim(),
    }));
    renderTrendsHero('trends-news', items, it => it.title, it => it.source);
  } catch (_) { $('trends-news').innerHTML = '<div class="trend-empty">Headlines unavailable.</div>'; }
}
// Hero-card layout: first item gets a big card, the rest stack below it.
function renderTrendsHero(elId, items, getText, getMeta) {
  const el = $(elId); if (!el) return;
  if (!items?.length) { el.innerHTML = '<div class="trend-empty">No data.</div>'; return; }
  const top = items[0];
  const rest = items.slice(1, 8);
  el.innerHTML = `
    <div class="trend-hero">
      <div class="label">Top Story</div>
      <div class="title">${escHtml(getText(top))}</div>
      ${getMeta(top) ? `<div class="src">${escHtml(getMeta(top))}</div>` : ''}
    </div>
    ${rest.map((it, i) => `
      <div class="trend-item" style="animation-delay:${i * 60}ms;">
        <div class="trend-rank">${i + 2}.</div>
        <div>
          <div>${escHtml(getText(it))}</div>
          ${getMeta(it) ? `<div style="font-size:12px;color:var(--subtext);margin-top:3px;">${escHtml(getMeta(it))}</div>` : ''}
        </div>
      </div>
    `).join('')}
  `;
}
async function fetchGoogleTrends() {
  try {
    const c = (state.config?.trendsCountry || 'US').toUpperCase();
    const rss = encodeURIComponent(`https://trends.google.com/trending/rss?geo=${c}`);
    const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rss}`);
    if (!r.ok) throw 0;
    const j = await r.json();
    const items = (j.items || []).map(it => ({
      query: (it.title || '').trim(),
      traffic: (it.description || '').match(/\d+[,.\d]*\+?\s*(searches)?/i)?.[0] || '',
    }));
    renderTrendsHero('trends-google', items, it => it.query, it => it.traffic);
  } catch (_) { $('trends-google').innerHTML = '<div class="trend-empty">Google Trends unavailable.</div>'; }
}
function refreshTrends() { fetchNewsHeadlines(); fetchGoogleTrends(); setText('trends-updated', `Updated: ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`); markRefreshed('zone-trends'); }

// ── Google Maps loader (radar + traffic share one key) ───────────
let gMapsPromise = null;
function loadGoogleMaps() {
  if (!state.config?.googleMapsApiKey) return Promise.reject(new Error('Google Maps API key not configured'));
  if (gMapsPromise) return gMapsPromise;
  gMapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(window.google); return; }
    const cb = '__gmReady_' + Math.random().toString(36).slice(2);
    window[cb] = () => { delete window[cb]; resolve(window.google); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.config.googleMapsApiKey)}&callback=${cb}&v=weekly`;
    s.async = true; s.defer = true;
    s.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(s);
  });
  return gMapsPromise;
}
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0b1220' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b1220' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#7d8590' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#e6edf3' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3544' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3b4a5c' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#06101c' }] },
];

// ── Radar (Google base + NEXRAD overlay) ─────────────────────────
let radarMap = null, radarOverlay = null, radarRefreshTimer = null;
async function initRadar() {
  const el = $('radar-map'); if (!el) return;
  if (!state.config?.googleMapsApiKey) {
    el.innerHTML = '<div style="color:var(--subtext);padding:60px;text-align:center;font-size:16px;">Configure Google Maps API key in admin</div>';
    return;
  }
  try {
    const google = await loadGoogleMaps();
    const cfg = state.config;
    setText('radar-station-label', cfg.radarLabel || '');
    if (!radarMap) {
      radarMap = new google.maps.Map(el, {
        center: { lat: cfg.radarLat, lng: cfg.radarLon }, zoom: 8,
        disableDefaultUI: true, gestureHandling: 'none', styles: DARK_MAP_STYLE,
      });
    } else { radarMap.setCenter({ lat: cfg.radarLat, lng: cfg.radarLon }); }
    // ImageMapType is removed via overlayMapTypes.clear(), not setMap()
    if (radarOverlay) { radarMap.overlayMapTypes.clear(); radarOverlay = null; }
    const tileFn = (coord, zoom) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${zoom}/${coord.x}/${coord.y}.png?ts=${Math.floor(Date.now()/(5*60*1000))}`;
    radarOverlay = new google.maps.ImageMapType({ getTileUrl: tileFn, tileSize: new google.maps.Size(256, 256), opacity: 0.7 });
    radarMap.overlayMapTypes.insertAt(0, radarOverlay);
    markRefreshed('zone-radar');
    if (radarRefreshTimer) clearInterval(radarRefreshTimer);
    radarRefreshTimer = setInterval(() => {
      if (!radarMap) return;
      radarMap.overlayMapTypes.clear();
      radarOverlay = new google.maps.ImageMapType({ getTileUrl: tileFn, tileSize: new google.maps.Size(256, 256), opacity: 0.7 });
      radarMap.overlayMapTypes.insertAt(0, radarOverlay);
      markRefreshed('zone-radar');
    }, 3 * 60 * 1000);
  } catch (e) {
    el.innerHTML = `<div style="color:var(--subtext);padding:60px;text-align:center;">Radar unavailable: ${escHtml(e.message)}</div>`;
  }
}

// ── Traffic (Google base + TrafficLayer) ─────────────────────────
let trafficMap = null, trafficLayer = null;
async function updateTrafficMap() {
  const el = $('traffic-map'); if (!el) return;
  setText('traffic-label-display', state.config?.trafficLabel || '');
  if (!state.config?.googleMapsApiKey) {
    el.innerHTML = '<div style="color:var(--subtext);padding:60px;text-align:center;font-size:16px;">Configure Google Maps API key in admin</div>';
    return;
  }
  try {
    const google = await loadGoogleMaps();
    const cfg = state.config;
    if (!trafficMap) {
      trafficMap = new google.maps.Map(el, {
        center: { lat: cfg.trafficLat, lng: cfg.trafficLon }, zoom: cfg.trafficZoom || 11,
        disableDefaultUI: true, gestureHandling: 'none', styles: DARK_MAP_STYLE,
      });
    } else {
      trafficMap.setCenter({ lat: cfg.trafficLat, lng: cfg.trafficLon });
      trafficMap.setZoom(cfg.trafficZoom || 11);
    }
    if (!trafficLayer) { trafficLayer = new google.maps.TrafficLayer(); trafficLayer.setMap(trafficMap); }
    markRefreshed('zone-traffic');
  } catch (e) {
    el.innerHTML = `<div style="color:var(--subtext);padding:60px;text-align:center;">Traffic unavailable: ${escHtml(e.message)}</div>`;
  }
}

// ── World Clocks (over a dotted world map) ───────────────────────
// Map uses a tight equirectangular projection from latTop=84°N to latBot=-58°S
// (Antarctica trimmed). Both the dot grid and the city pins use this same
// range so they line up perfectly.
function renderWorldClocks() {
  const svg = $('worldclocks-map');
  const overlay = $('worldclocks-overlay');
  if (!svg || !overlay) return;

  const latTop = window.WORLD_DOT_LAT_TOP ?? 84;
  const latBot = window.WORLD_DOT_LAT_BOT ?? -58;
  const latSpan = latTop - latBot;

  // Build the dotted-map SVG once.
  if (!svg.dataset.mapDrawn && window.WORLD_DOTS_PACKED) {
    const cols = window.WORLD_DOT_COLS;
    const rows = window.WORLD_DOT_ROWS;
    const W = 1000, H = Math.round(1000 * latSpan / 360);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let dotMarkup = '';
    for (const p of window.WORLD_DOTS_PACKED) {
      const c = Math.floor(p / rows), r = p % rows;
      const x = ((c + 0.5) / cols) * W;
      const y = ((r + 0.5) / rows) * H;
      dotMarkup += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5"/>`;
    }
    // Fully transparent — the zone's --bg shows through. Just the dots.
    svg.innerHTML = `<g fill="rgba(120,160,220,0.7)">${dotMarkup}</g>`;
    svg.dataset.mapDrawn = '1';
    svg.dataset.maph = String(H);
  }

  const list = state.config?.worldClocks || [];
  if (!list.length) {
    overlay.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--subtext);font-size:18px;">Add cities in the World Clocks tab</div>';
    return;
  }

  // Project each city into the same tight band so pins land where you'd expect.
  overlay.innerHTML = list.map((c, i) => {
    const lat = (typeof c.lat === 'number') ? c.lat : window.CITY_LATLON?.[(c.label || '').toLowerCase()]?.lat;
    const lon = (typeof c.lon === 'number') ? c.lon : window.CITY_LATLON?.[(c.label || '').toLowerCase()]?.lon;
    if (lat == null || lon == null) return '';
    const xPct = ((Number(lon) + 180) / 360) * 100;
    // Clamp lat into the visible band, then project.
    const clamped = Math.max(latBot, Math.min(latTop, Number(lat)));
    const yPct = ((latTop - clamped) / latSpan) * 100;
    return `
      <div class="wc-pin" data-i="${i}" style="left:${xPct}%;top:${yPct}%;">
        <div class="pulse"></div>
        <div class="dot"></div>
      </div>
      <div class="wc-card" data-card-i="${i}" style="left:${xPct}%;top:${yPct}%;">
        <div class="label" data-cardlabel="${i}">${escHtml(c.label || c.tz)}</div>
        <div class="time" data-cardtime="${i}">--:--</div>
        <div class="date" data-carddate="${i}">—</div>
      </div>
    `;
  }).join('');
  tickWorldClocks();
}
function tickWorldClocks() {
  const list = state.config?.worldClocks || [];
  const now = new Date();
  list.forEach((c, i) => {
    const tz = c.tz || 'UTC';
    let h = '00', m = '00', ampm = 'AM';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).formatToParts(now);
      const get = t => parts.find(p => p.type === t)?.value || '';
      h = get('hour'); m = get('minute'); ampm = get('dayPeriod');
    } catch (_) {}
    let dStr = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).formatToParts(now);
      const get = t => parts.find(p => p.type === t)?.value || '';
      dStr = `${get('weekday')}, ${get('month')} ${get('day')}`;
    } catch (_) {}
    const t = document.querySelector(`[data-cardtime="${i}"]`);
    if (t) t.textContent = `${h}:${m} ${ampm}`;
    const d = document.querySelector(`[data-carddate="${i}"]`);
    if (d) d.textContent = dStr;
  });
}
// Tick world clocks every second when the zone is visible
setInterval(() => {
  if ($('zone-worldclocks')?.classList.contains('active')) tickWorldClocks();
}, 1000);

// ── Sun Arc ──────────────────────────────────────────────────────
// sunArcData.days[0] is today (used for the arc); days[1..3] are the next
// three days, used for the daylight-duration row at the bottom.
let sunArcData = null;       // { sunrise: Date, sunset: Date, label, days: [{date, sunrise, sunset, lenMs}] }
async function fetchSunArcData() {
  const cfg = state.config; if (!cfg) return;
  const lat = cfg.sunArcLat ?? cfg.trafficLat ?? cfg.radarLat ?? 41.4789;
  const lon = cfg.sunArcLon ?? cfg.trafficLon ?? cfg.radarLon ?? -73.4062;
  const label = cfg.sunArcLabel || cfg.trafficLabel || cfg.radarLabel || '';
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto&forecast_days=4`);
    const j = await r.json();
    const days = (j.daily?.sunrise || []).map((iso, i) => {
      const sr = new Date(iso);
      const ss = new Date(j.daily.sunset[i]);
      return { date: sr, sunrise: sr, sunset: ss, lenMs: ss - sr };
    });
    sunArcData = {
      sunrise: days[0]?.sunrise,
      sunset:  days[0]?.sunset,
      label,
      days,
    };
  } catch (_) { sunArcData = null; }
}
function renderSunArc() {
  if (!sunArcData) { fetchSunArcData().then(renderSunArc); return; }
  const svg = $('sunarc-svg'); if (!svg) return;
  // Layout: full SVG is 800×400 with the horizon at y=320 and a 30px sun-radius
  // padding on top (10px margin + 20px sun aura). Arc radius is sized so the
  // arc fits comfortably above the horizon without being clipped.
  const W = 800, H = 400;
  const cy = 320;
  const cx = W / 2;
  const sunR = 22;
  const sunGlowR = 36;
  const arcR = cy - (sunGlowR + 12);   // ≈ 272 — keeps full arc inside viewBox

  const now = Date.now();
  const a = sunArcData.sunrise.getTime();
  const b = sunArcData.sunset.getTime();
  const isDaylight = now >= a && now <= b;

  // Position 0..1 from sunrise (left) to sunset (right) — only meaningful during daylight.
  let p = (now - a) / (b - a);
  p = Math.max(0, Math.min(1, p));
  const angle = Math.PI * (1 - p);   // π → 0 as we go left → right
  const sx = cx + Math.cos(angle) * arcR;
  const sy = cy - Math.sin(angle) * arcR;

  const arcPath = `M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${cx + arcR} ${cy}`;
  const activeEndX = cx + Math.cos(angle) * arcR;
  const activeEndY = cy - Math.sin(angle) * arcR;
  const activePath = `M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${activeEndX} ${activeEndY}`;

  // Time-of-day status text + sky shading
  let nightLabel = '';
  if (now < a)      nightLabel = `Sunrise in ${humanDur(a - now)}`;
  else if (now > b) nightLabel = `Sunset was ${humanDur(now - b)} ago`;

  // Pre-dawn / post-sunset: dimmer sky, no sun, no active arc
  const skyOpacity = isDaylight ? 0.4 : 0.2;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="skyGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${isDaylight ? '#1a3a6c' : '#0a1a30'}"/>
        <stop offset="100%" stop-color="#0a0e1a"/>
      </linearGradient>
      <linearGradient id="sunGrad" x1="0" x2="1">
        <stop offset="0%" stop-color="#ff7e36"/>
        <stop offset="50%" stop-color="#ffd166"/>
        <stop offset="100%" stop-color="#ff7e36"/>
      </linearGradient>
      <radialGradient id="sunFill">
        <stop offset="0%" stop-color="#fff5b8"/>
        <stop offset="60%" stop-color="#ffd166"/>
        <stop offset="100%" stop-color="#ffae42"/>
      </radialGradient>
      <filter id="sunGlow"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    <rect x="0" y="0" width="${W}" height="${cy}" fill="url(#skyGrad)" opacity="${skyOpacity}"/>
    <line x1="0" y1="${cy}" x2="${W}" y2="${cy}" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="4 6"/>
    <!-- Full arc trace (always shown faintly) -->
    <path d="${arcPath}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2" stroke-dasharray="4 8"/>
    ${isDaylight ? `
      <!-- Active portion of the arc traversed so far -->
      <path d="${activePath}" fill="none" stroke="url(#sunGrad)" stroke-width="3" stroke-linecap="round"/>
      <!-- Sun -->
      <circle cx="${sx}" cy="${sy}" r="${sunGlowR}" fill="url(#sunFill)" opacity="0.4" filter="url(#sunGlow)"/>
      <circle cx="${sx}" cy="${sy}" r="${sunR}" fill="url(#sunFill)"/>
    ` : ''}
    <!-- Sunrise / sunset markers (always shown) -->
    <circle cx="${cx - arcR}" cy="${cy}" r="6" fill="rgba(255,200,100,0.6)"/>
    <circle cx="${cx + arcR}" cy="${cy}" r="6" fill="rgba(255,100,80,0.6)"/>
    <text x="${cx - arcR}" y="${cy + 28}" fill="rgba(255,255,255,0.5)" font-size="14" text-anchor="middle">RISE</text>
    <text x="${cx + arcR}" y="${cy + 28}" fill="rgba(255,255,255,0.5)" font-size="14" text-anchor="middle">SET</text>
    ${nightLabel ? `<text x="${cx}" y="${cy - arcR / 2}" fill="rgba(255,255,255,0.5)" font-size="22" text-anchor="middle" font-weight="200">${escHtml(nightLabel)}</text>` : ''}
  `;
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setText('sunarc-rise', fmt(sunArcData.sunrise));
  setText('sunarc-set',  fmt(sunArcData.sunset));
  // 'Now' was removed from the meta row — header time is right above this zone.
  const lenMs = b - a;
  setText('sunarc-len', `${Math.floor(lenMs / 3600000)}h ${Math.round((lenMs % 3600000) / 60000)}m`);
  setText('sunarc-label', sunArcData.label || 'Today');

  // Next 3 days daylight summary row.
  const fcEl = document.getElementById('sunarc-forecast');
  if (fcEl) {
    const next = (sunArcData.days || []).slice(1, 4);
    if (!next.length) { fcEl.innerHTML = ''; }
    else {
      const fmtLen = (ms) => `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
      const fmtRise = (sr, ss) => `${sr.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${ss.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const today = new Date(); today.setHours(0,0,0,0);
      fcEl.innerHTML = next.map(d => {
        const day = new Date(d.date); day.setHours(0,0,0,0);
        const diff = Math.round((day - today) / 86400000);
        const name = diff === 1 ? 'Tomorrow' : d.date.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
        return `<div class="sa-day">
          <div class="sa-day-name">${escHtml(name)}</div>
          <div class="sa-day-len">${escHtml(fmtLen(d.lenMs))}</div>
          <div class="sa-day-rise">${escHtml(fmtRise(d.sunrise, d.sunset))}</div>
        </div>`;
      }).join('');
    }
  }
}
function humanDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
// Refresh sunrise/sunset every 6h, redraw every 1 min while visible
setInterval(fetchSunArcData, 6 * 60 * 60 * 1000);
setInterval(() => {
  if ($('zone-sunarc')?.classList.contains('active')) renderSunArc();
}, 60 * 1000);

// ── Calendar ─────────────────────────────────────────────────────
let calendarEvents = [];
async function fetchCalendar() {
  try {
    const r = await fetch(`/api/calendar/public/${SLUG}`);
    const j = await r.json();
    calendarEvents = j.events || [];
    markRefreshed('zone-calendar');
  } catch (_) { calendarEvents = []; }
}
function renderCalendar() {
  const list = $('calendar-list'); if (!list) return;
  if (!calendarEvents.length) {
    list.innerHTML = '<div class="trend-empty" style="text-align:center;padding:40px 0;font-size:18px;">No upcoming events</div>';
    return;
  }
  const now = new Date();
  const todayStr = now.toDateString();
  const maxEvents = Math.max(1, Math.min(50, Number(state.config?.calendarMaxEvents) || 8));
  list.innerHTML = calendarEvents.slice(0, maxEvents).map(ev => {
    const start = new Date(ev.start.iso);
    const isToday = start.toDateString() === todayStr;
    const dayLabel = isToday ? 'TODAY' : start.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
    const dayNum = start.getDate();
    const timeStr = ev.start.allDay ? 'All day' : start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const meta = [ev.calendarName, ev.location].filter(Boolean).join(' · ');
    return `
      <div class="cal-event ${isToday ? 'today' : ''}" style="border-left-color: ${escHtml(ev.calendarColor || '#58a6ff')};">
        <div class="cal-event-day"><span>${escHtml(dayLabel)}</span><span class="num">${dayNum}</span></div>
        <div>
          <div class="cal-event-summary">${escHtml(ev.summary || '(No title)')}</div>
          ${meta ? `<div class="cal-event-meta">${escHtml(meta)}</div>` : ''}
        </div>
        <div class="cal-event-time">${escHtml(timeStr)}</div>
      </div>
    `;
  }).join('');
}
// Refresh calendar every 10 min
setInterval(fetchCalendar, 10 * 60 * 1000);

// ── Today's Number ───────────────────────────────────────────────
function renderBigNum() {
  const cfg = state.config; if (!cfg) return;
  setText('bignum-label',   cfg.bigNumLabel || '—');
  setText('bignum-value',   computeBigNumValue(cfg));
  setText('bignum-unit',    cfg.bigNumUnit || '');
  setText('bignum-subline', cfg.bigNumSubline || '');
  markRefreshed('zone-bignum');
  // Size class — admin picks small/medium/large/xl.
  const z = $('zone-bignum');
  if (z) {
    z.classList.remove('size-small', 'size-medium', 'size-large', 'size-xl');
    z.classList.add(`size-${cfg.bigNumSize || 'large'}`);
  }
}
function computeBigNumValue(cfg) {
  if (cfg.bigNumMode === 'countup' && cfg.bigNumStartDate) {
    // Count whole calendar days from start to now in the screen's TZ.
    // Parse start as local midnight to avoid TZ drift.
    const m = String(cfg.bigNumStartDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return cfg.bigNumValue ?? '—';
    const start = new Date(+m[1], +m[2] - 1, +m[3]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.round((today - start) / (24 * 3600 * 1000)));
    return String(days);
  }
  return cfg.bigNumValue ?? '—';
}
// Re-render the counter once a minute (so it ticks past midnight on its own).
setInterval(() => {
  if ($('zone-bignum')?.classList.contains('active')) renderBigNum();
}, 60 * 1000);

// ── Idle / Overnight mode ────────────────────────────────────────
function checkIdle() {
  const cfg = state.config; if (!cfg) return;
  const overlay = $('idle-overlay');
  const inWindow = cfg.quietEnabled && isInQuietWindow(cfg.quietStart, cfg.quietEnd, cfg.timezone);
  if (inWindow) {
    overlay.classList.add('active');
    overlay.classList.toggle('minimal', cfg.quietMode === 'minimal');
    if (cfg.quietMode === 'black') {
      $('idle-mode-content').innerHTML = '';
    } else if (cfg.quietMode === 'message') {
      $('idle-mode-content').innerHTML = `<div class="msg">${escHtml(cfg.quietMessage || '')}</div>`;
    } else {
      // minimal — big clock
      const now = new Date();
      const tz = cfg.timezone || undefined;
      const t = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(now);
      const d = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(now);
      $('idle-mode-content').innerHTML = `<div class="clock">${escHtml(t)}</div><div class="date">${escHtml(d)}</div>`;
    }
  } else {
    overlay.classList.remove('active');
  }
}
function isInQuietWindow(startStr, endStr, tz) {
  const [sh, sm] = (startStr || '20:00').split(':').map(Number);
  const [eh, em] = (endStr   || '06:00').split(':').map(Number);
  const now = new Date();
  // Get current minutes-of-day in the screen's timezone
  let h = now.getHours(), m = now.getMinutes();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).formatToParts(now);
      h = parseInt(parts.find(p => p.type === 'hour').value);
      m = parseInt(parts.find(p => p.type === 'minute').value);
    } catch (_) {}
  }
  const cur = h * 60 + m;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;       // same day
  return cur >= start || cur < end;                        // wraps midnight
}
setInterval(checkIdle, 60 * 1000);
setInterval(() => {
  // Also tick the minimal clock every second when active
  if ($('idle-overlay')?.classList.contains('active') && state.config?.quietMode === 'minimal') checkIdle();
}, 1000);

// ── Heartbeat to server (health monitoring) ──────────────────────
let lastErrorCount = 0;
window.addEventListener('error', () => { lastErrorCount++; });
window.addEventListener('unhandledrejection', () => { lastErrorCount++; });
function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cfg = state.config;
  const zoneIds = cfg?.zoneIds || [];
  try {
    ws.send(JSON.stringify({
      type: 'STATUS',
      currentZone: zoneIds[state.currentZone] || null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      errors: lastErrorCount,
      ua: navigator.userAgent.slice(0, 100),
    }));
  } catch (_) {}
}
setInterval(sendHeartbeat, 30 * 1000);
// Send one shortly after connect
setTimeout(sendHeartbeat, 2000);

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  boot().then(() => {
    fetchSunArcData();
    fetchCalendar();
    checkIdle();
  });
});

})();
