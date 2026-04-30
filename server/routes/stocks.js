// Stock / index / crypto quote proxy. Yahoo Finance's chart endpoint blocks
// browser CORS, so the signage page hits this server-side proxy instead. We
// cache each symbol for 30s to keep load off Yahoo while still feeling live.

const https = require('https');
const express = require('express');

const router = express.Router();

const CACHE_TTL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const cache = new Map();   // symbol -> { fetchedAt, quote }

function fetchQuote(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const req = https.request(url, {
      method: 'GET',
      headers: {
        // Yahoo blocks the default Node UA — anything browser-ish works.
        'User-Agent': 'Mozilla/5.0 (compatible; PittwaterSignage)',
        Accept: 'application/json',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const json = JSON.parse(body);
          const r = json.chart?.result?.[0];
          if (!r) {
            const err = json.chart?.error?.description || 'no data';
            return reject(new Error(err));
          }
          const meta = r.meta || {};
          const price = meta.regularMarketPrice;
          const prev  = meta.chartPreviousClose ?? meta.previousClose;
          if (price == null) return reject(new Error('no price'));
          resolve({
            symbol: meta.symbol || symbol,
            name: meta.shortName || meta.longName || symbol,
            price,
            prevClose: prev,
            change: prev != null ? price - prev : null,
            changePercent: prev ? ((price - prev) / prev) * 100 : null,
            currency: meta.currency || '',
            exchange: meta.exchangeName || '',
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('upstream timeout')); } catch (_) {} });
    req.on('error', reject);
    req.end();
  });
}

async function getQuote(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.quote;
  const quote = await fetchQuote(symbol);
  cache.set(symbol, { fetchedAt: Date.now(), quote });
  return quote;
}

// Sweep cache entries that haven't been queried in over an hour. Bounded by
// the union of configured symbols across all screens so it won't grow huge,
// but trimming stale ones keeps memory tight if symbols change over time.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [sym, entry] of cache) {
    if (entry.fetchedAt < cutoff) cache.delete(sym);
  }
}, 30 * 60 * 1000).unref();

// Public — signage page calls this. Symbol list is passed via query string.
// No slug required: quote data is public information; the 30s cache is the
// real rate-limit. Cap at 50 symbols per call to bound the upstream fanout.
router.get('/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!symbols.length) return res.json({ quotes: [] });
  const results = await Promise.allSettled(symbols.map(getQuote));
  const quotes = results.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : { symbol: symbols[i], error: r.reason?.message || 'fetch failed' });
  res.json({ quotes });
});

// ── S&P 500 sector treemap ───────────────────────────────────────
// Constituent list is fetched at boot from a public CSV (DataHub mirror of
// the Wikipedia table) and cached for 24h. A small embedded fallback covers
// the cold start where GitHub is unreachable.
const SP500_CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const SP500_LIST_TTL_MS = 24 * 60 * 60 * 1000;

// Approximate index weights in basis points (100 bp = 1%) for the top names.
// These size each tile in the treemap. Tail constituents not listed here
// fall back to TAIL_WEIGHT_BP — relative sizes are what matters.
const SP500_WEIGHTS = {
  AAPL: 700, MSFT: 650, NVDA: 650, AMZN: 400, META: 250, GOOGL: 200, GOOG: 180,
  AVGO: 200, TSLA: 180, 'BRK-B': 170, LLY: 140, JPM: 140, UNH: 110, V: 110,
  XOM: 110, ORCL: 100, MA: 95, COST: 95, WMT: 90, JNJ: 85, PG: 85, HD: 75,
  ABBV: 80, NFLX: 80, BAC: 70, CVX: 70, CRM: 70, AMD: 70, MRK: 60, KO: 60,
  WFC: 60, ADBE: 55, ACN: 55, CSCO: 55, PEP: 55, ABT: 50, MCD: 50, IBM: 55,
  TMO: 45, LIN: 45, GE: 45, AXP: 45, INTU: 45, NOW: 45, PM: 45, CAT: 40,
  DIS: 40, RTX: 40, T: 40, GS: 40, ISRG: 40, VZ: 35, QCOM: 35, BKNG: 35,
  PFE: 35, AMGN: 30, TXN: 30, SPGI: 30, BLK: 30, NEE: 30, MS: 30, UBER: 30,
  HON: 30, DHR: 25, BX: 25, SCHW: 25, PLTR: 25, LOW: 25, SYK: 25, BSX: 25,
  TMUS: 25, MDT: 22, ADP: 22, GILD: 22, COP: 22, C: 22, DE: 22, TJX: 22,
  AMAT: 22, BMY: 20, ETN: 20, VRTX: 20, MMC: 20, PGR: 20, ELV: 20, BA: 20,
  ANET: 20, REGN: 20, CB: 20, ADI: 20, LMT: 20, FI: 18, KLAC: 18, MU: 18,
  SO: 18, MDLZ: 18, INTC: 18, PANW: 18, DUK: 18, SBUX: 18, GD: 16, CI: 16,
};
const TAIL_WEIGHT_BP = 5;

