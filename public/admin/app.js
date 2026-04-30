// Pittwater Signage admin — single-page app.
// Routes hash-based: #/screens, #/screens/:slug, #/assets, #/messages

(() => {
'use strict';

// ── State ────────────────────────────────────────────────────────
const state = {
  user: null,
  screens: [],          // [{ id, slug, name, updatedAt }]
  currentScreen: null,  // full screen object: { id, slug, name, config, updatedAt }
  currentTab: 'zones',
  assets: [],
  liveCounts: {},       // slug -> connected client count (best-effort)
};

// Ordered by purpose so "Reset Order" produces a sensible default.
const ZONE_META = {
  // Time / location
  'zone-clock':       { label: 'Clock',          icon: '🕐' },
  'zone-worldclocks': { label: 'World Clocks',   icon: '🌐' },
  'zone-sunarc':      { label: 'Sun Arc',        icon: '☀️' },
  // Operational content
  'zone-shipments':   { label: 'Shipments',      icon: '📦' },
  'zone-kpi':         { label: 'KPI',            icon: '📊' },
  'zone-bignum':      { label: "Today's Number", icon: '💯' },
  'zone-safety':      { label: 'Safety',         icon: '⚠️' },
  'zone-calendar':    { label: 'Calendar',       icon: '📅' },
  'zone-meetings':    { label: 'Meeting Rooms',  icon: '🚪' },
  'zone-slack':       { label: 'Messages',       icon: '💬' },
  // Inspiration
  'zone-motivation':  { label: 'Motivation',     icon: '✨' },
  // Live data
  'zone-weather':     { label: 'Weather',        icon: '🌤️' },
  'zone-sports':      { label: 'Sports (combined, legacy)', icon: '🏆' },
  'zone-sports-results':  { label: 'Sports Results',  icon: '🏆' },
  'zone-sports-upcoming': { label: 'Sports Upcoming', icon: '🏆' },
  'zone-trends':      { label: 'Trends',         icon: '🔥' },
  'zone-stocks-overview': { label: 'Markets',     icon: '📈' },
  'zone-stocks-bigboard': { label: 'Stock Big Board', icon: '📊' },
  // Surveillance / maps
  'zone-doors':       { label: 'Cameras',        icon: '📷' },
  'zone-radar':       { label: 'Weather Radar',  icon: '🌧️' },
  'zone-traffic':     { label: 'Traffic',        icon: '🚗' },
  // Custom content
  'zone-slides':      { label: 'Google Slides',  icon: '📽️' },
};

// Standard size dropdown — used everywhere "Display size" is configurable.
// Labels here drive what the user sees, so "xl" renders as "XL" not "Xl".
const SIZE_OPTIONS = [
  ['small',  'Small'],
  ['medium', 'Medium'],
  ['large',  'Large'],
  ['xl',     'XL'],
];

const TZ_LIST = [
  'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
  'America/Toronto','America/Vancouver','America/Mexico_City','America/Phoenix',
  'Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Amsterdam',
  'Europe/Rome','Europe/Moscow',
  'Asia/Tokyo','Asia/Shanghai','Asia/Singapore','Asia/Hong_Kong','Asia/Dubai','Asia/Kolkata',
  'Australia/Sydney','Australia/Melbourne','Australia/Perth','Pacific/Auckland',
  'UTC',
];

// ── Utilities ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = (isErr ? '⚠️ ' : '✓ ') + msg;
  el.style.borderColor = isErr ? 'var(--danger)' : 'var(--success)';
  el.style.color = isErr ? 'var(--danger)' : 'var(--success)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const r = await fetch(path, opts);
  const isJson = (r.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = (data && data.error) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

// Persist a partial config patch for the current screen.
async function saveCurrentConfig(patch) {
  if (!state.currentScreen) return;
  const updated = await api(`/api/screens/${state.currentScreen.slug}`, {
    method: 'PUT',
    body: { config: patch },
  });
  state.currentScreen = updated;
}

// ── Routing ──────────────────────────────────────────────────────
function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/screens';
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'screens' && parts[1]) return { route: 'screen', slug: parts[1], tab: parts[2] || 'zones' };
  if (parts[0] === 'screens')             return { route: 'screens' };
  if (parts[0] === 'assets')              return { route: 'assets' };
  if (parts[0] === 'messages')            return { route: 'messages' };
  if (parts[0] === 'slack')               return { route: 'slack' };
  if (parts[0] === 'settings')            return { route: 'settings' };
  return { route: 'screens' };
}

window.addEventListener('hashchange', render);

// ── WebSocket (admin watches all screens it visits for live status) ──
let ws = null;
function connectWs(slug) {
  if (ws) try { ws.close(); } catch(_) {}
  if (!slug) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/${slug}`);
  ws.onopen = () => {
    $('conn-dot').classList.add('connected');
    $('conn-label').textContent = `Watching ${slug}`;
  };
  ws.onclose = () => {
    $('conn-dot').classList.remove('connected');
    $('conn-label').textContent = 'Disconnected';
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'CONFIG_UPDATE') {
        // Another admin tab made a change — refresh local copy
        state.currentScreen.config = m.config;
      }
    } catch (_) {}
  };
}

// ── Theme (admin light/dark/auto) ────────────────────────────────
const THEME_STORAGE_KEY = 'admin-theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('theme-toggle');
  if (btn) {
    btn.textContent = t === 'light' ? '☀️ Light' : t === 'dark' ? '🌙 Dark' : '🌗 Auto';
    btn.title = `Theme: ${t} (click to cycle)`;
  }
}
function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
  applyTheme(stored);
  $('theme-toggle')?.addEventListener('click', () => {
    const cur = localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
    const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
}
// Apply persisted theme as early as possible — even before login redirect —
// so the page never flashes the wrong color scheme.
(function earlyTheme() {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) {}
})();

// ── Boot ─────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    $('user-label').textContent = me.user.username;
  } catch (e) {
    location.href = '/login';
    return;
  }
  document.querySelectorAll('.nav-item[data-route]').forEach(el => {
    el.addEventListener('click', () => {
      const r = el.dataset.route;
      if (r === 'logout') return logout();
      location.hash = `#/${r}`;
    });
  });
  await loadScreens();
  render();
}

async function loadScreens() {
  const j = await api('/api/screens');
  state.screens = j.screens || [];
  renderScreensNav();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
}

function renderScreensNav() {
  const container = $('screens-nav-list');
  container.innerHTML = state.screens.map(s => `
    <div class="nav-item nav-screen" data-slug="${esc(s.slug)}">
      <span class="icon">📺</span> ${esc(s.name)}
    </div>
  `).join('');
  container.querySelectorAll('[data-slug]').forEach(el => {
    el.addEventListener('click', () => {
      location.hash = `#/screens/${el.dataset.slug}`;
    });
  });
}

// ── Render ───────────────────────────────────────────────────────
async function render() {
  const r = parseRoute();
  highlightNav(r);
  if (r.route === 'screens')   return renderScreensIndex();
  if (r.route === 'assets')    return renderAssets();
  if (r.route === 'messages')  return renderBroadcast();
  if (r.route === 'slack')     return renderSlackPage();
  if (r.route === 'settings')  return renderSettingsPage();
  if (r.route === 'screen')    return renderScreen(r.slug, r.tab);
}

function highlightNav(r) {
  document.querySelectorAll('#sidebar .nav-item').forEach(el => el.classList.remove('active'));
  if (r.route === 'screens') {
    document.querySelector('.nav-item[data-route="screens"]')?.classList.add('active');
  } else if (r.route === 'assets') {
    document.querySelector('.nav-item[data-route="assets"]')?.classList.add('active');
  } else if (r.route === 'messages') {
    document.querySelector('.nav-item[data-route="messages"]')?.classList.add('active');
  } else if (r.route === 'slack') {
    document.querySelector('.nav-item[data-route="slack"]')?.classList.add('active');
  } else if (r.route === 'settings') {
    document.querySelector('.nav-item[data-route="settings"]')?.classList.add('active');
  } else if (r.route === 'screen') {
    document.querySelector(`.nav-item[data-slug="${r.slug}"]`)?.classList.add('active');
  }
}

// ── Screens index ────────────────────────────────────────────────
let screensRefreshTimer = null;
function renderScreensIndex() {
  if (ws) try { ws.close(); } catch(_) {}
  $('topbar-title').textContent = 'All Screens';
  $('topbar-actions').innerHTML = `<button class="btn btn-primary" id="new-screen-btn">+ New Screen</button>`;
  $('new-screen-btn').addEventListener('click', () => createScreenPrompt());
  // Live-refresh every 5s while this view is mounted
  if (screensRefreshTimer) clearInterval(screensRefreshTimer);
  screensRefreshTimer = setInterval(async () => {
    if (parseRoute().route !== 'screens') { clearInterval(screensRefreshTimer); screensRefreshTimer = null; return; }
    try { await loadScreens(); renderScreensIndexBody(); } catch (_) {}
  }, 5000);

  $('content').innerHTML = `
    <div class="muted" style="margin-bottom:12px;">
      Each screen has its own URL — point a TV at <code>${location.origin}/s/&lt;slug&gt;</code>.
      Settings are saved to the server and pushed live over WebSocket.
      <span style="margin-left:12px;">●</span> green = TV connected, sending heartbeats.
    </div>
    <div class="screens-grid" id="screens-grid"></div>
  `;
  renderScreensIndexBody();
}
function renderScreensIndexBody() {
  const grid = $('screens-grid'); if (!grid) return;
  if (!state.screens.length) {
    grid.innerHTML = `<div class="muted">No screens yet. Click <strong>+ New Screen</strong> to create your first one.</div>`;
    return;
  }
  grid.innerHTML = state.screens.map(s => {
    const live = (s.connections || 0) > 0;
    const st = s.status;
    let lastSeen = '—';
    if (st?.lastSeen) {
      const ago = Math.round((Date.now() - st.lastSeen) / 1000);
      lastSeen = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago/60)}m ago` : `${Math.round(ago/3600)}h ago`;
    }
    const zoneLabel = st?.currentZone ? (ZONE_META[st.currentZone]?.label || st.currentZone) : '';
    return `
    <div class="screen-card" data-slug="${esc(s.slug)}">
      <div class="name">
        <span class="status-dot ${live ? 'connected' : ''}"></span>
        ${esc(s.name)}
      </div>
      <div class="slug">/s/${esc(s.slug)}</div>
      <div class="meta" style="line-height:1.6;">
        <div>${live ? `<strong style="color:var(--success);">Online</strong>` : `<span style="color:var(--subtext);">Offline</span>`}${zoneLabel ? ` · Showing ${esc(zoneLabel)}` : ''}</div>
        <div>Last heartbeat: ${esc(lastSeen)}</div>
        <div>Updated ${formatDate(s.updatedAt)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-outline btn-sm" data-act="open">Edit</button>
        <button class="btn btn-outline btn-sm" data-act="view">Open TV view ↗</button>
        <button class="btn btn-danger btn-sm" data-act="del">Delete</button>
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.screen-card').forEach(card => {
    const slug = card.dataset.slug;
    card.querySelector('[data-act=open]').addEventListener('click', (e) => {
      e.stopPropagation();
      location.hash = `#/screens/${slug}`;
    });
    card.querySelector('[data-act=view]').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/s/${slug}`, '_blank');
    });
    card.querySelector('[data-act=del]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete screen "${slug}"? This cannot be undone.`)) return;
      try {
        await api(`/api/screens/${slug}`, { method: 'DELETE' });
        await loadScreens();
        toast('Screen deleted');
        render();
      } catch (err) { toast(err.message, true); }
    });
    card.addEventListener('click', () => location.hash = `#/screens/${slug}`);
  });
}

