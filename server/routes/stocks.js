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

module.exports = router;