// Embedded fallback used only if the CSV fetch fails on first boot. Keeps the
// big board functional without a network round-trip; once CSV is reachable
// the full 500 list takes over.
const SP500_FALLBACK = [
  ['AAPL','Apple Inc.','Information Technology'],
  ['MSFT','Microsoft','Information Technology'],
  ['NVDA','NVIDIA','Information Technology'],
  ['AMZN','Amazon.com','Consumer Discretionary'],
  ['META','Meta Platforms','Communication Services'],
  ['GOOGL','Alphabet (Class A)','Communication Services'],
  ['GOOG','Alphabet (Class C)','Communication Services'],
  ['AVGO','Broadcom','Information Technology'],
  ['TSLA','Tesla','Consumer Discretionary'],
  ['BRK-B','Berkshire Hathaway','Financials'],
  ['LLY','Eli Lilly','Health Care'],
  ['JPM','JPMorgan Chase','Financials'],
  ['UNH','UnitedHealth Group','Health Care'],
  ['V','Visa','Financials'],
  ['XOM','Exxon Mobil','Energy'],
  ['ORCL','Oracle','Information Technology'],
  ['MA','Mastercard','Financials'],
  ['COST','Costco','Consumer Staples'],
  ['WMT','Walmart','Consumer Staples'],
  ['JNJ','Johnson & Johnson','Health Care'],
  ['PG','Procter & Gamble','Consumer Staples'],
  ['HD','Home Depot','Consumer Discretionary'],
  ['ABBV','AbbVie','Health Care'],
  ['NFLX','Netflix','Communication Services'],
  ['BAC','Bank of America','Financials'],
  ['CVX','Chevron','Energy'],
  ['CRM','Salesforce','Information Technology'],
  ['AMD','Advanced Micro Devices','Information Technology'],
  ['MRK','Merck','Health Care'],
  ['KO','Coca-Cola','Consumer Staples'],
  ['WFC','Wells Fargo','Financials'],
  ['ADBE','Adobe','Information Technology'],
  ['ACN','Accenture','Information Technology'],
  ['CSCO','Cisco','Information Technology'],
  ['PEP','PepsiCo','Consumer Staples'],
  ['ABT','Abbott Laboratories','Health Care'],
  ['MCD',"McDonald's",'Consumer Discretionary'],
  ['IBM','IBM','Information Technology'],
  ['TMO','Thermo Fisher Scientific','Health Care'],
  ['LIN','Linde','Materials'],
  ['GE','General Electric','Industrials'],
  ['AXP','American Express','Financials'],
  ['INTU','Intuit','Information Technology'],
  ['NOW','ServiceNow','Information Technology'],
  ['PM','Philip Morris','Consumer Staples'],
  ['CAT','Caterpillar','Industrials'],
  ['DIS','Walt Disney','Communication Services'],
  ['RTX','RTX Corporation','Industrials'],
  ['GS','Goldman Sachs','Financials'],
  ['ISRG','Intuitive Surgical','Health Care'],
  ['VZ','Verizon','Communication Services'],
  ['QCOM','Qualcomm','Information Technology'],
  ['BKNG','Booking Holdings','Consumer Discretionary'],
  ['PFE','Pfizer','Health Care'],
  ['AMGN','Amgen','Health Care'],
  ['TXN','Texas Instruments','Information Technology'],
  ['SPGI','S&P Global','Financials'],
  ['BLK','BlackRock','Financials'],
  ['NEE','NextEra Energy','Utilities'],
  ['MS','Morgan Stanley','Financials'],
];

let sp500List = null;
let sp500ListAt = 0;
let sp500ListPromise = null;

