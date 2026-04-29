// Calendar proxy + minimal iCal parser.
// Browsers can't fetch most public calendar feeds directly (CORS / privacy).
// We fetch server-side, parse VEVENTs, and return a clean JSON list.
//
// Public endpoint — slug acts as the gate. Optional ?url= override is admin-only.

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Tiny in-memory cache so we don't hammer Google's iCal endpoints.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();   // url -> { fetchedAt, events }

async function fetchIcs(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.events;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const events = parseIcs(text);
  cache.set(url, { fetchedAt: Date.now(), events });
  return events;
}

// Minimal iCal parser. Handles:
//   - line unfolding (continuations starting with space/tab)
//   - VEVENT blocks
//   - SUMMARY, DESCRIPTION, LOCATION
//   - DTSTART, DTEND (date or datetime, with or without TZID)
//   - all-day events (VALUE=DATE)
//   - RRULE (FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY)
//   - EXDATE exclusions
function parseIcs(text) {
  // Unfold line continuations (RFC 5545 §3.1)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (raw === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colonIdx = raw.indexOf(':');
    if (colonIdx < 0) continue;
    const left = raw.slice(0, colonIdx);
    const value = raw.slice(colonIdx + 1);
    const [key, ...params] = left.split(';');
    const upper = key.toUpperCase();
    if (upper === 'SUMMARY')     cur.summary = unescape(value);
    else if (upper === 'DESCRIPTION') cur.description = unescape(value);
    else if (upper === 'LOCATION')    cur.location = unescape(value);
    else if (upper === 'DTSTART')     cur.start = parseDate(value, params);
    else if (upper === 'DTEND')       cur.end = parseDate(value, params);
    else if (upper === 'UID')         cur.uid = value;
    else if (upper === 'RRULE')       cur.rrule = value;
    else if (upper === 'EXDATE') {
      cur.exdates = cur.exdates || [];
      for (const v of value.split(',')) {
        const d = parseDate(v, params);
        if (d) cur.exdates.push(d.ts);
      }
    }
  }
  // Drop events with no start, sort by start asc
  return events
    .filter(e => e.start)
    .sort((a, b) => a.start.ts - b.start.ts);
}