async function createScreenPrompt() {
  // Fetch templates so the user can seed from one (optional).
  let templates = [];
  try { templates = (await api('/api/templates')).templates || []; } catch (_) {}
  const result = await newScreenModal(templates);
  if (!result || !result.name) return;
  try {
    const body = { name: result.name };
    if (result.templateId) body.templateId = result.templateId;
    const screen = await api('/api/screens', { method: 'POST', body });
    await loadScreens();
    location.hash = `#/screens/${screen.slug}`;
    toast('Screen created');
  } catch (e) { toast(e.message, true); }
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

// ── Per-screen view (tabs) ───────────────────────────────────────
async function renderScreen(slug, tab) {
  try {
    const screen = await api(`/api/screens/${slug}`);
    state.currentScreen = screen;
  } catch (e) {
    $('content').innerHTML = `<div class="muted">Screen not found.</div>`;
    return;
  }
  state.currentTab = tab;
  connectWs(slug);

  $('topbar-title').textContent = state.currentScreen.name;
  $('topbar-actions').innerHTML = `
    <button class="btn btn-outline btn-sm" id="open-tv-btn">Open TV view ↗</button>
    <button class="btn btn-outline btn-sm" id="save-tpl-btn">💾 Save as Template</button>
    <button class="btn btn-outline btn-sm" id="rename-btn">Rename</button>
  `;
  $('open-tv-btn').addEventListener('click', () => window.open(`/s/${slug}`, '_blank'));
  $('save-tpl-btn').addEventListener('click', async () => {
    const name = await textPromptModal({
      title: 'Save as Template',
      label: 'Template name',
      placeholder: `e.g. "${state.currentScreen.name} preset"`,
      helpText: 'New displays can be created from this template. Logo and global API keys are not included.',
      okText: 'Save Template',
    });
    if (!name) return;
    try {
      await api('/api/templates', { method: 'POST', body: { name, fromSlug: slug } });
      toast(`Template "${name}" saved`);
    } catch (e) {
      toast(e.message || 'Save failed', true);
    }
  });
  $('rename-btn').addEventListener('click', async () => {
    const newName = await textPromptModal({
      title: 'Rename Display',
      label: 'Display name',
      value: state.currentScreen.name,
      okText: 'Rename',
    });
    if (!newName) return;
    await api(`/api/screens/${slug}`, { method: 'PUT', body: { name: newName } });
    await loadScreens();
    state.currentScreen.name = newName;
    $('topbar-title').textContent = newName;
    toast('Renamed');
  });

  // Two rows of tabs grouped by purpose.
  // Row 1 — Display: how the screen looks and behaves.
  // Row 2 — Content + Data + Integrations.
  const tabRows = [
    [
      ['zones',      'Zones'],
      ['appearance', 'Appearance'],
      ['clock',      'Clock'],
      ['timezone',   'Time Zone'],
      ['rotation',   'Rotation'],
      ['quiet',      'Idle / Overnight'],
    ],
    [
      ['messages',   'Messages'],
      ['kpi',        'KPI'],
      ['safety',     'Safety'],
      ['bignum',     "Today's Number"],
      ['worldclocks','World Clocks'],
      ['calendar',   'Calendar'],
      ['meetings',   'Meeting Rooms'],
      ['cameras',    'Cameras'],
      ['slides',     'Slides'],
      ['weather',    'Weather'],
      ['sports',     'Sports'],
      ['stocks',     'Stocks'],
      ['sunarc',     'Sun Arc'],
      ['trends',     'Trends'],
      ['radar',      'Radar'],
      ['traffic',    'Traffic'],
      ['integrations','Integrations'],
    ],
  ];
  const renderRow = (row) => row.map(([id, label]) =>
    `<div class="tab ${tab === id ? 'active' : ''}" data-tab="${id}">${label}</div>`
  ).join('');
  $('content').innerHTML = `
    <div class="tabs">${renderRow(tabRows[0])}</div>
    <div class="tabs tabs-row2">${renderRow(tabRows[1])}</div>
    <div id="tab-body"></div>
  `;
  $('content').querySelectorAll('.tab').forEach(el => {
    el.addEventListener('click', () => {
      location.hash = `#/screens/${slug}/${el.dataset.tab}`;
    });
  });

  renderTab(tab);
}

function renderTab(tab) {
  const cfg = state.currentScreen.config;
  const body = $('tab-body');
  switch (tab) {
    case 'zones':       return renderZonesTab(body, cfg);
    case 'messages':    return renderMessagesTab(body, cfg);
    case 'kpi':         return renderKpiTab(body, cfg);
    case 'safety':      return renderSafetyTab(body, cfg);
    case 'clock':       return renderClockTab(body, cfg);
    case 'weather':     return renderWeatherTab(body, cfg);
    case 'appearance':  return renderAppearanceTab(body, cfg);
    case 'integrations':return renderIntegrationsTab(body, cfg);
    case 'trends':      return renderTrendsTab(body, cfg);
    case 'radar':       return renderRadarTab(body, cfg);
    case 'traffic':     return renderTrafficTab(body, cfg);
    case 'rotation':    return renderRotationTab(body, cfg);
    case 'timezone':    return renderTimezoneTab(body, cfg);
    case 'worldclocks': return renderWorldClocksTab(body, cfg);
    case 'sunarc':      return renderSunArcTab(body, cfg);
    case 'calendar':    return renderCalendarTab(body, cfg);
    case 'meetings':    return renderMeetingRoomsTab(body, cfg);
    case 'cameras':     return renderCamerasTab(body, cfg);
    case 'slides':      return renderSlidesTab(body, cfg);
    case 'sports':      return renderSportsTab(body, cfg);
    case 'stocks':      return renderStocksTab(body, cfg);
    case 'bignum':      return renderBigNumTab(body, cfg);
    case 'quiet':       return renderQuietTab(body, cfg);
    default:            body.innerHTML = '<div class="muted">Unknown tab.</div>';
  }
}

// ── Tab: Zones ───────────────────────────────────────────────────
function renderZonesTab(body, cfg) {
  // zoneIds stores the active set; render as a draggable list with toggles.
  const allZones = Object.keys(ZONE_META);
  const enabled = new Set(cfg.zoneIds || []);
  // Show enabled zones in order, then disabled at the bottom.
  const order = [...(cfg.zoneIds || []), ...allZones.filter(z => !enabled.has(z))];

  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🗂️</span> Zone Order &amp; Visibility</div>
      <p class="muted" style="margin-bottom:14px;">Drag to reorder. Toggle to show/hide on this TV. Jump to preview a zone instantly.</p>
      <div id="zone-manager"></div>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn btn-outline" id="reset-zones">↺ Reset Order</button>
      </div>
    </div>
  `;
  const ul = $('zone-manager');
  const dwell = Object.assign({}, cfg.zoneDwell || {});
  function renderList() {
    ul.innerHTML = order.map((zid, i) => {
      const meta = ZONE_META[zid] || { label: zid, icon: '📺' };
      const on = enabled.has(zid);
      const ds = dwell[zid] ? Math.round(dwell[zid] / 1000) : '';
      return `
        <div class="zone-row" draggable="true" data-idx="${i}">
          <span class="zone-handle">⠿</span>
          <span class="zone-icon">${meta.icon}</span>
          <span class="zone-name">${esc(meta.label)}</span>
          <div class="zone-actions">
            <input type="number" min="3" max="300" placeholder="default" value="${ds}" data-dwell="${zid}" title="Dwell seconds (blank = use rotation default)" style="width:72px;font-size:12px;">
            <span style="font-size:11px;color:var(--subtext);">s</span>
            <button class="btn btn-outline btn-sm" data-jump="${zid}">▶ Jump</button>
            <label class="toggle">
              <input type="checkbox" ${on ? 'checked' : ''} data-zid="${zid}">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      `;
    }).join('');
    ul.querySelectorAll('input[type=number][data-dwell]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const zid = inp.dataset.dwell;
        const v = parseInt(inp.value);
        if (v && v >= 3 && v <= 300) dwell[zid] = v * 1000;
        else delete dwell[zid];
        await persist();
      });
    });
    bindDrag();
    ul.querySelectorAll('input[type=checkbox][data-zid]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const zid = cb.dataset.zid;
        if (cb.checked) enabled.add(zid); else enabled.delete(zid);
        await persist();
      });
    });
    ul.querySelectorAll('[data-jump]').forEach(b => {
      b.addEventListener('click', () => {
        api(`/api/screens/${state.currentScreen.slug}/event`, {
          method: 'POST', body: { type: 'SHOW_ZONE', payload: { id: b.dataset.jump } },
        }).then(() => toast(`Jumped to ${ZONE_META[b.dataset.jump].label}`));
      });
    });
  }
  let dragSrc = null;
  function bindDrag() {
    ul.querySelectorAll('.zone-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        dragSrc = parseInt(row.dataset.idx);
        row.classList.add('dragging');
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const target = parseInt(row.dataset.idx);
        if (dragSrc === null || dragSrc === target) return;
        const moved = order.splice(dragSrc, 1)[0];
        const insertAt = target > dragSrc ? target - 1 : target;
        order.splice(insertAt, 0, moved);
        renderList();
        await persist();
      });
      row.addEventListener('dragend', () => {
        document.querySelectorAll('.zone-row.drag-over').forEach(el => el.classList.remove('drag-over'));
        row.classList.remove('dragging');
        dragSrc = null;
      });
    });
  }
  async function persist() {
    const newZoneIds = order.filter(z => enabled.has(z));
    state.currentScreen.config.zoneIds = newZoneIds;
    state.currentScreen.config.zoneDwell = dwell;
    try {
      await saveCurrentConfig({ zoneIds: newZoneIds, zoneDwell: dwell });
      toast('Zones saved');
    } catch (e) { toast(e.message, true); }
  }
  $('reset-zones').addEventListener('click', async () => {
    if (!confirm('Reset zone order and enable all zones?')) return;
    order.length = 0;
    order.push(...Object.keys(ZONE_META));
    enabled.clear();
    Object.keys(ZONE_META).forEach(z => enabled.add(z));
    renderList();
    await persist();
  });
  renderList();
}

// ── Tab: Messages (per-screen broadcast) ─────────────────────────
function renderMessagesTab(body, cfg) {
  const footerMins = Number(cfg?.messageFooterMinutes) || 15;
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📢</span> Send Message to this Screen</div>
      <div class="form-row"><label>From</label><input type="text" id="msg-from" placeholder="e.g. Warehouse Team"></div>
      <div class="form-row"><label>Message</label><textarea id="msg-body" placeholder="Type your message…"></textarea></div>
      <div class="form-row"><label>Priority</label>
        <select id="msg-priority">
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
          <option value="info">Info</option>
        </select>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="send-msg">📤 Send</button>
        <button class="btn btn-outline" id="clear-msg">🗑 Clear all on this screen</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">📌</span> Footer Ticker</div>
      <p class="muted">After the 15-second full-screen overlay, every message also stays in a footer bar at the bottom of all pages for the duration set below. Clearing messages above also clears the ticker.</p>
      <div class="form-row" style="max-width:240px;">
        <label>Pin duration (minutes)</label>
        <input type="number" id="msg-footer-mins" min="0" max="240" value="${footerMins}">
        <p class="muted" style="margin-top:6px;font-size:12px;">Set to 0 to disable the footer entirely.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-msg-footer">💾 Save</button></div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">📋</span> Recent Messages</div>
      <div id="msg-log"><div class="muted">Loading…</div></div>
    </div>
  `;
  $('save-msg-footer').addEventListener('click', async () => {
    const mins = Math.max(0, Math.min(240, parseInt($('msg-footer-mins').value, 10) || 0));
    await saveCurrentConfig({ messageFooterMinutes: mins });
    toast(mins ? `Footer set to ${mins} min` : 'Footer disabled');
  });
  $('send-msg').addEventListener('click', async () => {
    const sender = $('msg-from').value.trim() || 'Admin';
    const bodyText = $('msg-body').value.trim();
    const priority = $('msg-priority').value;
    if (!bodyText) return toast('Message empty', true);
    try {
      await api(`/api/messages/${state.currentScreen.slug}`, {
        method: 'POST', body: { sender, body: bodyText, priority },
      });
      $('msg-body').value = '';
      toast('Message sent');
      loadMsgLog();
    } catch (e) { toast(e.message, true); }
  });
  $('clear-msg').addEventListener('click', async () => {
    if (!confirm('Clear all messages on this screen?')) return;
    await api(`/api/messages/${state.currentScreen.slug}`, { method: 'DELETE' });
    loadMsgLog();
    toast('Cleared');
  });
  async function loadMsgLog() {
    const j = await api(`/api/messages/public/${state.currentScreen.slug}`);
    const log = $('msg-log');
    if (!j.messages.length) { log.innerHTML = '<div class="muted">No recent messages.</div>'; return; }
    log.innerHTML = j.messages.map(m => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:12px;color:var(--accent);font-weight:600;">${esc(m.sender || 'Admin')} · ${esc(m.priority)}</div>
        <div style="font-size:13px;margin-top:2px;">${esc(m.body)}</div>
        <div style="font-size:11px;color:var(--subtext);margin-top:2px;">${formatDate(m.timestamp)}</div>
      </div>
    `).join('');
  }
  loadMsgLog();
}

// ── Tab: KPI ─────────────────────────────────────────────────────
function renderKpiTab(body, cfg) {
  let items = (cfg.kpiItems || []).slice();
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📊</span> KPI Metrics</div>
      <p class="muted">Custom metrics override the auto-derived shipments KPIs. Leave empty to use the sheet defaults.</p>
      <div id="kpi-rows"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-outline" id="add-kpi">+ Add Metric</button>
        <button class="btn btn-primary" id="save-kpi">💾 Save</button>
      </div>
    </div>
  `;
  function renderRows() {
    $('kpi-rows').innerHTML = items.map((it, i) => `
      <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr 80px auto;gap:10px;align-items:end;">
        <div><label>Label</label><input type="text" data-i="${i}" data-k="label" value="${esc(it.label || '')}"></div>
        <div><label>Value</label><input type="text" data-i="${i}" data-k="value" value="${esc(it.value || '')}"></div>
        <div><label>Unit</label><input type="text" data-i="${i}" data-k="unit" value="${esc(it.unit || '')}"></div>
        <div><button class="btn btn-danger btn-sm" data-del="${i}">✕</button></div>
      </div>
    `).join('') || '<div class="muted">No custom metrics. Add one below.</div>';
    $('kpi-rows').querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => { items[+inp.dataset.i][inp.dataset.k] = inp.value; });
    });
    $('kpi-rows').querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => { items.splice(+b.dataset.del, 1); renderRows(); });
    });
  }
  renderRows();
  $('add-kpi').addEventListener('click', () => { items.push({ label: '', value: '', unit: '' }); renderRows(); });
  $('save-kpi').addEventListener('click', async () => {
    const cleaned = items.filter(it => (it.label || '').trim() || (it.value || '').trim());
    await saveCurrentConfig({ kpiItems: cleaned });
    toast('KPIs saved');
  });
}