function parseConstituentsCsv(text) {
  // Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded
  const lines = text.split(/\r?\n/);
  const out = [];
  // Skip header (first row), tolerate quoted fields with commas inside.
  const splitRow = (line) => {
    const parts = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = splitRow(line);
    const symbol = (cols[0] || '').trim().replace(/\./g, '-'); // Yahoo uses BRK-B, CSV uses BRK.B
    const name   = (cols[1] || '').trim();
    const sector = (cols[2] || '').trim();
    if (symbol && name && sector) out.push({ symbol, name, sector });
  }
  return out;
}

function fetchConstituents() {
  return new Promise((resolve, reject) => {
    const req = https.request(SP500_CSV_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PittwaterSignage)', Accept: 'text/csv' },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const rows = parseConstituentsCsv(body);
          if (rows.length < 100) return reject(new Error(`only ${rows.length} rows parsed`));
          resolve(rows);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('csv fetch timeout')); } catch (_) {} });
    req.on('error', reject);
    req.end();
  });
}

async function getSp500List() {
  if (sp500List && Date.now() - sp500ListAt < SP500_LIST_TTL_MS) return sp500List;
  if (sp500ListPromise) return sp500ListPromise;
  sp500ListPromise = fetchConstituents()
    .then(rows => {
      sp500List = rows.map(r => ({ ...r, weight: SP500_WEIGHTS[r.symbol] ?? TAIL_WEIGHT_BP }));
      sp500ListAt = Date.now();
      console.log(`[stocks] S&P 500 constituents loaded (${sp500List.length})`);
      return sp500List;
    })
    .catch(e => {
      console.warn('[stocks] S&P 500 CSV fetch failed, using fallback:', e.message);
      if (!sp500List) {
        sp500List = SP500_FALLBACK.map(([symbol, name, sector]) => ({
          symbol, name, sector, weight: SP500_WEIGHTS[symbol] ?? TAIL_WEIGHT_BP,
        }));
        sp500ListAt = Date.now();
      }
      return sp500List;
    })
    .finally(() => { sp500ListPromise = null; });
  return sp500ListPromise;
}

// Run N async tasks at most `limit` at a time. Returns settled-style results.
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Stale-while-revalidate snapshot for the whole 500-stock payload. Keeps
// /sp500 instant after the first warm-up; refresh runs in the background.
let sp500Snapshot = null;
let sp500SnapshotAt = 0;
let sp500RefreshPromise = null;
const SP500_FRESH_MS    = 60 * 1000;
const SP500_STALE_OK_MS = 10 * 60 * 1000;

async function refreshSp500Snapshot() {
  const list = await getSp500List();
  const settled = await withConcurrency(list, 20, item => getQuote(item.symbol));
  const data = list.map((item, i) => {
    const r = settled[i];
    const q = r && r.status === 'fulfilled' ? r.value : null;
    return {
      symbol: item.symbol,
      name: item.name,
      sector: item.sector,
      weight: item.weight,
      price:         q ? q.price         : null,
      change:        q ? q.change        : null,
      changePercent: q ? q.changePercent : null,
    };
  });
  sp500Snapshot = data;
  sp500SnapshotAt = Date.now();
  return data;
}

async function getSp500Snapshot() {
  const age = Date.now() - sp500SnapshotAt;
  if (sp500Snapshot && age < SP500_FRESH_MS) return sp500Snapshot;
  if (sp500Snapshot && age < SP500_STALE_OK_MS) {
    if (!sp500RefreshPromise) {
      sp500RefreshPromise = refreshSp500Snapshot()
        .catch(e => console.warn('[stocks] sp500 refresh failed:', e.message))
        .finally(() => { sp500RefreshPromise = null; });
    }
    return sp500Snapshot;
  }
  if (!sp500RefreshPromise) {
    sp500RefreshPromise = refreshSp500Snapshot()
      .finally(() => { sp500RefreshPromise = null; });
  }
  return sp500RefreshPromise;
}

router.get('/sp500', async (req, res) => {
  try {
    const stocks = await getSp500Snapshot();
    res.json({ stocks, snapshotAt: sp500SnapshotAt });
  } catch (e) {
    res.status(502).json({ error: e.message || 'snapshot failed' });
  }
});

// Pre-warm at boot so the first user request doesn't pay the cold-fetch cost.
// Errors are non-fatal — the endpoint will just block on the first real call.
setTimeout(() => {
  refreshSp500Snapshot().catch(e => console.warn('[stocks] sp500 prewarm failed:', e.message));
}, 2000).unref();

module.exports = router;