// Parse "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T235959Z;INTERVAL=2"
const _DAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRRule(s) {
  const out = {};
  for (const part of (s || '').split(';')) {
    const [k, v] = part.split('=');
    if (!k) continue;
    if (k === 'COUNT')         out.COUNT = parseInt(v, 10);
    else if (k === 'INTERVAL') out.INTERVAL = parseInt(v, 10);
    else if (k === 'UNTIL') {
      const m = (v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
      if (m) {
        const [, Y, M, D, H, mn, ss] = m;
        out.UNTIL = Date.UTC(+Y, +M - 1, +D, +(H || 23), +(mn || 59), +(ss || 59));
      }
    }
    else if (k === 'BYDAY') out.BYDAY = (v || '').split(',');
    else out[k] = v;
  }
  return out;
}

// Expand a recurring event into individual occurrences within [winStart, winEnd].
// Returns an array. Non-recurring events are returned as-is in a single-element array.
// Caps at 500 occurrences per event as a safety bound.
function expandRecurrence(ev, winStart, winEnd) {
  if (!ev.rrule) return [ev];
  const rule = parseRRule(ev.rrule);
  if (!rule.FREQ) return [ev];

  const startMs = ev.start.ts;
  const dur = (ev.end && ev.end.ts) ? Math.max(0, ev.end.ts - startMs) : 60 * 60 * 1000;
  const exdates = new Set(ev.exdates || []);
  const interval = rule.INTERVAL || 1;
  const maxCount = rule.COUNT || 500;
  const untilMs = rule.UNTIL || Infinity;
  const out = [];
  let count = 0;
  let cursor = new Date(startMs);
  let safety = 0;

  const emit = (t) => {
    if (count >= maxCount) return false;
    if (t > untilMs) return false;
    if (exdates.has(t)) return true;       // counts toward maxCount
    if (t >= winStart && t <= winEnd && t >= startMs) {
      out.push({
        ...ev,
        start: { iso: new Date(t).toISOString(), ts: t, allDay: ev.start.allDay },
        end:   ev.end ? { iso: new Date(t + dur).toISOString(), ts: t + dur, allDay: ev.end.allDay } : null,
      });
    }
    count++;
    return true;
  };

  while (cursor.getTime() <= winEnd && cursor.getTime() <= untilMs && count < maxCount && safety++ < 2000) {
    if (rule.FREQ === 'WEEKLY' && rule.BYDAY && rule.BYDAY.length) {
      // Emit each BYDAY in the current week.
      const cd = new Date(cursor);
      const weekStart = new Date(cd);
      weekStart.setDate(cd.getDate() - cd.getDay());
      const stamps = rule.BYDAY.map(day => {
        const dn = day.replace(/^[+-]?\d+/, '');
        const dayNum = _DAY_MAP[dn];
        if (dayNum === undefined) return null;
        const occ = new Date(weekStart);
        occ.setDate(weekStart.getDate() + dayNum);
        occ.setHours(cd.getHours(), cd.getMinutes(), cd.getSeconds(), 0);
        return occ.getTime();
      }).filter(t => t != null).sort((a, b) => a - b);
      for (const t of stamps) {
        if (t < startMs) continue;
        if (!emit(t)) break;
      }
    } else {
      if (!emit(cursor.getTime())) break;
    }
    // Advance cursor by FREQ × interval.
    if      (rule.FREQ === 'DAILY')   cursor.setDate(cursor.getDate() + interval);
    else if (rule.FREQ === 'WEEKLY')  cursor.setDate(cursor.getDate() + 7 * interval);
    else if (rule.FREQ === 'MONTHLY') cursor.setMonth(cursor.getMonth() + interval);
    else if (rule.FREQ === 'YEARLY')  cursor.setFullYear(cursor.getFullYear() + interval);
    else break;
  }
  return out;
}

function unescape(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Convert wall-clock components in a named timezone to a UTC instant.
// Trick: guess the UTC instant equals the wall-clock numbers, see what that
// looks like in tzid, and adjust by the difference.
function tzWallClockToUtcMs(tzid, Y, M, D, H, mn, s) {
  const guess = Date.UTC(Y, M - 1, D, H, mn, s);
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
  } catch (_) {
    return guess;   // unknown tzid → treat as UTC
  }
  const get = (t) => {
    const v = parts.find(p => p.type === t)?.value || '0';
    return parseInt(v, 10);
  };
  let h = get('hour');
  if (h === 24) h = 0;   // some locales report 24:00:00
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second'));
  // Difference is the timezone offset to apply.
  return guess + (guess - shown);
}

function parseDate(value, params) {
  // VALUE=DATE = all-day (e.g. 20260615)
  // YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ for date-time, optionally with TZID=...
  const isDate = params.some(p => /^VALUE=DATE$/i.test(p));
  if (isDate || /^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4), mo = +value.slice(4, 6) - 1, d = +value.slice(6, 8);
    const dt = new Date(Date.UTC(y, mo, d));
    return { iso: dt.toISOString(), ts: dt.getTime(), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) {
    const t = Date.parse(value);
    return isNaN(t) ? null : { iso: new Date(t).toISOString(), ts: t, allDay: false };
  }
  const [, Y, M, D, H, mn, s, z] = m;
  let ts;
  if (z === 'Z') {
    // Explicit UTC.
    ts = Date.UTC(+Y, +M - 1, +D, +H, +mn, +s);
  } else {
    // Look for TZID=America/New_York (or similar) in the params.
    const tzParam = params.find(p => /^TZID=/i.test(p));
    if (tzParam) {
      const tzid = tzParam.slice(5).trim();
      ts = tzWallClockToUtcMs(tzid, +Y, +M, +D, +H, +mn, +s);
    } else {
      // Floating — no timezone information. Treat as UTC for sort stability;
      // signage will display via toLocaleTimeString in the screen's local TZ.
      ts = Date.UTC(+Y, +M - 1, +D, +H, +mn, +s);
    }
  }
  return { iso: new Date(ts).toISOString(), ts, allDay: false };
}

// Public: signage page calls this to get events for its calendars.
router.get('/public/:slug', async (req, res) => {
  const screen = db.prepare('SELECT config_json FROM screens WHERE slug = ?').get(req.params.slug);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  const cfg = JSON.parse(screen.config_json);
  const calendars = (cfg.calendars || []).filter(c => c.url);
  if (!calendars.length) return res.json({ events: [] });

  const results = await Promise.allSettled(calendars.map(async c => {
    const events = await fetchIcs(c.url);
    return events.map(ev => ({
      ...ev,
      calendarName: c.name || '',
      calendarColor: c.color || '#58a6ff',
    }));
  }));
  // Merge + expand recurring events + filter to today + next N days, cap at 100.
  const daysAhead = Math.max(1, Math.min(60, Number(cfg.calendarDaysAhead) || 14));
  const now = Date.now();
  const winStart = now - 12 * 60 * 60 * 1000;
  const winEnd = now + daysAhead * 24 * 60 * 60 * 1000;
  let merged = [];
  for (const r of results) if (r.status === 'fulfilled') {
    for (const ev of r.value) merged.push(...expandRecurrence(ev, winStart, winEnd));
  }
  merged = merged
    .filter(e => e.start.ts > winStart && e.start.ts < winEnd)
    .sort((a, b) => a.start.ts - b.start.ts)
    .slice(0, 100);
  res.json({ events: merged, daysAhead });
});

// Public: meeting-room status. For each configured room, returns
//   { name, status: 'free'|'soon'|'busy', currentEnd?, nextStart? }
// without leaking event titles. Status thresholds:
//   busy = an event is happening now
//   soon = an event starts within the next 30 minutes
//   free = neither
router.get('/rooms/public/:slug', async (req, res) => {
  const screen = db.prepare('SELECT config_json FROM screens WHERE slug = ?').get(req.params.slug);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  const cfg = JSON.parse(screen.config_json);
  const rooms = (cfg.meetingRooms || []).filter(r => r && r.name);
  const soonMs = (cfg.meetingRoomsSoonMins ?? 30) * 60 * 1000;
  const now = Date.now();

  const out = await Promise.all(rooms.map(async (r) => {
    const base = { name: r.name };
    if (!r.url) return { ...base, status: 'unconfigured' };
    let events;
    try { events = await fetchIcs(r.url); }
    catch (e) { return { ...base, status: 'error', error: e.message }; }
    // Find currently-happening event (start <= now < end-or-fallback).
    const current = events.find(ev => {
      const s = ev.start?.ts || 0;
      const e = ev.end?.ts || (s + 60 * 60 * 1000); // default 1h if no DTEND
      return s <= now && now < e;
    });
    if (current) return { ...base, status: 'busy', currentEnd: current.end?.iso || null };
    // Find next future event within "soon" window.
    const next = events.find(ev => (ev.start?.ts || 0) > now);
    if (next && (next.start.ts - now) <= soonMs) {
      return { ...base, status: 'soon', nextStart: next.start.iso };
    }
    return { ...base, status: 'free', nextStart: next ? next.start.iso : null };
  }));
  res.json({ rooms: out, soonMins: cfg.meetingRoomsSoonMins ?? 30 });
});

// Admin: test an iCal URL without saving it. Returns first few events.
router.post('/test', requireAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const events = await fetchIcs(url);
    res.json({ ok: true, count: events.length, sample: events.slice(0, 3) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