// ── Tab: Safety ──────────────────────────────────────────────────
function renderSafetyTab(body, cfg) {
  // Normalize: legacy entries are bare strings, new ones are { text, enabled }.
  // We keep enabled defaulting to true so existing screens don't suddenly go quiet.
  let messages = (cfg.safetyMessages || []).map(m =>
    typeof m === 'string' ? { text: m, enabled: true } : { text: m.text || '', enabled: m.enabled !== false }
  );
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">⚠️</span> Safety Reminders</div>
      <div class="form-row">
        <label>Add message</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="safety-input" placeholder="e.g. Always wear PPE">
          <button class="btn btn-primary" id="safety-add">+ Add</button>
        </div>
        <div class="muted" style="margin-top:6px;">
          Toggle the checkbox to mute a reminder without deleting it. Click any message to edit, ▲▼ to reorder, ✕ to remove.
        </div>
      </div>
      <ul id="safety-list" style="margin-top:8px;list-style:none;padding:0;"></ul>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn btn-primary" id="safety-save">💾 Save</button>
      </div>
    </div>
  `;
  function renderList() {
    const ul = $('safety-list');
    if (!messages.length) { ul.innerHTML = '<li class="muted">No safety messages.</li>'; return; }
    ul.innerHTML = messages.map((m, i) => `
      <li class="safety-item ${m.enabled ? '' : 'muted-row'}">
        <label class="safety-toggle" title="${m.enabled ? 'Click to mute' : 'Click to unmute'}">
          <input type="checkbox" data-toggle="${i}" ${m.enabled ? 'checked' : ''}>
        </label>
        <input type="text" class="safety-edit" value="${esc(m.text)}" data-i="${i}">
        <button class="safety-move" data-up="${i}" ${i===0?'disabled':''}>▲</button>
        <button class="safety-move" data-down="${i}" ${i===messages.length-1?'disabled':''}>▼</button>
        <button class="safety-del" data-del="${i}">✕</button>
      </li>
    `).join('');
    ul.querySelectorAll('.safety-edit').forEach(inp => {
      inp.addEventListener('blur', () => {
        const i = +inp.dataset.i;
        const v = inp.value.trim();
        if (!v) { messages.splice(i, 1); renderList(); }
        else if (v !== messages[i].text) { messages[i].text = v; }
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    ul.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', () => {
      messages[+cb.dataset.toggle].enabled = cb.checked;
      renderList();
    }));
    ul.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.up; if (i>0) { [messages[i],messages[i-1]]=[messages[i-1],messages[i]]; renderList(); } }));
    ul.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.down; if (i<messages.length-1) { [messages[i],messages[i+1]]=[messages[i+1],messages[i]]; renderList(); } }));
    ul.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { messages.splice(+b.dataset.del, 1); renderList(); }));
  }
  $('safety-add').addEventListener('click', () => {
    const v = $('safety-input').value.trim();
    if (!v) return;
    messages.push({ text: v, enabled: true });
    $('safety-input').value = '';
    renderList();
  });
  $('safety-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('safety-add').click(); } });
  $('safety-save').addEventListener('click', async () => {
    await saveCurrentConfig({ safetyMessages: messages });
    toast('Safety messages saved');
  });
  renderList();
}

// ── Tab: Clock ───────────────────────────────────────────────────
function renderClockTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🕐</span> Clock Style</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        ${['digital','minimal','analog'].map(style => `
          <div class="font-card ${cfg.clockStyle === style ? 'active' : ''}" data-style="${style}">
            <div class="label">${style.toUpperCase()}</div>
            <div class="preview">${style === 'analog' ? '🕐' : '12:34'}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">📐</span> Clock Display Size</div>
      <div class="form-row">
        <label>Size</label>
        <select id="cl-size">
          ${SIZE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cfg.clockSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <p class="muted" style="margin-top:6px;font-size:12px;">Scales the digital, minimal, or analog clock together with the date.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="cl-size-save">💾 Save</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🌐</span> World Clocks on Clock Zone</div>
      <p class="muted">When enabled, a small row of world-clock cards appears under the main clock. Manage the city list in the World Clocks tab.</p>
      <div class="form-row" style="display:flex;align-items:center;gap:12px;">
        <label style="margin:0;">Show world clocks under main clock</label>
        <label class="toggle"><input type="checkbox" id="cl-show-wc" ${cfg.showWorldClocksOnClock ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
    </div>
  `;
  $('cl-size-save').addEventListener('click', async () => {
    await saveCurrentConfig({ clockSize: $('cl-size').value });
    toast('Clock size saved');
  });
  body.querySelectorAll('[data-style]').forEach(card => {
    card.addEventListener('click', async () => {
      const style = card.dataset.style;
      body.querySelectorAll('[data-style]').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      await saveCurrentConfig({ clockStyle: style });
      toast('Clock style saved');
    });
  });
  $('cl-show-wc').addEventListener('change', async () => {
    await saveCurrentConfig({ showWorldClocksOnClock: $('cl-show-wc').checked });
    toast('Saved');
  });
}

// ── Tab: Weather ─────────────────────────────────────────────────
function renderWeatherTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🌤️</span> Weather</div>
      <div class="form-row"><label>Location</label><input type="text" id="weather-loc" value="${esc(cfg.weatherLocation || '')}" placeholder="e.g. Brookfield, CT"></div>
      <div class="form-row"><label>Units</label>
        <select id="weather-units">
          <option value="imperial" ${cfg.weatherUnits === 'imperial' ? 'selected' : ''}>°F / mph</option>
          <option value="metric" ${cfg.weatherUnits === 'metric' ? 'selected' : ''}>°C / km/h</option>
        </select>
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:12px;">
        <label style="margin:0;">Show 3-day forecast</label>
        <label class="toggle"><input type="checkbox" id="weather-fc" ${cfg.showForecast ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      <div class="form-row"><label>Display size</label>
        <select id="weather-size">
          ${SIZE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cfg.weatherSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <p class="muted" style="margin-top:6px;font-size:12px;">Scales the temperature, icon, description and detail tiles together.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-weather">💾 Save</button></div>
    </div>
  `;
  $('save-weather').addEventListener('click', async () => {
    await saveCurrentConfig({
      weatherLocation: $('weather-loc').value.trim(),
      weatherUnits: $('weather-units').value,
      showForecast: $('weather-fc').checked,
      weatherSize: $('weather-size').value,
    });
    toast('Weather saved');
  });
}

// ── Tab: Appearance (colors, font, logo) ─────────────────────────
// Curated theme presets. Most are dark since signage TVs typically run dark
// in warehouses; a couple of light themes for office or daylight settings.
const THEME_PRESETS = [
  // Cool / blues
  { name: 'Midnight',      bg: '#0a0e1a', accent: '#00aaff' },   // original default
  { name: 'Deep Ocean',    bg: '#04101e', accent: '#3da9fc' },
  { name: 'Slate',         bg: '#1a1f2e', accent: '#7eb6ff' },
  // Warm
  { name: 'Sunset',        bg: '#1a0a14', accent: '#ff6b35' },
  { name: 'Amber',         bg: '#15110a', accent: '#f59e0b' },
  // Greens
  { name: 'Forest',        bg: '#0a1410', accent: '#3fb950' },
  { name: 'Mint',          bg: '#0d1f1a', accent: '#10b981' },
  // Purples / pinks
  { name: 'Twilight',      bg: '#150a1f', accent: '#a855f7' },
  { name: 'Magenta',       bg: '#1a0d1a', accent: '#ec4899' },
  // High contrast / utilitarian
  { name: 'Pure Black',    bg: '#000000', accent: '#ffffff' },
  { name: 'Industrial',    bg: '#1c1c1c', accent: '#fbbf24' },
  // Light themes
  { name: 'Daylight',      bg: '#f6f8fa', accent: '#0969da' },
  { name: 'Paper',         bg: '#fdfaf3', accent: '#b85c00' },
];

function renderAppearanceTab(body, cfg) {
  const curBg = (cfg.bgColor || '#0a0e1a').toLowerCase();
  const curAc = (cfg.accentColor || '#00aaff').toLowerCase();
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🎨</span> Theme</div>
      <p class="muted">Click a preset to apply it instantly, or use the custom pickers below.</p>
      <div class="theme-grid">
        ${THEME_PRESETS.map(t => {
          const active = t.bg.toLowerCase() === curBg && t.accent.toLowerCase() === curAc;
          return `
            <div class="theme-card ${active ? 'active' : ''}" data-bg="${esc(t.bg)}" data-accent="${esc(t.accent)}" title="${esc(t.name)}">
              <div class="theme-swatch" style="background:${esc(t.bg)};">
                <div class="theme-accent-dot" style="background:${esc(t.accent)};"></div>
              </div>
              <div class="theme-name">${esc(t.name)}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🎯</span> Custom Colors</div>
      <div class="form-row">
        <label>Background</label>
        <div class="color-custom">
          <input type="color" id="bg-color" value="${esc(cfg.bgColor || '#0a0e1a')}">
          <input type="text" id="bg-hex" value="${esc(cfg.bgColor || '#0a0e1a')}" style="width:120px;">
        </div>
      </div>
      <div class="form-row">
        <label>Accent</label>
        <div class="color-custom">
          <input type="color" id="accent-color" value="${esc(cfg.accentColor || '#00aaff')}">
          <input type="text" id="accent-hex" value="${esc(cfg.accentColor || '#00aaff')}" style="width:120px;">
        </div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-colors">💾 Save Custom</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">📏</span> Top Header Size</div>
      <p class="muted">Scales the top menu bar — the logo, time, weather and date all grow or shrink together.</p>
      <div class="form-row">
        <label>Size</label>
        <select id="header-size">
          ${SIZE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cfg.headerSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-header-size">💾 Save</button></div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">🅰️</span> Font</div>
      <p class="muted">Choose the font used everywhere on this screen. Loads from Google Fonts.</p>
      <div class="font-grid" id="font-grid"></div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">🖼️</span> Logo</div>
      <p class="muted">Upload a logo file or paste a URL. Empty = no logo shown.</p>
      <div id="logo-preview" style="margin:12px 0;min-height:48px;display:flex;align-items:center;background:#0a0e1a;border:1px solid var(--border);border-radius:8px;padding:12px;">${
        cfg.logoUploadId ? `<img src="/api/uploads/${esc(cfg.logoUploadId)}/view" style="max-height:48px;">` :
        cfg.logoUrl ? `<img src="${esc(cfg.logoUrl)}" style="max-height:48px;">` :
        `<span class="muted">No logo</span>`
      }</div>
      <div class="btn-row">
        <button class="btn btn-outline" id="logo-pick">🖼️ Choose from Assets</button>
        <button class="btn btn-outline" id="logo-upload">⬆️ Upload</button>
        <button class="btn btn-outline" id="logo-url">🔗 Paste URL</button>
        <button class="btn btn-danger" id="logo-clear">✕ Remove</button>
      </div>
      <input type="file" id="logo-file" accept="image/*" style="display:none;">
    </div>
  `;
  // Color sync
  ['bg', 'accent'].forEach(key => {
    const cp = $(`${key}-color`), tx = $(`${key}-hex`);
    cp.addEventListener('input', () => { tx.value = cp.value; });
    tx.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(tx.value)) cp.value = tx.value; });
  });
  $('save-header-size').addEventListener('click', async () => {
    await saveCurrentConfig({ headerSize: $('header-size').value });
    toast('Header size saved');
  });
  $('save-colors').addEventListener('click', async () => {
    await saveCurrentConfig({ bgColor: $('bg-hex').value, accentColor: $('accent-hex').value });
    toast('Colors saved');
  });
  // Theme preset clicks — apply + save in one shot.
  body.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', async () => {
      const bg = card.dataset.bg;
      const accent = card.dataset.accent;
      // Update the custom inputs so they reflect the choice and the user can fine-tune.
      $('bg-color').value = bg;     $('bg-hex').value = bg;
      $('accent-color').value = accent; $('accent-hex').value = accent;
      // Visual selection state.
      body.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      try {
        await saveCurrentConfig({ bgColor: bg, accentColor: accent });
        toast(`Theme applied: ${card.title}`);
      } catch (e) { toast(e.message, true); }
    });
  });
  // Font grid
  const fgrid = $('font-grid');
  const FONTS = window.AVAILABLE_FONTS || [];
  fgrid.innerHTML = FONTS.map(f => `
    <div class="font-card ${cfg.fontFamily === f.family ? 'active' : ''}" data-family="${esc(f.family)}">
      <div class="label">${esc(f.family)}</div>
      <div class="preview" style="font-family: '${esc(f.family)}', sans-serif;">Aa Bb 123</div>
    </div>
  `).join('');
  FONTS.forEach(f => window.loadFontFamily?.(f.family));   // preload all so previews render
  fgrid.querySelectorAll('[data-family]').forEach(el => {
    el.addEventListener('click', async () => {
      fgrid.querySelectorAll('[data-family]').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      await saveCurrentConfig({ fontFamily: el.dataset.family });
      toast('Font saved');
    });
  });
  // Logo actions
  $('logo-upload').addEventListener('click', () => $('logo-file').click());
  $('logo-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/uploads', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) return toast(j.error || 'Upload failed', true);
    // Save bare ID (no extension) — server resolves the actual filename when serving.
    await saveCurrentConfig({ logoUploadId: j.id, logoUrl: '' });
    toast('Logo uploaded');
    renderTab('appearance');
  });
  $('logo-pick').addEventListener('click', async () => {
    const id = await pickAssetModal();
    if (!id) return;
    await saveCurrentConfig({ logoUploadId: id, logoUrl: '' });
    toast('Logo set');
    renderTab('appearance');
  });
  $('logo-url').addEventListener('click', async () => {
    const url = await textPromptModal({
      title: 'Logo URL',
      label: 'Image URL',
      value: state.currentScreen.config.logoUrl || '',
      placeholder: 'https://…',
      okText: 'Set',
    });
    if (url == null) return;
    await saveCurrentConfig({ logoUrl: url, logoUploadId: '' });
    toast('Logo URL set');
    renderTab('appearance');
  });
  $('logo-clear').addEventListener('click', async () => {
    await saveCurrentConfig({ logoUrl: '', logoUploadId: '' });
    toast('Logo cleared');
    renderTab('appearance');
  });
}

// ── Tab: Integrations (Google Sheet + Camera URL) ────────────────
function renderIntegrationsTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📦</span> Google Sheet — Shipments</div>
      <div class="form-row">
        <label>Published CSV URL</label>
        <input type="url" id="sheet-url" value="${esc(cfg.googleSheetUrl || '')}" placeholder="https://docs.google.com/.../pub?output=csv">
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-sheet">💾 Save</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">📸</span> Camera Overlay</div>
      <div class="form-row">
        <label>Camera Stream URL</label>
        <input type="url" id="camera-url" value="${esc(cfg.cameraUrl || '')}" placeholder="http://192.168.1.x/stream">
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="save-camera">💾 Save</button>
        <button class="btn btn-outline" id="trigger-camera">📷 Show Now</button>
      </div>
    </div>
  `;
  $('save-sheet').addEventListener('click', async () => {
    await saveCurrentConfig({ googleSheetUrl: $('sheet-url').value.trim() });
    toast('Sheet URL saved');
  });
  $('save-camera').addEventListener('click', async () => {
    await saveCurrentConfig({ cameraUrl: $('camera-url').value.trim() });
    toast('Camera URL saved');
  });
  $('trigger-camera').addEventListener('click', async () => {
    await api(`/api/screens/${state.currentScreen.slug}/event`, {
      method: 'POST', body: { type: 'SHOW_CAMERA' },
    });
    toast('Camera triggered');
  });
}

// ── Tab: UniFi ───────────────────────────────────────────────────
function renderUnifiTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📷</span> UniFi Protect — Camera Snapshots</div>
      <div class="form-row"><label>UniFi Host URL</label><input type="url" id="unifi-host" value="${esc(cfg.unifiHost || '')}" placeholder="https://192.168.10.1"></div>
      <div class="form-row"><label>API Key</label><input type="password" id="unifi-key" value="${esc(cfg.unifiApiKey || '')}" placeholder="Paste your API key"></div>
      <div class="form-row"><label>Local Proxy URL</label><input type="url" id="unifi-proxy" value="${esc(cfg.unifiProxyUrl || 'http://localhost:8081')}"></div>
      <div class="btn-row"><button class="btn btn-primary" id="save-unifi">💾 Save</button></div>
    </div>
  `;
  $('save-unifi').addEventListener('click', async () => {
    await saveCurrentConfig({
      unifiHost: $('unifi-host').value.trim(),
      unifiApiKey: $('unifi-key').value.trim(),
      unifiProxyUrl: $('unifi-proxy').value.trim() || 'http://localhost:8081',
    });
    toast('UniFi saved');
  });
}

