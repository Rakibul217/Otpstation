// Live Grizzly SMS provider — https://api.grizzlysms.com/stubs/handler_api.php
// Auth: the API key lives in Muse's secure vault. Calls go through the
// connector helper (bin/grizzly.py), which attaches the credential via a
// surrogate — the key is NEVER in an env var, a file, or a log.
//
// Verified live: getBalance, getPrices, getCountries, service codes
// fb/wa/tg/ig/go. getNumber/getStatus/setStatus follow the official docs
// (https://grizzlysms.com/docs) and the official MCP client — the first
// real order will confirm them end to end.

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELPER = path.join(__dirname, '..', '..', 'custom-connectors', 'custom.grizzly-sms', 'bin', 'grizzly.py');
const FALLBACK_HELPER = path.join(process.env.HOME || '/home/hatch', 'workspace', 'custom-connectors', 'custom.grizzly-sms', 'bin', 'grizzly.py');

function helperPath() {
  if (fs.existsSync(HELPER)) return HELPER;
  if (fs.existsSync(FALLBACK_HELPER)) return FALLBACK_HELPER;
  return null;
}

// Auth mode:
//  1. Vault-backed connector helper (this machine) — key never touches env/files.
//  2. SMS_API_KEY env var (any other host) — set it when you deploy.
const API_KEY = process.env.SMS_API_KEY || '';
const API_BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';

function viaHelper(action, params = {}) {
  return new Promise((resolve, reject) => {
    const args = [action, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)];
    execFile('python3', [helperPath(), ...args], { timeout: 35000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('Grizzly helper failed: ' + (stderr || err.message).slice(0, 120)));
      resolve(String(stdout).trim());
    });
  });
}

async function viaHttp(params) {
  if (!API_KEY) {
    throw new Error('No Grizzly API key — set SMS_API_KEY env var on this server '
      + '(get the key from your Grizzly SMS account → Profile → API section).');
  }
  const url = new URL(API_BASE);
  url.searchParams.set('api_key', API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'otpstation/1.0' } });
  if (!res.ok) throw new Error('Grizzly API error: HTTP ' + res.status);
  return (await res.text()).trim();
}

// Call the Grizzly API: vault helper on this machine, else SMS_API_KEY env var
function api(action, params = {}) {
  if (helperPath()) return viaHelper(action, params);
  return viaHttp({ action, ...params });
}

const SERVICES = [
  { code: 'fb', name: 'Facebook',   logo: 'facebook' },
  { code: 'wa', name: 'WhatsApp',   logo: 'whatsapp' },
  { code: 'tg', name: 'Telegram',   logo: 'telegram' },
  { code: 'ig', name: 'Instagram',   logo: 'instagram' },
  { code: 'go', name: 'Google',     logo: 'google' },
  { code: 'go', name: 'YouTube',    logo: 'youtube' },
  { code: 'lf', name: 'TikTok',     logo: 'tiktok' },
  { code: 'im', name: 'imo',        logo: 'imo' },
  { code: 'am', name: 'Amazon',     logo: 'amazon' },
  { code: 'nf', name: 'Netflix',    logo: 'netflix' },
  { code: 'ds', name: 'Discord',    logo: 'discord' },
  { code: 'tw', name: 'Twitter / X', logo: 'twitter' },
  { code: 'fu', name: 'Snapchat',   logo: 'snapchat' },
  { code: 'ts', name: 'PayPal',     logo: 'paypal' },
  { code: 'ub', name: 'Uber',       logo: 'uber' },
  { code: 'dr', name: 'ChatGPT',    logo: 'openai' },
  { code: 'mm', name: 'Microsoft',  logo: 'microsoft' },
  { code: 'me', name: 'Line',       logo: 'line' },
  { code: 'wx', name: 'Apple',      logo: 'apple' },
];

// Full Grizzly catalog (long tail, built from Grizzly's own catalog API,
// filtered to services that actually have stock on the handler API).
// Each entry: { code, name, icon, cat }. `ext: true` marks long-tail entries.
const CATALOG = require('./grizzly-catalog.json');
const ICON_BASE = 'https://grizzlysms.com/api/storage/image/';

function fullServices() {
  const out = SERVICES.map(s => ({ ...s }));
  for (const c of CATALOG) {
    if (out.some(s => s.code === c.code)) continue;
    out.push({
      code: c.code,
      name: c.name,
      logo: 'letter',
      ext: true,
      icon: c.icon ? ICON_BASE + c.icon + '_fit-crop_w-64_h-64.webp' : null,
      color: 'hsl(' + (hashHue(c.name)) + ', 65%, 48%)'
    });
  }
  return out;
}
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Popular country flags (country ID -> flag)
const FLAGS = {
  '187': '🇺🇸', '12': '🇺🇸', '16': '🇬🇧', '22': '🇮🇳', '60': '🇧🇩', '6': '🇮🇩',
  '66': '🇵🇰', '10': '🇻🇳', '4': '🇵🇭', '19': '🇳🇬', '36': '🇨🇦',
  '175': '🇦🇺', '43': '🇩🇪', '78': '🇫🇷', '1': '🇺🇦', '7': '🇲🇾',
  '81': '🇳🇵', '53': '🇸🇦', '31': '🇿🇦', '73': '🇧🇷',
};
// (countries sort purely by price — cheapest available always on top)