// ── Tab: Maps API key ────────────────────────────────────────────
function renderMapsTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🗝️</span> Google Maps API Key</div>
      <p class="muted">Used by the Weather Radar and Traffic zones on this screen.</p>
      <div class="form-row"><label>API Key</label><input type="password" id="gmaps-key" value="${esc(cfg.googleMapsApiKey || '')}" placeholder="AIzaSy…"></div>
      <div class="btn-row"><button class="btn btn-primary" id="save-gmaps">💾 Save</button></div>
    </div>
  `;
  $('save-gmaps').addEventListener('click', async () => {
    await saveCurrentConfig({ googleMapsApiKey: $('gmaps-key').value.trim() });
    toast('API key saved');
  });
}

// ── Tab: Trends ──────────────────────────────────────────────────
// ── Tab: Sports ──────────────────────────────────────────────────
function renderSportsTab(body, cfg) {
  // Catalog mirrors signage app.js SPORTS_LEAGUES — keep in sync.
  const LEAGUES = [
    { id: 'nfl',  label: 'NFL',     emoji: '🏈' },
    { id: 'cfb',  label: 'NCAAF',   emoji: '🏈' },
    { id: 'nhl',  label: 'NHL',     emoji: '🏒' },
    { id: 'nba',  label: 'NBA',     emoji: '🏀' },
    { id: 'wnba', label: 'WNBA',    emoji: '🏀' },
    { id: 'cbb',  label: 'NCAAM',   emoji: '🏀' },
    { id: 'mlb',  label: 'MLB',     emoji: '⚾' },
    { id: 'mls',  label: 'MLS',     emoji: '⚽' },
    { id: 'epl',  label: 'EPL',     emoji: '⚽' },
    { id: 'lal',  label: 'La Liga', emoji: '⚽' },
    { id: 'ucl',  label: 'UCL',     emoji: '⚽' },
    { id: 'f1',   label: 'F1',      emoji: '🏎️' },
    { id: 'pga',  label: 'PGA',     emoji: '⛳' },
  ];
  const enabled = new Set(cfg.sportsLeagues || ['nfl','nba','mlb','nhl','mls']);
  const showOdds = !!cfg.sportsShowOdds;
  const layout = cfg.sportsLayout || 'auto';
  const LAYOUTS = [
    ['auto',     'Auto (sizes to game count)'],
    ['hero',     'Hero — 2 huge tiles per row'],
    ['large',    'Large — 3 tiles per row'],
    ['standard', 'Standard — 4 tiles per row'],
    ['compact',  'Compact — 6 tiles per row'],
  ];
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🏆</span> Sports Scores</div>
      <p class="muted">Pick the leagues you want to follow. Scores are pulled from ESPN's public scoreboard API for the previous 36 hours and refresh every 2 minutes.</p>
      <div class="form-row">
        <label>Leagues</label>
        <div class="leagues-grid">
          ${LEAGUES.map(l => `
            <label class="league-chip">
              <input type="checkbox" data-league="${l.id}" ${enabled.has(l.id) ? 'checked' : ''}>
              <span>${l.emoji} ${esc(l.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-row">
        <label>Tile layout</label>
        <select id="sports-layout">
          ${LAYOUTS.map(([v, l]) => `<option value="${v}" ${v === layout ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <p class="muted" style="margin-top:6px;font-size:12px;">Auto resizes tiles to fill the screen based on how many games are showing. Pick an explicit size to lock it.</p>
      </div>
      <div class="form-row">
        <label class="toggle-row">
          <input type="checkbox" id="sports-odds" ${showOdds ? 'checked' : ''}>
          <span>Show betting odds (point spread + over/under) on upcoming games</span>
        </label>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-sports">💾 Save</button></div>
    </div>
  `;
  $('save-sports').addEventListener('click', async () => {
    const leagues = Array.from(document.querySelectorAll('[data-league]'))
      .filter(c => c.checked)
      .map(c => c.dataset.league);
    await saveCurrentConfig({
      sportsLeagues: leagues,
      sportsShowOdds: $('sports-odds').checked,
      sportsLayout: $('sports-layout').value,
    });
    toast('Sports settings saved');
  });
}

// ── Tab: Stocks ──────────────────────────────────────────────────
// Two zones: Markets overview (indices/forex/crypto + extra tickers) and the
// Big Board (grid of tickers, red/green by daily change). Symbol lists are
// stored as comma-separated strings in the UI but persisted as arrays.
function renderStocksTab(body, cfg) {
  const INDEX_OPTIONS = [
    ['^DJI',     'DOW',          '📊'],
    ['^IXIC',    'NASDAQ',       '💻'],
    ['^GSPC',    'S&P 500',      '🇺🇸'],
    ['^RUT',     'Russell 2000', '🏭'],
    ['^VIX',     'VIX',          '⚡'],
    ['DX-Y.NYB', 'US Dollar',    '💵'],
    ['BTC-USD',  'Bitcoin',      '₿'],
    ['ETH-USD',  'Ethereum',     '⟠'],
    ['GC=F',     'Gold',         '🥇'],
    ['SI=F',     'Silver',       '🥈'],
    ['CL=F',     'Oil (WTI)',    '🛢️'],
    ['^FTSE',    'FTSE 100',     '🇬🇧'],
    ['^N225',    'Nikkei 225',   '🇯🇵'],
    ['^HSI',     'Hang Seng',    '🇭🇰'],
    ['^GDAXI',   'DAX',          '🇩🇪'],
  ];
  const indices = new Set(cfg.stockIndices || []);
  const overviewExtras = (cfg.stockOverviewSymbols || []).join(', ');
  const bigBoard       = (cfg.stockBigBoardSymbols  || []).join(', ');
  const mode           = cfg.stockBigBoardMode === 'dollar' ? 'dollar' : 'percent';

  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📈</span> Markets Overview</div>
      <p class="muted">Top row of the Markets zone. Quotes come from Yahoo Finance and refresh every 60 seconds (cached server-side for 30s).</p>
      <div class="form-row">
        <label>Indices, currencies &amp; crypto</label>
        <div class="leagues-grid">
          ${INDEX_OPTIONS.map(([id, label, emoji]) => `
            <label class="league-chip">
              <input type="checkbox" data-stock-index="${esc(id)}" ${indices.has(id) ? 'checked' : ''}>
              <span>${emoji} ${esc(label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-row">
        <label for="stocks-overview-extras">Additional tickers</label>
        <input id="stocks-overview-extras" type="text" value="${esc(overviewExtras)}" placeholder="AAPL, MSFT, TSLA">
        <p class="muted" style="margin-top:6px;font-size:12px;">Comma-separated Yahoo Finance symbols. Appear under the indices row.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">📊</span> Stock Big Board</div>
      <p class="muted">Grid of tiles, red or green based on the day's change. Pick which figure each tile leads with.</p>
      <div class="form-row">
        <label for="stocks-bigboard-symbols">Tickers</label>
        <input id="stocks-bigboard-symbols" type="text" value="${esc(bigBoard)}" placeholder="AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA">
        <p class="muted" style="margin-top:6px;font-size:12px;">Comma-separated. Tiles wrap automatically; ~8–16 looks best on a 1080p TV.</p>
      </div>
      <div class="form-row">
        <label>Display change as</label>
        <div style="display:flex;gap:18px;align-items:center;">
          <label class="toggle-row"><input type="radio" name="bb-mode" value="percent" ${mode === 'percent' ? 'checked' : ''}><span>Percent (%)</span></label>
          <label class="toggle-row"><input type="radio" name="bb-mode" value="dollar"  ${mode === 'dollar'  ? 'checked' : ''}><span>Dollar amount ($)</span></label>
        </div>
      </div>
    </div>

    <div class="btn-row"><button class="btn btn-primary" id="save-stocks">💾 Save</button></div>
  `;

  $('save-stocks').addEventListener('click', async () => {
    const stockIndices = Array.from(document.querySelectorAll('[data-stock-index]'))
      .filter(c => c.checked)
      .map(c => c.dataset.stockIndex);
    const parseList = (s) => String(s || '')
      .split(/[,\s]+/)
      .map(t => t.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 50);
    const stockOverviewSymbols = parseList($('stocks-overview-extras').value);
    const stockBigBoardSymbols = parseList($('stocks-bigboard-symbols').value);
    const stockBigBoardMode = document.querySelector('input[name="bb-mode"]:checked')?.value === 'dollar' ? 'dollar' : 'percent';
    await saveCurrentConfig({ stockIndices, stockOverviewSymbols, stockBigBoardSymbols, stockBigBoardMode });
    toast('Stocks settings saved');
  });
}

// ── Tab: Cameras ─────────────────────────────────────────────────
async function renderCamerasTab(body, cfg) {
  body.innerHTML = `<div class="card"><div class="card-title"><span class="icon">📷</span> Cameras</div><div class="muted">Loading cameras from UniFi Protect…</div></div>`;
  let discovered = [];
  let discoverError = null;
  try {
    const r = await fetch('/api/unifi/cameras');
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.cameras || j.data || []);
    discovered = arr.map(c => ({ id: c.id, name: c.name || 'Camera' }));
  } catch (e) { discoverError = e.message; }

  // Merge config + discovered: preserve config order, add unknown discovered
  // ones at the end, drop config entries whose camera no longer exists.
  const configList = cfg.cameraList || [];
  const known = new Map(discovered.map(c => [c.id, c]));
  let list = [];
  for (const c of configList) {
    if (known.has(c.id)) {
      list.push({ ...known.get(c.id), shape: c.shape || 'wide', enabled: c.enabled !== false, ...c });
      known.delete(c.id);
    }
  }
  for (const c of known.values()) list.push({ ...c, shape: 'wide', enabled: true });

  const draw = () => {
    body.innerHTML = `
      <div class="card">
        <div class="card-title"><span class="icon">📷</span> Cameras</div>
        <p class="muted">
          Reorder with the arrows, choose a shape that matches each camera's true aspect ratio
          (Wide for landscape, Tall for doorbell-style portrait, Square for compact, Large for a
          hero tile), and toggle off any cameras you don't want on the wall.
        </p>
        ${discoverError ? `<div class="muted" style="color:var(--danger);margin-bottom:12px;">⚠ Couldn't reach UniFi Protect: ${esc(discoverError)}. Add credentials in Settings → UniFi.</div>` : ''}
        ${!list.length ? '<div class="muted">No cameras found.</div>' : `
          <div id="cam-rows">
            ${list.map((c, i) => `
              <div class="cam-row" data-i="${i}">
                <div class="cam-row-arrows">
                  <button class="btn btn-outline btn-sm cam-up"   ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
                  <button class="btn btn-outline btn-sm cam-down" ${i === list.length-1 ? 'disabled' : ''} title="Move down">▼</button>
                </div>
                <input type="text" class="cam-name-in" data-i="${i}" value="${esc(c.name)}" placeholder="Display name">
                <select class="cam-shape-in" data-i="${i}">
                  <option value="wide"   ${c.shape === 'wide'   ? 'selected' : ''}>Wide (2×1)</option>
                  <option value="tall"   ${c.shape === 'tall'   ? 'selected' : ''}>Tall (1×2)</option>
                  <option value="square" ${c.shape === 'square' ? 'selected' : ''}>Square (1×1)</option>
                  <option value="large"  ${c.shape === 'large'  ? 'selected' : ''}>Large (3×2)</option>
                </select>
                <label class="cam-enable">
                  <input type="checkbox" class="cam-enabled-in" data-i="${i}" ${c.enabled ? 'checked' : ''}>
                  <span>Show</span>
                </label>
                <span class="cam-id muted" title="${esc(c.id)}">${esc(String(c.id).slice(0, 8))}…</span>
              </div>
            `).join('')}
          </div>
          <div class="btn-row" style="margin-top:14px;">
            <button class="btn btn-primary" id="save-cams">💾 Save</button>
          </div>
        `}
      </div>
    `;
    wireRowHandlers();
  };
  const wireRowHandlers = () => {
    body.querySelectorAll('.cam-up').forEach(b => {
      b.addEventListener('click', () => {
        const i = +b.closest('.cam-row').dataset.i;
        if (i > 0) { [list[i-1], list[i]] = [list[i], list[i-1]]; draw(); }
      });
    });
    body.querySelectorAll('.cam-down').forEach(b => {
      b.addEventListener('click', () => {
        const i = +b.closest('.cam-row').dataset.i;
        if (i < list.length - 1) { [list[i+1], list[i]] = [list[i], list[i+1]]; draw(); }
      });
    });
    body.querySelectorAll('.cam-name-in').forEach(inp => {
      inp.addEventListener('input', () => { list[+inp.dataset.i].name = inp.value; });
    });
    body.querySelectorAll('.cam-shape-in').forEach(sel => {
      sel.addEventListener('change', () => { list[+sel.dataset.i].shape = sel.value; });
    });
    body.querySelectorAll('.cam-enabled-in').forEach(cb => {
      cb.addEventListener('change', () => { list[+cb.dataset.i].enabled = cb.checked; });
    });
    const save = body.querySelector('#save-cams');
    if (save) save.addEventListener('click', async () => {
      await saveCurrentConfig({
        cameraList: list.map(c => ({ id: c.id, name: c.name, shape: c.shape, enabled: c.enabled })),
      });
      toast('Cameras saved');
    });
  };
  draw();
}

// ── Tab: Meeting Rooms ───────────────────────────────────────────
function renderMeetingRoomsTab(body, cfg) {
  // Always present 6 slots so the layout matches the signage tile grid.
  const rooms = (cfg.meetingRooms && cfg.meetingRooms.length === 6)
    ? cfg.meetingRooms
    : Array.from({ length: 6 }, (_, i) => (cfg.meetingRooms?.[i]) || { name: '', url: '' });
  const soonMins = Number(cfg.meetingRoomsSoonMins) || 30;
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🚪</span> Meeting Rooms</div>
      <p class="muted">
        Each room has its own Google Calendar. Paste the iCal URL (Calendar
        settings → "Secret address in iCal format"). Status is computed live:
        <strong style="color:#00dc64;">Available</strong>, <strong style="color:#ffaa1a;">Upcoming</strong>
        (within the warning window), or <strong style="color:#ff5050;">In Use</strong>.
      </p>
      ${rooms.map((r, i) => `
        <div class="room-row">
          <div class="room-row-num">${i + 1}</div>
          <input type="text" class="room-name-in" data-i="${i}" placeholder="Room name" value="${esc(r.name || '')}">
          <input type="url"  class="room-url-in"  data-i="${i}" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" value="${esc(r.url || '')}">
          <button class="btn btn-outline btn-sm room-test" data-i="${i}">Test</button>
          <span class="room-test-result" data-i="${i}"></span>
        </div>
      `).join('')}
      <div class="form-row" style="margin-top:18px;">
        <label>Upcoming warning window (minutes)</label>
        <input type="number" id="rooms-soon" min="1" max="240" value="${soonMins}" style="max-width:120px;">
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-rooms">💾 Save</button></div>
    </div>
  `;
  $('save-rooms').addEventListener('click', async () => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      out.push({
        name: document.querySelector(`.room-name-in[data-i="${i}"]`).value.trim(),
        url:  document.querySelector(`.room-url-in[data-i="${i}"]`).value.trim(),
      });
    }
    const soon = Math.max(1, Math.min(240, parseInt($('rooms-soon').value, 10) || 30));
    await saveCurrentConfig({ meetingRooms: out, meetingRoomsSoonMins: soon });
    toast('Meeting rooms saved');
  });
  document.querySelectorAll('.room-test').forEach(b => {
    b.addEventListener('click', async () => {
      const i = b.dataset.i;
      const url = document.querySelector(`.room-url-in[data-i="${i}"]`).value.trim();
      const out = document.querySelector(`.room-test-result[data-i="${i}"]`);
      out.textContent = '⏳';
      if (!url) { out.innerHTML = '<span style="color:var(--danger);">URL required</span>'; return; }
      try {
        const r = await api('/api/calendar/test', { method: 'POST', body: { url } });
        out.innerHTML = `<span style="color:#1ea660;">✅ ${r.count} events</span>`;
      } catch (e) {
        out.innerHTML = `<span style="color:var(--danger);">❌ ${esc(e.message || 'failed')}</span>`;
      }
    });
  });
}

// ── Tab: Google Slides ───────────────────────────────────────────
function renderSlidesTab(body, cfg) {
  const seconds = Number(cfg.slidesSeconds) || 5;
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📽️</span> Google Slides</div>
      <p class="muted">
        Paste a Google Slides URL (share, edit, or embed link) to play the deck as a zone.
        Make sure the presentation is shared as <strong>"Anyone with the link can view"</strong>
        or <strong>published to the web</strong> (File → Share → Publish to web), otherwise the
        embed will fail to load.
      </p>
      <div class="form-row">
        <label>Presentation URL</label>
        <input type="url" id="slides-url" value="${esc(cfg.slidesUrl || '')}"
          placeholder="https://docs.google.com/presentation/d/…/edit">
      </div>
      <div class="form-row">
        <label>Seconds per slide</label>
        <input type="number" id="slides-seconds" min="1" max="600" value="${seconds}">
        <p class="muted" style="margin-top:6px;font-size:12px;">
          How long each slide is shown before advancing. The whole zone stays on screen for
          the normal rotation interval — increase it on the Rotation tab if you want the
          deck to play through more slides per visit.
        </p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="save-slides">💾 Save</button>
      </div>
    </div>
  `;
  $('save-slides').addEventListener('click', async () => {
    const url = $('slides-url').value.trim();
    const secs = Math.max(1, Math.min(600, parseInt($('slides-seconds').value, 10) || 5));
    await saveCurrentConfig({ slidesUrl: url, slidesSeconds: secs });
    toast('Slides saved');
  });
}

function renderTrendsTab(body, cfg) {
  const countries = ['US','CA','GB','AU','DE','FR','IN','JP'];
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🔥</span> Trends</div>
      <div class="form-row"><label>Country</label>
        <select id="trends-country">${countries.map(c => `<option value="${c}" ${cfg.trendsCountry === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-trends">💾 Save</button></div>
    </div>
  `;
  $('save-trends').addEventListener('click', async () => {
    await saveCurrentConfig({ trendsCountry: $('trends-country').value });
    toast('Trends saved');
  });
}

// ── Tab: Radar ───────────────────────────────────────────────────
function renderRadarTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🌧️</span> Weather Radar</div>
      <div class="form-row"><label>Location label</label><input type="text" id="radar-label" value="${esc(cfg.radarLabel || '')}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row"><label>Latitude</label><input type="number" id="radar-lat" step="0.0001" value="${esc(cfg.radarLat || '')}"></div>
        <div class="form-row"><label>Longitude</label><input type="number" id="radar-lon" step="0.0001" value="${esc(cfg.radarLon || '')}"></div>
      </div>
      <div class="form-row"><label>Look up by ZIP / city</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="radar-lookup" placeholder="06804 or Brookfield, CT">
          <button class="btn btn-outline" id="radar-lookup-btn">🔎 Lookup</button>
        </div>
        <div id="radar-lookup-result" class="muted" style="margin-top:6px;"></div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-radar">💾 Save</button></div>
    </div>
  `;
  $('radar-lookup-btn').addEventListener('click', async () => {
    const q = $('radar-lookup').value.trim();
    if (!q) return;
    const out = $('radar-lookup-result');
    out.textContent = 'Looking up…';
    const hit = await geocode(q);
    if (!hit) { out.textContent = '✗ Not found'; return; }
    $('radar-lat').value = hit.lat.toFixed(4);
    $('radar-lon').value = hit.lon.toFixed(4);
    if (!$('radar-label').value.trim()) $('radar-label').value = hit.label;
    out.textContent = `✓ ${hit.label}`;
  });
  $('save-radar').addEventListener('click', async () => {
    await saveCurrentConfig({
      radarLat: parseFloat($('radar-lat').value) || 0,
      radarLon: parseFloat($('radar-lon').value) || 0,
      radarLabel: $('radar-label').value.trim(),
    });
    toast('Radar saved');
  });
}

// ── Tab: Traffic ─────────────────────────────────────────────────
function renderTrafficTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🚗</span> Traffic</div>
      <div class="form-row"><label>Location label</label><input type="text" id="t-label" value="${esc(cfg.trafficLabel || '')}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row"><label>Latitude</label><input type="number" id="t-lat" step="0.0001" value="${esc(cfg.trafficLat || '')}"></div>
        <div class="form-row"><label>Longitude</label><input type="number" id="t-lon" step="0.0001" value="${esc(cfg.trafficLon || '')}"></div>
      </div>
      <div class="form-row"><label>Zoom (10 = city, 13 = neighbourhood)</label><input type="number" id="t-zoom" min="6" max="18" value="${esc(cfg.trafficZoom || 11)}"></div>
      <div class="form-row"><label>Look up by ZIP / city</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="t-lookup" placeholder="06804 or Brookfield, CT">
          <button class="btn btn-outline" id="t-lookup-btn">🔎 Lookup</button>
        </div>
        <div id="t-lookup-result" class="muted" style="margin-top:6px;"></div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-traffic">💾 Save</button></div>
    </div>
  `;
  $('t-lookup-btn').addEventListener('click', async () => {
    const q = $('t-lookup').value.trim();
    if (!q) return;
    const out = $('t-lookup-result');
    out.textContent = 'Looking up…';
    const hit = await geocode(q);
    if (!hit) { out.textContent = '✗ Not found'; return; }
    $('t-lat').value = hit.lat.toFixed(4);
    $('t-lon').value = hit.lon.toFixed(4);
    if (!$('t-label').value.trim()) $('t-label').value = hit.label;
    out.textContent = `✓ ${hit.label}`;
  });
  $('save-traffic').addEventListener('click', async () => {
    await saveCurrentConfig({
      trafficLat: parseFloat($('t-lat').value) || 0,
      trafficLon: parseFloat($('t-lon').value) || 0,
      trafficZoom: parseInt($('t-zoom').value) || 11,
      trafficLabel: $('t-label').value.trim(),
    });
    toast('Traffic saved');
  });
}

// ── Tab: Rotation ────────────────────────────────────────────────
function renderRotationTab(body, cfg) {
  const sec = Math.round((cfg.rotationMs || 15000) / 1000);
  // Slider goes 5..120 linearly. Position each tick label at its real percentage.
  const MIN = 5, MAX = 120;
  const TICKS = [5, 15, 30, 60, 90, 120];
  const pct = (v) => ((v - MIN) / (MAX - MIN)) * 100;
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">⏱️</span> Zone Rotation Speed</div>
      <p class="muted">How long each zone is shown before auto-advancing. Per-zone overrides live in the Zones tab.</p>
      <div style="font-size:28px;color:var(--accent);text-align:center;font-weight:200;margin:12px 0;" id="rot-disp">${sec}s</div>
      <input type="range" id="rot-slider" min="${MIN}" max="${MAX}" step="5" value="${sec}" style="width:100%;display:block;">
      <div style="position:relative;height:18px;margin-top:4px;font-size:11px;color:var(--subtext);">
        ${TICKS.map(v => `
          <span style="position:absolute;left:${pct(v)}%;transform:translateX(-50%);white-space:nowrap;cursor:pointer;" data-tick="${v}">${v}s</span>
        `).join('')}
      </div>
      <div class="btn-row" style="margin-top:16px;"><button class="btn btn-primary" id="save-rot">💾 Save</button></div>
    </div>
  `;
  $('rot-slider').addEventListener('input', () => $('rot-disp').textContent = $('rot-slider').value + 's');
  // Click any tick label to jump the slider to that value.
  body.querySelectorAll('[data-tick]').forEach(el => {
    el.addEventListener('click', () => {
      $('rot-slider').value = el.dataset.tick;
      $('rot-disp').textContent = el.dataset.tick + 's';
    });
  });
  $('save-rot').addEventListener('click', async () => {
    await saveCurrentConfig({ rotationMs: parseInt($('rot-slider').value) * 1000 });
    toast('Rotation saved');
  });
}

// ── Tab: Time Zone ───────────────────────────────────────────────
function renderTimezoneTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🌐</span> Time Zone</div>
      <div class="form-row"><label>Time zone</label>
        <select id="tz-select">
          <option value="">Browser local</option>
          ${TZ_LIST.map(tz => `<option value="${esc(tz)}" ${cfg.timezone === tz ? 'selected' : ''}>${esc(tz)}</option>`).join('')}
        </select>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="save-tz">💾 Save</button></div>
    </div>
  `;
  $('save-tz').addEventListener('click', async () => {
    await saveCurrentConfig({ timezone: $('tz-select').value });
    toast('Time zone saved');
  });
}

// ── Tab: World Clocks ────────────────────────────────────────────
// City catalogue mirrors the one in worldmap.js — kept in sync so the picker
// auto-fills lat/lon and tz when you choose a known city.
const CITY_CATALOG = [
  ['New York','America/New_York',40.7128,-74.0060],
  ['Los Angeles','America/Los_Angeles',34.0522,-118.2437],
  ['Chicago','America/Chicago',41.8781,-87.6298],
  ['Denver','America/Denver',39.7392,-104.9903],
  ['Phoenix','America/Phoenix',33.4484,-112.0740],
  ['Seattle','America/Los_Angeles',47.6062,-122.3321],
  ['San Francisco','America/Los_Angeles',37.7749,-122.4194],
  ['Boston','America/New_York',42.3601,-71.0589],
  ['Miami','America/New_York',25.7617,-80.1918],
  ['Dallas','America/Chicago',32.7767,-96.7970],
  ['Atlanta','America/New_York',33.7490,-84.3880],
  ['Washington DC','America/New_York',38.9072,-77.0369],
  ['Toronto','America/Toronto',43.6532,-79.3832],
  ['Montreal','America/Toronto',45.5017,-73.5673],
  ['Vancouver','America/Vancouver',49.2827,-123.1207],
  ['Mexico City','America/Mexico_City',19.4326,-99.1332],
  ['São Paulo','America/Sao_Paulo',-23.5505,-46.6333],
  ['Rio de Janeiro','America/Sao_Paulo',-22.9068,-43.1729],
  ['Buenos Aires','America/Argentina/Buenos_Aires',-34.6037,-58.3816],
  ['Lima','America/Lima',-12.0464,-77.0428],
  ['Bogotá','America/Bogota',4.7110,-74.0721],
  ['Santiago','America/Santiago',-33.4489,-70.6693],
  ['London','Europe/London',51.5074,-0.1278],
  ['Paris','Europe/Paris',48.8566,2.3522],
  ['Berlin','Europe/Berlin',52.5200,13.4050],
  ['Madrid','Europe/Madrid',40.4168,-3.7038],
  ['Rome','Europe/Rome',41.9028,12.4964],
  ['Amsterdam','Europe/Amsterdam',52.3676,4.9041],
  ['Stockholm','Europe/Stockholm',59.3293,18.0686],
  ['Oslo','Europe/Oslo',59.9139,10.7522],
  ['Helsinki','Europe/Helsinki',60.1699,24.9384],
  ['Copenhagen','Europe/Copenhagen',55.6761,12.5683],
  ['Dublin','Europe/Dublin',53.3498,-6.2603],
  ['Lisbon','Europe/Lisbon',38.7223,-9.1393],
  ['Vienna','Europe/Vienna',48.2082,16.3738],
  ['Zurich','Europe/Zurich',47.3769,8.5417],
  ['Warsaw','Europe/Warsaw',52.2297,21.0122],
  ['Prague','Europe/Prague',50.0755,14.4378],
  ['Athens','Europe/Athens',37.9838,23.7275],
  ['Moscow','Europe/Moscow',55.7558,37.6173],
  ['Istanbul','Europe/Istanbul',41.0082,28.9784],
  ['Cairo','Africa/Cairo',30.0444,31.2357],
  ['Lagos','Africa/Lagos',6.5244,3.3792],
  ['Nairobi','Africa/Nairobi',-1.2921,36.8219],
  ['Johannesburg','Africa/Johannesburg',-26.2041,28.0473],
  ['Cape Town','Africa/Johannesburg',-33.9249,18.4241],
  ['Casablanca','Africa/Casablanca',33.5731,-7.5898],
  ['Dubai','Asia/Dubai',25.2048,55.2708],
  ['Tel Aviv','Asia/Jerusalem',32.0853,34.7818],
  ['Riyadh','Asia/Riyadh',24.7136,46.6753],
  ['Tokyo','Asia/Tokyo',35.6762,139.6503],
  ['Seoul','Asia/Seoul',37.5665,126.9780],
  ['Beijing','Asia/Shanghai',39.9042,116.4074],
  ['Shanghai','Asia/Shanghai',31.2304,121.4737],
  ['Hong Kong','Asia/Hong_Kong',22.3193,114.1694],
  ['Taipei','Asia/Taipei',25.0330,121.5654],
  ['Singapore','Asia/Singapore',1.3521,103.8198],
  ['Bangkok','Asia/Bangkok',13.7563,100.5018],
  ['Kuala Lumpur','Asia/Kuala_Lumpur',3.1390,101.6869],
  ['Jakarta','Asia/Jakarta',-6.2088,106.8456],
  ['Manila','Asia/Manila',14.5995,120.9842],
  ['Mumbai','Asia/Kolkata',19.0760,72.8777],
  ['Delhi','Asia/Kolkata',28.6139,77.2090],
  ['Kolkata','Asia/Kolkata',22.5726,88.3639],
  ['Bangalore','Asia/Kolkata',12.9716,77.5946],
  ['Karachi','Asia/Karachi',24.8607,67.0011],
  ['Tehran','Asia/Tehran',35.6892,51.3890],
  ['Sydney','Australia/Sydney',-33.8688,151.2093],
  ['Melbourne','Australia/Melbourne',-37.8136,144.9631],
  ['Brisbane','Australia/Brisbane',-27.4698,153.0251],
  ['Perth','Australia/Perth',-31.9505,115.8605],
  ['Auckland','Pacific/Auckland',-36.8485,174.7633],
  ['Honolulu','Pacific/Honolulu',21.3069,-157.8583],
];

function renderWorldClocksTab(body, cfg) {
  let clocks = (cfg.worldClocks || []).slice();
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🌐</span> World Clocks</div>
      <p class="muted">Add up to 12 cities. Use the picker to auto-fill timezone and map coordinates.</p>
      <div class="form-row" style="display:flex;gap:8px;align-items:end;">
        <div style="flex:1;">
          <label>Add a city</label>
          <input type="text" id="wc-pick" list="wc-cities" placeholder="Start typing a city name…">
          <datalist id="wc-cities">${CITY_CATALOG.map(([name]) => `<option value="${esc(name)}">`).join('')}</datalist>
        </div>
        <button class="btn btn-primary" id="wc-add">+ Add</button>
      </div>
      <div id="wc-rows"></div>
      <div class="form-row" style="margin-top:14px;">
        <label>Card size</label>
        <select id="wc-size">
          ${SIZE_OPTIONS.filter(([v]) => v !== 'xl').map(([v, l]) => `<option value="${v}" ${(cfg.worldClockSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-outline" id="wc-sort" title="Reorder cities west-to-east by current UTC offset">↔ Auto-arrange by time zone</button>
        <button class="btn btn-primary" id="wc-save">💾 Save</button>
      </div>
    </div>
  `;
  function renderRows() {
    $('wc-rows').innerHTML = clocks.map((c, i) => `
      <div class="form-row" style="display:grid;grid-template-columns:1fr 1.5fr 90px 90px 90px auto;gap:10px;align-items:end;">
        <div><label>Label</label><input type="text" value="${esc(c.label || '')}" data-i="${i}" data-k="label" placeholder="New York"></div>
        <div><label>Time zone</label>
          <select data-i="${i}" data-k="tz">
            ${TZ_LIST.map(tz => `<option value="${esc(tz)}" ${c.tz === tz ? 'selected' : ''}>${esc(tz)}</option>`).join('')}
          </select>
        </div>
        <div><label>Lat</label><input type="number" step="0.0001" value="${c.lat ?? ''}" data-i="${i}" data-k="lat" placeholder="auto"></div>
        <div><label>Lon</label><input type="number" step="0.0001" value="${c.lon ?? ''}" data-i="${i}" data-k="lon" placeholder="auto"></div>
        <div><label>Style</label>
          <select data-i="${i}" data-k="style">
            <option value="analog"  ${c.style === 'analog'  ? 'selected' : ''}>Analog</option>
            <option value="digital" ${c.style === 'digital' ? 'selected' : ''}>Digital</option>
          </select>
        </div>
        <div><button class="btn btn-danger btn-sm" data-del="${i}">✕</button></div>
      </div>
    `).join('') || '<div class="muted">No clocks. Add one above.</div>';
    $('wc-rows').querySelectorAll('input,select').forEach(inp => {
      const handler = () => {
        const k = inp.dataset.k;
        let v = inp.value;
        if (k === 'lat' || k === 'lon') v = v === '' ? null : parseFloat(v);
        clocks[+inp.dataset.i][k] = v;
      };
      inp.addEventListener('change', handler);
      inp.addEventListener('input', handler);
    });
    $('wc-rows').querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => { clocks.splice(+b.dataset.del, 1); renderRows(); });
    });
  }
  renderRows();
  $('wc-add').addEventListener('click', () => {
    if (clocks.length >= 12) return toast('Max 12 clocks', true);
    const name = $('wc-pick').value.trim();
    if (!name) return toast('Type a city name first', true);
    const known = CITY_CATALOG.find(([n]) => n.toLowerCase() === name.toLowerCase());
    if (known) {
      clocks.push({ label: known[0], tz: known[1], lat: known[2], lon: known[3], style: 'digital' });
    } else {
      // Unknown — let the user fill it in manually
      clocks.push({ label: name, tz: 'UTC', lat: null, lon: null, style: 'digital' });
    }
    $('wc-pick').value = '';
    renderRows();
  });
  $('wc-pick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('wc-add').click(); } });
  $('wc-sort').addEventListener('click', () => {
    if (clocks.length < 2) return toast('Need at least 2 clocks to sort', true);
    clocks.sort((a, b) => tzOffsetMinutes(a.tz) - tzOffsetMinutes(b.tz));
    renderRows();
    toast('Sorted west → east — remember to save');
  });
  $('wc-save').addEventListener('click', async () => {
    await saveCurrentConfig({ worldClocks: clocks, worldClockSize: $('wc-size').value });
    toast('World clocks saved');
  });
}

// Get the current UTC offset (in minutes) for an IANA timezone.
// Works by asking Intl for the longOffset like "GMT-05:00" right now.
function tzOffsetMinutes(tz) {
  if (!tz) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date());
    const part = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    // Format: "GMT-05:00" or "GMT+05:30" or just "GMT"
    const m = part.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const hours = parseInt(m[2]);
    const mins  = parseInt(m[3] || '0');
    return sign * (hours * 60 + mins);
  } catch (_) {
    return 0;
  }
}

// ── Tab: Sun Arc ─────────────────────────────────────────────────
function renderSunArcTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">☀️</span> Sun Arc</div>
      <p class="muted">Shows the sun's position over today's sunrise → sunset arc. Leave coordinates blank to reuse the Traffic location.</p>
      <div class="form-row"><label>Location label</label><input type="text" id="sa-label" value="${esc(cfg.sunArcLabel || '')}" placeholder="(uses Traffic label)"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row"><label>Latitude</label><input type="number" id="sa-lat" step="0.0001" value="${cfg.sunArcLat ?? ''}"></div>
        <div class="form-row"><label>Longitude</label><input type="number" id="sa-lon" step="0.0001" value="${cfg.sunArcLon ?? ''}"></div>
      </div>
      <div class="form-row"><label>Look up by ZIP / city</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="sa-lookup" placeholder="e.g. 06804">
          <button class="btn btn-outline" id="sa-lookup-btn">🔎 Lookup</button>
        </div>
      </div>
      <div class="form-row"><label>Display size</label>
        <select id="sa-size">
          ${SIZE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cfg.sunArcSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <p class="muted" style="margin-top:6px;font-size:12px;">Scales the arc, sunrise/sunset/daylight row, and 3-day forecast cards together.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="sa-save">💾 Save</button></div>
    </div>
  `;
  $('sa-lookup-btn').addEventListener('click', async () => {
    const q = $('sa-lookup').value.trim(); if (!q) return;
    const hit = await geocode(q); if (!hit) return toast('Not found', true);
    $('sa-lat').value = hit.lat.toFixed(4);
    $('sa-lon').value = hit.lon.toFixed(4);
    if (!$('sa-label').value.trim()) $('sa-label').value = hit.label;
  });
  $('sa-save').addEventListener('click', async () => {
    const lat = $('sa-lat').value.trim(), lon = $('sa-lon').value.trim();
    await saveCurrentConfig({
      sunArcLat: lat === '' ? null : parseFloat(lat),
      sunArcLon: lon === '' ? null : parseFloat(lon),
      sunArcLabel: $('sa-label').value.trim(),
      sunArcSize: $('sa-size').value,
    });
    toast('Sun Arc saved');
  });
}

// ── Tab: Calendar ────────────────────────────────────────────────
function renderCalendarTab(body, cfg) {
  let cals = (cfg.calendars || []).slice();
  const daysAhead = Number(cfg.calendarDaysAhead) || 14;
  const maxEvents = Number(cfg.calendarMaxEvents) || 8;
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📅</span> Calendars</div>
      <p class="muted">Subscribe to one or more public iCal URLs. In Google Calendar: Settings → "Integrate calendar" → <strong>Public address in iCal format</strong>. Each calendar can have its own colour.</p>
      <div id="cal-rows"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-outline" id="cal-add">+ Add Calendar</button>
        <button class="btn btn-primary" id="cal-save">💾 Save</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">⚙️</span> Display Options</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div class="form-row">
          <label>Days ahead to fetch</label>
          <input type="number" id="cal-days" min="1" max="60" value="${daysAhead}">
          <p class="muted" style="margin-top:6px;font-size:12px;">How far into the future to pull events from each calendar (1–60 days).</p>
        </div>
        <div class="form-row">
          <label>Max events shown</label>
          <input type="number" id="cal-max" min="1" max="50" value="${maxEvents}">
          <p class="muted" style="margin-top:6px;font-size:12px;">How many events the Calendar zone displays at once (1–50).</p>
        </div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="cal-save-opts">💾 Save</button></div>
    </div>
  `;
  function renderRows() {
    $('cal-rows').innerHTML = cals.map((c, i) => `
      <div class="form-row" style="display:grid;grid-template-columns:1fr 2fr 60px 80px auto;gap:10px;align-items:end;">
        <div><label>Name</label><input type="text" value="${esc(c.name || '')}" data-i="${i}" data-k="name" placeholder="Team"></div>
        <div><label>iCal URL</label><input type="url" value="${esc(c.url || '')}" data-i="${i}" data-k="url" placeholder="https://calendar.google.com/calendar/ical/.../public/basic.ics"></div>
        <div><label>Color</label><input type="color" value="${esc(c.color || '#58a6ff')}" data-i="${i}" data-k="color"></div>
        <div><button class="btn btn-outline btn-sm" data-test="${i}">🔍 Test</button></div>
        <div><button class="btn btn-danger btn-sm" data-del="${i}">✕</button></div>
      </div>
    `).join('') || '<div class="muted">No calendars. Add one.</div>';
    $('cal-rows').querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => { cals[+inp.dataset.i][inp.dataset.k] = inp.value; });
    });
    $('cal-rows').querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => { cals.splice(+b.dataset.del, 1); renderRows(); });
    });
    $('cal-rows').querySelectorAll('[data-test]').forEach(b => {
      b.addEventListener('click', async () => {
        const c = cals[+b.dataset.test];
        if (!c.url) return toast('URL required', true);
        try {
          const r = await api('/api/calendar/test', { method: 'POST', body: { url: c.url } });
          toast(`✓ Found ${r.count} events`);
        } catch (e) { toast(e.message, true); }
      });
    });
  }
  renderRows();
  $('cal-add').addEventListener('click', () => { cals.push({ name: '', url: '', color: '#58a6ff' }); renderRows(); });
  $('cal-save').addEventListener('click', async () => {
    await saveCurrentConfig({ calendars: cals.filter(c => c.url) });
    toast('Calendars saved');
  });
  $('cal-save-opts').addEventListener('click', async () => {
    const d = Math.max(1, Math.min(60, parseInt($('cal-days').value, 10) || 14));
    const m = Math.max(1, Math.min(50, parseInt($('cal-max').value, 10) || 8));
    await saveCurrentConfig({ calendarDaysAhead: d, calendarMaxEvents: m });
    toast('Display options saved');
  });
}

// ── Tab: Today's Number ──────────────────────────────────────────
function renderBigNumTab(body, cfg) {
  const mode = cfg.bigNumMode || 'countup';
  const todayStr = new Date().toISOString().slice(0, 10);
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">💯</span> Today's Number</div>
      <p class="muted">A big-number zone for things like "Days since last incident" — auto-counts up — or any other static metric.</p>
      <div class="form-row"><label>Mode</label>
        <select id="bn-mode">
          <option value="countup" ${mode === 'countup' ? 'selected' : ''}>Count-up days from a start date</option>
          <option value="static"  ${mode === 'static'  ? 'selected' : ''}>Static value (manual)</option>
        </select>
      </div>
      <div class="form-row"><label>Label (small text above)</label>
        <input type="text" id="bn-label" value="${esc(cfg.bigNumLabel || '')}" placeholder="Days since last incident">
      </div>
      <div id="bn-countup" style="display:${mode === 'countup' ? 'block' : 'none'};">
        <div class="form-row"><label>Counting from</label>
          <div style="display:flex;gap:8px;">
            <input type="date" id="bn-startdate" value="${esc(cfg.bigNumStartDate || todayStr)}">
            <button class="btn btn-outline btn-sm" id="bn-reset" title="Reset count to 0 (set start date to today)">↺ Reset to 0</button>
          </div>
          <div class="muted" style="margin-top:6px;">Current count: <strong id="bn-current-count">${dayDelta(cfg.bigNumStartDate)}</strong></div>
        </div>
      </div>
      <div id="bn-staticgrp" style="display:${mode === 'static' ? 'block' : 'none'};">
        <div class="form-row"><label>Value</label>
          <input type="text" id="bn-value" value="${esc(cfg.bigNumValue || '')}" placeholder="0">
        </div>
      </div>
      <div class="form-row"><label>Unit (optional)</label>
        <input type="text" id="bn-unit" value="${esc(cfg.bigNumUnit || '')}" placeholder="days">
      </div>
      <div class="form-row"><label>Sub-line (optional)</label>
        <input type="text" id="bn-sub" value="${esc(cfg.bigNumSubline || '')}" placeholder="Personal best: 247">
      </div>
      <div class="form-row"><label>Display size</label>
        <select id="bn-size">
          ${SIZE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cfg.bigNumSize || 'large') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="bn-save">💾 Save</button></div>
    </div>
  `;
  $('bn-mode').addEventListener('change', () => {
    const m = $('bn-mode').value;
    $('bn-countup').style.display  = m === 'countup' ? 'block' : 'none';
    $('bn-staticgrp').style.display = m === 'static'  ? 'block' : 'none';
  });
  $('bn-startdate').addEventListener('change', () => {
    const el = $('bn-current-count');
    if (el) el.textContent = dayDelta($('bn-startdate').value);
  });
  $('bn-reset').addEventListener('click', async () => {
    if (!confirm('Reset the counter to 0? This sets the start date to today.')) return;
    const today = new Date().toISOString().slice(0, 10);
    $('bn-startdate').value = today;
    $('bn-current-count').textContent = '0';
    await saveCurrentConfig({ bigNumStartDate: today, bigNumMode: 'countup' });
    toast('Counter reset to 0');
  });
  $('bn-save').addEventListener('click', async () => {
    await saveCurrentConfig({
      bigNumMode:      $('bn-mode').value,
      bigNumLabel:     $('bn-label').value,
      bigNumValue:     $('bn-value').value,
      bigNumUnit:      $('bn-unit').value,
      bigNumSubline:   $('bn-sub').value,
      bigNumStartDate: $('bn-startdate').value,
      bigNumSize:      $('bn-size').value,
    });
    toast('Saved');
  });
}

// Helper: how many whole days from a YYYY-MM-DD string to today's local midnight.
function dayDelta(startDateStr) {
  if (!startDateStr) return '—';
  const m = String(startDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  const start = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return String(Math.max(0, Math.round((today - start) / (24 * 3600 * 1000))));
}

// ── Tab: Idle / Overnight ────────────────────────────────────────
function renderQuietTab(body, cfg) {
  body.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🌙</span> Idle / Overnight Mode</div>
      <p class="muted">When the warehouse is closed, hide content and show a minimal display (or go fully black to save the TV's panel).</p>
      <div class="form-row" style="display:flex;align-items:center;gap:12px;">
        <label style="margin:0;">Enabled</label>
        <label class="toggle"><input type="checkbox" id="q-en" ${cfg.quietEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-row"><label>Start (HH:MM, screen-local)</label><input type="time" id="q-start" value="${esc(cfg.quietStart || '20:00')}"></div>
        <div class="form-row"><label>End (HH:MM)</label><input type="time" id="q-end" value="${esc(cfg.quietEnd || '06:00')}"></div>
      </div>
      <div class="form-row"><label>Mode</label>
        <select id="q-mode">
          <option value="black"   ${cfg.quietMode === 'black'   ? 'selected' : ''}>Black screen (TV power-save)</option>
          <option value="minimal" ${cfg.quietMode === 'minimal' ? 'selected' : ''}>Minimal clock</option>
          <option value="message" ${cfg.quietMode === 'message' ? 'selected' : ''}>Custom message</option>
        </select>
      </div>
      <div class="form-row"><label>Message (only used in "Custom message" mode)</label>
        <textarea id="q-msg">${esc(cfg.quietMessage || '')}</textarea>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="q-save">💾 Save</button></div>
    </div>
  `;
  $('q-save').addEventListener('click', async () => {
    await saveCurrentConfig({
      quietEnabled: $('q-en').checked,
      quietStart:   $('q-start').value,
      quietEnd:     $('q-end').value,
      quietMode:    $('q-mode').value,
      quietMessage: $('q-msg').value,
    });
    toast('Saved');
  });
}

// ── Geocoding helper ─────────────────────────────────────────────
async function geocode(q) {
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`);
    const j = await r.json();
    const hit = j.results?.[0];
    if (hit) return { lat: hit.latitude, lon: hit.longitude, label: `${hit.name}${hit.admin1 ? ', ' + hit.admin1 : ''}` };
  } catch (_) {}
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (hit) return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: hit.display_name.split(',').slice(0,2).join(', ') };
  } catch (_) {}
  return null;
}

// ── Assets page ──────────────────────────────────────────────────
async function renderAssets() {
  if (ws) try { ws.close(); } catch(_) {}
  $('topbar-title').textContent = 'Asset Library';
  $('topbar-actions').innerHTML = '';
  $('content').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">⬆️</span> Upload Files</div>
      <label class="dropzone" id="dz">
        <div class="dz-icon">📁</div>
        <div class="dz-label">Click or drop files here</div>
        <div class="dz-hint">PNG · JPG · SVG · GIF · WebP — max 8 MB each</div>
        <input type="file" id="file-input" accept="image/*" multiple>
      </label>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🖼️</span> Library</div>
      <div class="assets-grid" id="assets-grid"><div class="muted">Loading…</div></div>
    </div>
  `;
  setupDropzone();
  loadAssetsList();
}

function setupDropzone() {
  const dz = $('dz');
  const inp = $('file-input');
  inp.addEventListener('change', async () => {
    for (const f of inp.files) await uploadOne(f);
    inp.value = '';
    loadAssetsList();
  });
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', async (e) => {
    for (const f of e.dataTransfer.files) await uploadOne(f);
    loadAssetsList();
  });
}

async function uploadOne(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/uploads', { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok) toast(j.error || 'Upload failed', true);
  else toast(`Uploaded ${file.name}`);
}

async function loadAssetsList() {
  const j = await api('/api/uploads');
  state.assets = j.uploads || [];
  const grid = $('assets-grid');
  if (!state.assets.length) { grid.innerHTML = '<div class="muted">No uploads yet.</div>'; return; }
  grid.innerHTML = state.assets.map(a => `
    <div class="asset-card" data-id="${esc(a.id)}">
      <div class="thumb"><img src="${esc(a.url)}" alt=""></div>
      <div class="name-row">
        <div class="name" title="${esc(a.filename)}">${esc(a.filename)}</div>
        <div class="actions">
          <button class="asset-rename" data-rename="${esc(a.id)}" title="Rename">✎</button>
          <button class="asset-del" data-del="${esc(a.id)}" title="Delete">✕</button>
        </div>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this asset?')) return;
      await api(`/api/uploads/${b.dataset.del}`, { method: 'DELETE' });
      loadAssetsList();
    });
  });
  grid.querySelectorAll('[data-rename]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.rename;
      const cur = state.assets.find(a => a.id === id);
      const next = await textPromptModal({
        title: 'Rename File',
        label: 'File name',
        value: cur ? cur.filename : '',
        okText: 'Rename',
      });
      if (!next || (cur && next === cur.filename)) return;
      try {
        await api(`/api/uploads/${id}`, { method: 'PATCH', body: { filename: next } });
        toast('Renamed');
        loadAssetsList();
      } catch (err) {
        toast(err.message || 'Rename failed', true);
      }
    });
  });
}

// Modal asset picker (used by Logo)
// Generic in-app text prompt — replaces window.prompt() with a styled modal.
// Returns Promise<string|null>. Submit on Enter, cancel on Escape / backdrop.
function textPromptModal({ title, label, value = '', placeholder = '', okText = 'Save', okClass = 'btn-primary', helpText = '' } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg show';
    bg.innerHTML = `
      <div class="modal modal-prompt">
        <h2>${esc(title || '')}</h2>
        ${helpText ? `<p class="muted" style="margin-bottom:12px;">${esc(helpText)}</p>` : ''}
        <div class="form-row">
          ${label ? `<label>${esc(label)}</label>` : ''}
          <input type="text" id="pm-input" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
        </div>
        <div class="btn-row" style="margin-top:16px;justify-content:flex-end;">
          <button class="btn btn-outline" id="pm-cancel">Cancel</button>
          <button class="btn ${esc(okClass)}" id="pm-ok">${esc(okText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    const input = bg.querySelector('#pm-input');
    const ok = () => { const v = input.value.trim(); bg.remove(); resolve(v || null); };
    const cancel = () => { bg.remove(); resolve(null); };
    bg.querySelector('#pm-ok').addEventListener('click', ok);
    bg.querySelector('#pm-cancel').addEventListener('click', cancel);
    bg.addEventListener('click', (e) => { if (e.target === bg) cancel(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// Confirmation modal — Promise<bool>.
function confirmModal({ title, body, okText = 'Confirm', okClass = 'btn-primary' } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg show';
    bg.innerHTML = `
      <div class="modal modal-prompt">
        <h2>${esc(title || 'Confirm')}</h2>
        ${body ? `<p class="muted" style="margin-bottom:16px;">${esc(body)}</p>` : ''}
        <div class="btn-row" style="justify-content:flex-end;">
          <button class="btn btn-outline" id="cm-cancel">Cancel</button>
          <button class="btn ${esc(okClass)}" id="cm-ok">${esc(okText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('#cm-ok').addEventListener('click', () => done(true));
    bg.querySelector('#cm-cancel').addEventListener('click', () => done(false));
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
  });
}