function checkError(text) {
  const errors = {
    'BAD_KEY': 'API key is invalid — reconnect Grizzly SMS',
    'NO_KEY': 'Grizzly API hiccup — please try again',
    'NO_BALANCE': 'Number empty — please try again later',
    'NO_NUMBERS': 'No numbers right now — try another country or retry later',
    'BAD_SERVICE': 'Invalid service code',
    'BAD_COUNTRY': 'Country not found',
    'NO_ACTIVATION': 'Order not found',
    'WRONG_MAX_PRICE': 'Price changed — please try again',
  };
  for (const [code, msg] of Object.entries(errors)) {
    if (text === code || text.startsWith(code + ':')) throw new Error(msg);
  }
}

// Grizzly's API occasionally flakes (e.g. NO_KEY on one request) —
// retry read-only calls once before giving up. Never retry buyNumber/getStatus.
async function withRetry(fn, retries = 1) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { last = e; }
  }
  throw last;
}

// Stale-while-revalidate caches: a visitor never waits on the Grizzly
// API when a recent copy exists — the cached copy is served instantly
// and refreshed in the background. (Buys still re-check via maxPrice
// tolerance + the server's price-shift guard.)
let pricesCache = new Map(); // service -> { at, data, refreshing }
let namesCache = { at: 0, data: null, refreshing: null };
const PRICES_FRESH = 60 * 1000, PRICES_STALE = 10 * 60 * 1000;
const NAMES_FRESH = 10 * 60 * 1000, NAMES_STALE = 60 * 60 * 1000;

async function fetchPrices(service) {
  const text = await api('getPrices', { service });
  checkError(text);
  return JSON.parse(text); // {countryId: {service: {count, cost, retry}}}
}
async function getPricesFor(service) {
  const hit = pricesCache.get(service);
  const now = Date.now();
  if (hit && now - hit.at < PRICES_FRESH) return hit.data;
  if (hit && now - hit.at < PRICES_STALE) {
    if (!hit.refreshing) {
      hit.refreshing = withRetry(() => fetchPrices(service))
        .then(data => pricesCache.set(service, { at: Date.now(), data }))
        .catch(() => { const h = pricesCache.get(service); if (h) h.refreshing = null; });
    }
    return hit.data;
  }
  const data = await withRetry(() => fetchPrices(service));
  pricesCache.set(service, { at: now, data });
  return data;
}

async function fetchNames() {
  const text = await api('getCountries');
  checkError(text);
  return JSON.parse(text); // {countryId: {id, eng, ...}}
}
async function getCountryNames() {
  const now = Date.now();
  if (namesCache.data && now - namesCache.at < NAMES_FRESH) return namesCache.data;
  if (namesCache.data && now - namesCache.at < NAMES_STALE) {
    if (!namesCache.refreshing) {
      namesCache.refreshing = withRetry(fetchNames)
        .then(data => { namesCache = { at: Date.now(), data, refreshing: null }; })
        .catch(() => { namesCache.refreshing = null; });
    }
    return namesCache.data;
  }
  const data = await withRetry(fetchNames);
  namesCache = { at: now, data, refreshing: null };
  return data;
}

module.exports = {
  name: 'grizzly',

  async getServices() { return fullServices(); },

  async getCountries(service) {
    const [prices, names] = await Promise.all([getPricesFor(service), getCountryNames()]);
    const out = [];
    for (const [cid, svcMap] of Object.entries(prices)) {
      const info = svcMap[service];
      if (!info || !info.count) continue;
      const nm = names[cid];
      out.push({
        code: cid,
        name: nm ? nm.eng : ('Country ' + cid),
        flag: FLAGS[cid] || '🌍',
        baseUsd: info.cost,
        count: info.count,
      });
    }
    // Cheapest first — the cheapest AVAILABLE option is always on top.
    // When it sells out it drops off automatically; when restocked it jumps back.
    // ALL countries are returned (no cheapest-60 cut — it hid pricey ones
    // like the USA/Canada from the list entirely).
    out.sort((a, b) => a.baseUsd - b.baseUsd);
    return out;
  },

  async buyNumber(service, country) {
    const prices = await getPricesFor(service);
    const info = prices[country] && prices[country][service];
    if (!info) throw new Error('No numbers for this country right now');
    const maxPrice = (info.cost * 1.05).toFixed(4);
    const text = await api('getNumber', { service, country, maxPrice });
    checkError(text);
    // Success: ACCESS_NUMBER:<activationId>:<number>
    const m = /^ACCESS_NUMBER:(\d+):(\d+)$/.exec(text);
    if (!m) throw new Error('Unexpected Grizzly response: ' + text.slice(0, 60));
    return { providerId: m[1], number: '+' + m[2] };
  },

  async getSms(providerId) {
    const text = await api('getStatus', { id: providerId });
    if (text.startsWith('STATUS_OK:')) {
      const code = text.slice('STATUS_OK:'.length).trim();
      // Got the code — mark the activation as complete
      try { await api('setStatus', { id: providerId, status: '6' }); } catch (e) {}
      return code;
    }
    if (text === 'STATUS_CANCEL') throw new Error('This order was cancelled');
    checkError(text);
    return null; // STATUS_WAIT_CODE etc. — not yet
  },

  async cancel(providerId) {
    try {
      const text = await api('setStatus', { id: providerId, status: '8' });
      checkError(text);
      return true;
    } catch (e) { return false; }
  },

  async getBalance() {
    const text = await api('getBalance');
    checkError(text);
    const m = /^ACCESS_BALANCE:([\d.]+)$/.exec(text);
    return m ? parseFloat(m[1]) : text;
  },
};