// New-screen modal: name + optional template dropdown.
// Returns Promise<{ name, templateId } | null>.
function newScreenModal(templates = []) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg show';
    const opts = ['<option value="">— Blank (no template) —</option>']
      .concat(templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)).join('');
    bg.innerHTML = `
      <div class="modal modal-prompt">
        <h2>New Display</h2>
        <div class="form-row">
          <label>Display name</label>
          <input type="text" id="ns-name" placeholder='e.g. "Lobby", "Reception"' autocomplete="off">
        </div>
        <div class="form-row">
          <label>Start from template</label>
          <select id="ns-template">${opts}</select>
        </div>
        <div class="btn-row" style="margin-top:16px;justify-content:flex-end;">
          <button class="btn btn-outline" id="ns-cancel">Cancel</button>
          <button class="btn btn-primary" id="ns-ok">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    const nameEl = bg.querySelector('#ns-name');
    const tplEl = bg.querySelector('#ns-template');
    const ok = () => {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      bg.remove();
      resolve({ name, templateId: tplEl.value || null });
    };
    const cancel = () => { bg.remove(); resolve(null); };
    bg.querySelector('#ns-ok').addEventListener('click', ok);
    bg.querySelector('#ns-cancel').addEventListener('click', cancel);
    bg.addEventListener('click', (e) => { if (e.target === bg) cancel(); });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    setTimeout(() => nameEl.focus(), 30);
  });
}

function pickAssetModal() {
  return new Promise(async (resolve) => {
    const j = await api('/api/uploads');
    const assets = j.uploads || [];
    const bg = document.createElement('div');
    bg.className = 'modal-bg show';
    bg.innerHTML = `
      <div class="modal">
        <h2>Choose an asset</h2>
        ${assets.length ? `
          <div class="assets-grid">
            ${assets.map(a => `<div class="asset-card" data-id="${esc(a.id)}"><div class="thumb"><img src="${esc(a.url)}"></div><div class="name">${esc(a.filename)}</div></div>`).join('')}
          </div>
        ` : '<div class="muted">No uploads yet. Upload one in the Assets page first.</div>'}
        <div class="btn-row" style="margin-top:16px;justify-content:flex-end;">
          <button class="btn btn-outline" id="cancel-pick">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    bg.querySelectorAll('.asset-card').forEach(c => {
      c.addEventListener('click', () => { bg.remove(); resolve(c.dataset.id); });
    });
    bg.querySelector('#cancel-pick').addEventListener('click', () => { bg.remove(); resolve(null); });
    bg.addEventListener('click', (e) => { if (e.target === bg) { bg.remove(); resolve(null); } });
  });
}

// ── Broadcast page ───────────────────────────────────────────────
function renderBroadcast() {
  if (ws) try { ws.close(); } catch(_) {}
  $('topbar-title').textContent = 'Broadcast to All Screens';
  $('topbar-actions').innerHTML = '';
  $('content').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">📢</span> Send to ALL screens</div>
      <p class="muted">Broadcasts to every connected TV simultaneously.</p>
      <div class="form-row"><label>From</label><input type="text" id="b-from" placeholder="e.g. Management"></div>
      <div class="form-row"><label>Message</label><textarea id="b-body"></textarea></div>
      <div class="form-row"><label>Priority</label>
        <select id="b-priority"><option value="normal">Normal</option><option value="urgent">Urgent</option><option value="info">Info</option></select>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="b-send">📤 Broadcast</button></div>
    </div>

    <div class="card">
      <div class="card-title">
        <span class="icon">📋</span> All Sent Messages
        <button class="btn btn-outline btn-sm" id="b-refresh" style="margin-left:auto;">↻ Refresh</button>
      </div>
      <div class="msg-table-wrap">
        <table class="msg-table">
          <thead>
            <tr>
              <th style="width:160px;">Sent</th>
              <th style="width:140px;">From</th>
              <th>Message</th>
              <th style="width:160px;">Target</th>
              <th style="width:90px;">Priority</th>
              <th style="width:60px;"></th>
            </tr>
          </thead>
          <tbody id="b-rows"><tr><td colspan="6" class="muted" style="text-align:center;padding:20px;">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  `;
  $('b-send').addEventListener('click', async () => {
    const sender = $('b-from').value.trim() || 'Admin';
    const body = $('b-body').value.trim();
    const priority = $('b-priority').value;
    if (!body) return toast('Empty message', true);
    await api('/api/messages/*', { method: 'POST', body: { sender, body, priority } });
    $('b-body').value = '';
    toast('Broadcast sent to all screens');
    loadAllMessages();
  });
  $('b-refresh').addEventListener('click', loadAllMessages);
  loadAllMessages();
}

async function loadAllMessages() {
  const rowsEl = $('b-rows');
  if (!rowsEl) return;
  try {
    const { messages } = await api('/api/messages/all');
    if (!messages.length) {
      rowsEl.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px;">No messages yet.</td></tr>';
      return;
    }
    rowsEl.innerHTML = messages.map(m => {
      const target = m.target.kind === 'all'
        ? `<span class="target-pill target-all">All Screens</span>`
        : `<span class="target-pill target-one">${esc(m.target.name || m.target.slug)}</span>`;
      return `
        <tr data-id="${m.id}" data-target-slug="${esc(m.target.slug || '*')}">
          <td>${esc(formatDate(m.timestamp))}</td>
          <td>${esc(m.sender || 'Admin')}</td>
          <td class="msg-body" title="${esc(m.body)}">${esc(m.body)}</td>
          <td>${target}</td>
          <td><span class="prio-pill prio-${esc(m.priority)}">${esc(m.priority)}</span></td>
          <td><button class="btn btn-danger btn-sm msg-del" data-id="${m.id}" data-slug="${esc(m.target.slug || '*')}">✕</button></td>
        </tr>`;
    }).join('');
    rowsEl.querySelectorAll('.msg-del').forEach(b => {
      b.addEventListener('click', async () => {
        const ok = await confirmModal({ title: 'Delete this message?', body: 'It will also disappear from any TV currently showing it in the footer.', okText: 'Delete', okClass: 'btn-danger' });
        if (!ok) return;
        try {
          await api(`/api/messages/${b.dataset.slug}/${b.dataset.id}`, { method: 'DELETE' });
          toast('Deleted');
          loadAllMessages();
        } catch (e) { toast(e.message || 'Delete failed', true); }
      });
    });
  } catch (e) {
    rowsEl.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:20px;color:var(--danger);">${esc(e.message || 'Failed to load')}</td></tr>`;
  }
}

// ── Slack settings page ──────────────────────────────────────────
async function renderSlackPage() {
  if (ws) try { ws.close(); } catch(_) {}
  $('topbar-title').textContent = 'Slack Integration';
  $('topbar-actions').innerHTML = '';
  $('content').innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const data = await api('/api/slack');
    drawSlackPage(data);
  } catch (e) {
    $('content').innerHTML = `<div class="card"><div class="muted">Failed to load Slack settings: ${esc(e.message)}</div></div>`;
  }
}

function drawSlackPage(data) {
  const cfg = data.config || {};
  const st = data.status || {};
  const statusColor = st.connected ? 'var(--success)' : (st.lastError ? 'var(--danger)' : 'var(--subtext)');
  const statusText = st.connected ? '● Connected'
                   : st.configured ? '● Configured but not connected'
                   : '○ Not configured';
  const lastMsg = st.lastMessageAt ? formatDate(st.lastMessageAt) : 'never';

  $('content').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">💬</span> Slack → Signage</div>
      <p class="muted">Mirror messages from one Slack channel to every TV. Uses Socket Mode — no inbound port required, works behind firewalls.</p>
      <div style="display:flex;gap:18px;align-items:center;padding:8px 0 14px;color:${statusColor};flex-wrap:wrap;">
        <span style="font-weight:600;">${statusText}</span>
        ${st.connectedAs ? `<span class="muted" style="font-size:12px;">Bot user: <code>${esc(st.connectedAs)}</code></span>` : ''}
        <span class="muted" style="font-size:12px;">Last message mirrored: ${esc(lastMsg)}</span>
        <span class="muted" style="font-size:12px;">Events received since boot: <strong>${st.eventsReceived || 0}</strong> · Messages mirrored: <strong>${st.messagesReceived || 0}</strong></span>
      </div>
      ${st.lastError ? `<div style="background:rgba(248,81,73,0.08);border:1px solid var(--danger);border-radius:6px;padding:8px 12px;font-size:12px;color:var(--danger);margin-bottom:12px;">${esc(st.lastError)}</div>` : ''}

      <div class="form-row">
        <label>Bot Token (xoxb-…)</label>
        <input type="password" id="slack-bot" placeholder="${esc(cfg.botTokenMask || 'xoxb-…')}" autocomplete="off">
      </div>
      <div class="form-row">
        <label>App Token (xapp-…)</label>
        <input type="password" id="slack-app" placeholder="${esc(cfg.appTokenMask || 'xapp-…')}" autocomplete="off">
      </div>
      <div class="form-row">
        <label>Channel ID (e.g. <code>C0123456789</code>)</label>
        <input type="text" id="slack-channel" value="${esc(cfg.channelId || '')}" placeholder="C0123456789" autocomplete="off">
        <div class="muted" style="margin-top:6px;">In Slack, right-click the channel → View channel details → bottom of the panel shows the channel ID.</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-outline" id="slack-test">🔌 Test Connection</button>
        <button class="btn btn-primary" id="slack-save">💾 Save &amp; Connect</button>
        <button class="btn btn-danger" id="slack-clear">✕ Clear &amp; Disconnect</button>
      </div>
      <div id="slack-test-result" style="margin-top:10px;font-size:13px;"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">📋</span> Setup checklist</div>
      <ol class="muted" style="line-height:1.9;padding-left:24px;font-size:13px;">
        <li>Create a Slack app at <code>api.slack.com/apps</code> → "From scratch" → name it "Signage" → pick your workspace.</li>
        <li>In the app's <strong>Socket Mode</strong> page → enable Socket Mode → generate an App-Level Token with the <code>connections:write</code> scope. Copy it (xapp-…).</li>
        <li>In <strong>OAuth &amp; Permissions</strong> → add ALL of these Bot Token Scopes:
          <code>channels:read</code>, <code>channels:history</code>, <code>groups:read</code>, <code>groups:history</code>, <code>users:read</code>, <code>chat:write</code>.
          The <code>groups:</code> scopes let it work with private channels too. Click "Install to Workspace". Copy the Bot User OAuth Token (xoxb-…).</li>
        <li>In <strong>Event Subscriptions</strong> → enable events → "Subscribe to bot events" → add <code>message.channels</code> (for public) and/or <code>message.groups</code> (for private).</li>
        <li><strong>Reinstall the app</strong> to your workspace whenever you change scopes — Slack will show a yellow banner at the top of the OAuth page.</li>
        <li>In Slack, invite the bot to the channel: <code>/invite @Signage</code>.</li>
        <li>Get the channel ID (right-click the channel → View details → bottom of panel).</li>
        <li>Paste the three values above and click <strong>Save &amp; Connect</strong>.</li>
      </ol>
    </div>
  `;

  $('slack-test').addEventListener('click', async () => {
    const result = $('slack-test-result');
    result.innerHTML = `<span class="muted">Testing…</span>`;
    try {
      const r = await api('/api/slack/test', {
        method: 'POST',
        body: {
          botToken: $('slack-bot').value.trim(),
          appToken: $('slack-app').value.trim(),
          channelId: $('slack-channel').value.trim(),
        },
      });
      const tag = r.channelType === 'private' ? '🔒' : '#';
      result.innerHTML = `<span style="color:var(--success);">✓ Workspace: <strong>${esc(r.workspace)}</strong> · Bot: <strong>${esc(r.botUser)}</strong> · Channel: <strong>${tag}${esc(r.channelName)}</strong></span>`;
    } catch (e) {
      result.innerHTML = `<span style="color:var(--danger);">✗ ${esc(e.message)}</span>`;
    }
  });

  $('slack-save').addEventListener('click', async () => {
    const body = {
      botToken: $('slack-bot').value.trim(),
      appToken: $('slack-app').value.trim(),
      channelId: $('slack-channel').value.trim(),
    };
    if (!body.botToken || !body.appToken || !body.channelId) {
      return toast('All three fields required', true);
    }
    try {
      await api('/api/slack', { method: 'PUT', body });
      toast('Saved & connecting…');
      setTimeout(renderSlackPage, 1200);   // refresh status display
    } catch (e) { toast(e.message, true); }
  });

  $('slack-clear').addEventListener('click', async () => {
    if (!confirm('Clear Slack settings and disconnect?')) return;
    await api('/api/slack', { method: 'PUT', body: { clear: true } });
    toast('Slack disconnected');
    renderSlackPage();
  });
}

// ── Page: global Settings (Maps API + UniFi) ─────────────────────
async function renderSettingsPage() {
  $('topbar-title').textContent = 'Settings';
  $('topbar-actions').innerHTML = '';
  $('content').innerHTML = `<div class="muted">Loading…</div>`;
  const [data, tplData] = await Promise.all([
    api('/api/settings'),
    api('/api/templates').catch(() => ({ templates: [] })),
  ]);
  drawSettingsPage(data.settings, tplData.templates || []);
}

function drawSettingsPage(s, templates) {
  $('content').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon">🗝️</span> Google Maps API Key</div>
      <p class="muted">Used by the Weather Radar and Traffic zones. Applies to all screens.</p>
      <div class="form-row"><label>API Key</label>
        <input type="password" id="set-gmaps" value="${esc(s.googleMapsApiKey || '')}" placeholder="AIzaSy…">
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="save-gmaps-global">💾 Save</button>
        <button class="btn btn-outline" id="test-gmaps">🔌 Test Connection</button>
      </div>
      <div class="test-result" id="test-gmaps-result"></div>
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">🧩</span> Display Templates</div>
      <p class="muted">Reusable display configurations. Save one from any display's settings page; new displays can be created from a template.</p>
      ${templates.length ? `
        <div class="tpl-list">
          ${templates.map(t => `
            <div class="tpl-row" data-id="${esc(t.id)}">
              <div class="tpl-name">${esc(t.name)}</div>
              <div class="tpl-meta muted">Saved ${new Date(t.createdAt).toLocaleDateString()}</div>
              <button class="btn btn-outline btn-sm" data-del-tpl="${esc(t.id)}">Delete</button>
            </div>
          `).join('')}
        </div>
      ` : '<div class="muted" style="margin-top:8px;">No templates yet. Open a display, click "Save as Template" in the top bar.</div>'}
    </div>

    <div class="card">
      <div class="card-title"><span class="icon">📷</span> UniFi Protect &amp; Access</div>
      <p class="muted">
        UniFi issues a separate API key for each application. Generate them in the UniFi
        OS dashboard → <strong>Settings → Control Plane → Integrations</strong> for Protect,
        and in the UniFi Access app → <strong>System → Advanced → Developer API</strong> for
        Access. Camera snapshots are proxied through this server, so the legacy proxy URL is
        no longer required.
      </p>
      <div class="form-row"><label>UniFi Host URL</label>
        <input type="url" id="set-unifi-host" value="${esc(s.unifiHost || '')}" placeholder="https://192.168.10.1">
      </div>
      <div class="form-row"><label>Protect API Key <span class="muted" style="font-weight:normal;text-transform:none;letter-spacing:0;">(cameras)</span></label>
        <input type="password" id="set-unifi-protect-key" value="${esc(s.unifiProtectApiKey || '')}" placeholder="UniFi Protect API key">
      </div>
      <div class="form-row"><label>Access API Key <span class="muted" style="font-weight:normal;text-transform:none;letter-spacing:0;">(door locks)</span></label>
        <input type="password" id="set-unifi-access-key" value="${esc(s.unifiAccessApiKey || '')}" placeholder="UniFi Access bearer token">
      </div>
      <div class="form-row"><label>Local Proxy URL <span class="muted" style="font-weight:normal;text-transform:none;letter-spacing:0;">(legacy, optional)</span></label>
        <input type="url" id="set-unifi-proxy" value="${esc(s.unifiProxyUrl || '')}" placeholder="http://localhost:8081">
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="save-unifi-global">💾 Save</button>
        <button class="btn btn-outline" id="test-unifi-access">🔌 Test Access (Doors)</button>
        <button class="btn btn-outline" id="test-unifi-protect">🔌 Test Protect (Cameras)</button>
      </div>
      <div class="test-result" id="test-unifi-result"></div>
    </div>
  `;

  $('save-gmaps-global').addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: { googleMapsApiKey: $('set-gmaps').value.trim() } });
    toast('Maps API key saved');
  });
  $('save-unifi-global').addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: {
      unifiHost: $('set-unifi-host').value.trim(),
      unifiProtectApiKey: $('set-unifi-protect-key').value.trim(),
      unifiAccessApiKey: $('set-unifi-access-key').value.trim(),
      unifiProxyUrl: $('set-unifi-proxy').value.trim(),
    }});
    toast('UniFi settings saved');
  });

  // Helper: render a test result inline. Shows a spinner while waiting,
  // then a green/red badge with the server-supplied detail message.
  function showTestResult(elId, state, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (state === 'loading')      el.innerHTML = `<span class="badge badge-loading">⏳ Testing…</span>`;
    else if (state === 'ok')      el.innerHTML = `<span class="badge badge-ok">✅ Connected</span> <span class="muted">${esc(msg || '')}</span>`;
    else                          el.innerHTML = `<span class="badge badge-fail">❌ Failed</span> <span class="muted">${esc(msg || '')}</span>`;
  }

  async function runTest(endpoint, body, resultId) {
    showTestResult(resultId, 'loading');
    try {
      const r = await api(endpoint, { method: 'POST', body });
      if (r.ok) showTestResult(resultId, 'ok', r.detail);
      else showTestResult(resultId, 'fail', r.error);
    } catch (e) {
      showTestResult(resultId, 'fail', e.message || 'Request failed');
    }
  }

  $('test-gmaps').addEventListener('click', () => runTest('/api/settings/test/maps', {
    googleMapsApiKey: $('set-gmaps').value.trim(),
  }, 'test-gmaps-result'));

  $('test-unifi-access').addEventListener('click', () => runTest('/api/settings/test/unifi-access', {
    unifiHost: $('set-unifi-host').value.trim(),
    unifiAccessApiKey: $('set-unifi-access-key').value.trim(),
  }, 'test-unifi-result'));

  $('test-unifi-protect').addEventListener('click', () => runTest('/api/settings/test/unifi-protect', {
    unifiHost: $('set-unifi-host').value.trim(),
    unifiProtectApiKey: $('set-unifi-protect-key').value.trim(),
  }, 'test-unifi-result'));
  document.querySelectorAll('[data-del-tpl]').forEach(b => {
    b.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Delete template?',
        body: 'This won\u2019t affect displays that were already created from it.',
        okText: 'Delete',
        okClass: 'btn-danger',
      });
      if (!ok) return;
      await api(`/api/templates/${b.dataset.delTpl}`, { method: 'DELETE' });
      toast('Template deleted');
      renderSettingsPage();
    });
  });
}

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => boot());

})();
