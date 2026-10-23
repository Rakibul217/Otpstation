// SMSBower backup provider — https://smsbower.page/stubs/handler_api.php
// Same sms-activate handler protocol family as Grizzly (getPrices /
// getCountries / getNumber / getStatus / setStatus), different stock pool.
// Used as a BACKUP: server.js routes an order here only when it is enabled
// in Admin → Settings with an API key saved, and the primary provider has
// no stock for that service+country or SMSBower is cheaper.
//
// The API key is NEVER stored in this file or in git: server.js injects it
// via setKey() from the site config (Admin → Settings), or the
// SMSBOWER_API_KEY env var is used when set (local testing).

let KEY = '';
// SMSBOWER_API_BASE override exists for local testing against a stub.
const API_BASE = process.env.SMSBOWER_API_BASE || 'https://smsbower.page/stubs/handler_api.php';

function setKey(k) { KEY = String(k || '').trim(); }
function currentKey() { return KEY || process.env.SMSBOWER_API_KEY || ''; }

async function api(action, params = {}) {
  const key = currentKey();
  if (!key) throw new Error('SMSBower is not configured — add its API key in Admin → Settings');
  const url = new URL(API_BASE);
  url.searchParams.set('api_key', key);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'otpstation/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('SMSBower API error: HTTP ' + res.status);
  return (await res.text()).trim();
}

function checkError(text) {
  const errors = {
    'BAD_KEY': 'SMSBower API key is invalid — check Admin → Settings',
    'NO_BALANCE': 'SMSBower balance is empty — top it up or disable the backup',
    'NO_NUMBERS': 'No numbers right now — try another country or retry later',
    'BAD_SERVICE': 'Invalid service code',
    'BAD_COUNTRY': 'Country not found',
    'NO_ACTIVATION': 'Order not found',
    'WRONG_MAX_PRICE': 'Price changed — please try again',
  };
  for (const [code, msg] of Object.entries(errors)) {
    if (text === code || text.startsWith(code + ':')) throw new Error(msg);
  }
  // SMSBower answers some failures as JSON: {"status":0,"message":"..."}
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      if (j && j.status === 0 && j.message) throw new Error('SMSBower: ' + j.message);
    } catch (e) { if (e.message.startsWith('SMSBower:')) throw e; }
  }
}

// Small in-memory caches so page loads never hammer their API.
let pricesCache = new Map(); // service -> { at, data }
let namesCache = { at: 0, data: null };
const PRICES_TTL = 45 * 1000, NAMES_TTL = 10 * 60 * 1000;

async function getPricesFor(service) {
  const hit = pricesCache.get(service);
  if (hit && Date.now() - hit.at < PRICES_TTL) return hit.data;
  const text = await api('getPrices', { service });
  checkError(text);
  const data = JSON.parse(text); // {countryId: {service: {count, cost}}}
  pricesCache.set(service, { at: Date.now(), data });
  return data;
}

async function getCountryNames() {
  if (namesCache.data && Date.now() - namesCache.at < NAMES_TTL) return namesCache.data;
  const text = await api('getCountries');
  checkError(text);
  const raw = JSON.parse(text);
  // Their getCountries may be an array of {id, eng, ...} or an object keyed
  // by id (Grizzly style) — normalize to { id: engName }.
  const out = {};
  if (Array.isArray(raw)) {
    for (const c of raw) if (c && c.id !== undefined) out[String(c.id)] = c.eng || c.name || ('Country ' + c.id);
  } else if (raw && typeof raw === 'object') {
    for (const [cid, c] of Object.entries(raw)) out[cid] = (c && (c.eng || c.name)) || ('Country ' + cid);
  }
  namesCache = { at: Date.now(), data: out };
  return out;
}

const FLAGS = {
  '187': '🇺🇸', '12': '🇺🇸', '16': '🇬🇧', '22': '🇮🇳', '60': '🇧🇩', '6': '🇮🇩',
  '66': '🇵🇰', '10': '🇻🇳', '4': '🇵🇭', '19': '🇳🇬', '36': '🇨🇦',
  '175': '🇦🇺', '43': '🇩🇪', '78': '🇫🇷', '1': '🇺🇦', '7': '🇲🇾',
  '81': '🇳🇵', '53': '🇸🇦', '31': '🇿🇦', '73': '🇧🇷',
};

// Canonical display names for the well-known country ids — the same names
// Version 1 (Grizzly) shows, so "USA" / "Canada" searches find them in
// Version 2 too (SMSBower's own English names differ, e.g. "United States").
const NAMES = {
  '187': 'USA', '12': 'USA (2)', '16': 'United Kingdom', '22': 'India',
  '60': 'Bangladesh', '6': 'Indonesia', '66': 'Pakistan', '10': 'Vietnam',
  '4': 'Philippines', '19': 'Nigeria', '36': 'Canada', '175': 'Australia',
  '43': 'Germany', '78': 'France', '1': 'Ukraine', '7': 'Malaysia',
  '81': 'Nepal', '53': 'Saudi Arabia', '31': 'South Africa', '73': 'Brazil',
};

// The site's popular services (same codes/logos as Version 1). In
// Version 2 these keep their brand chips; everything else SMSBower
// offers joins as letter-icon long-tail entries.
const POPULAR = [
  { code: 'fb', name: 'Facebook', logo: 'facebook' },
  { code: 'wa', name: 'WhatsApp', logo: 'whatsapp' },
  { code: 'tg', name: 'Telegram', logo: 'telegram' },
  { code: 'ig', name: 'Instagram', logo: 'instagram' },
  { code: 'go', name: 'Google', logo: 'google' },
  { code: 'lf', name: 'TikTok', logo: 'tiktok' },
  { code: 'im', name: 'imo', logo: 'imo' },
  { code: 'am', name: 'Amazon', logo: 'amazon' },
  { code: 'nf', name: 'Netflix', logo: 'netflix' },
  { code: 'ds', name: 'Discord', logo: 'discord' },
  { code: 'tw', name: 'Twitter / X', logo: 'twitter' },
  { code: 'fu', name: 'Snapchat', logo: 'snapchat' },
  { code: 'ts', name: 'PayPal', logo: 'paypal' },
  { code: 'ub', name: 'Uber', logo: 'uber' },
  { code: 'dr', name: 'ChatGPT', logo: 'openai' },
  { code: 'mm', name: 'Microsoft', logo: 'microsoft' },
  { code: 'me', name: 'Line', logo: 'line' },
  { code: 'wx', name: 'Apple', logo: 'apple' },
];
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

let allPricesCache = { at: 0, data: null };
let svcNamesCache = { at: 0, data: null };
const ALL_TTL = 60 * 1000, SVC_TTL = 10 * 60 * 1000;

// The whole price matrix in ONE call: {countryId: {service: {count, cost}}}.
async function getAllPrices() {
  if (allPricesCache.data && Date.now() - allPricesCache.at < ALL_TTL) return allPricesCache.data;
  const text = await api('getPrices');
  checkError(text);
  const data = JSON.parse(text);
  allPricesCache = { at: Date.now(), data };
  return data;
}

// SMSBower's own service names ({code: name}) — best effort only; the
// price matrix alone is enough to build the catalog if this is missing.
async function getServiceNames() {
  if (svcNamesCache.data && Date.now() - svcNamesCache.at < SVC_TTL) return svcNamesCache.data;
  const out = {};
  try {
    const text = await api('getServicesList');
    checkError(text);
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) {
      for (const s of raw) if (s && s.code) out[String(s.code)] = s.name || String(s.code);
    } else if (raw && typeof raw === 'object') {
      for (const [code, s] of Object.entries(raw)) out[code] = (s && s.name) || code;
    }
  } catch (e) { /* names are cosmetic — the matrix still gives the codes */ }
  svcNamesCache = { at: Date.now(), data: out };
  return out;
}

module.exports = {
  name: 'smsbower',
  setKey,

  // Version 2's catalog is SMSBower's OWN — every service in their price
  // matrix, independent of the primary provider's catalog (if they list
  // 500 services, all 500 show). Popular codes keep the site's brand
  // name/logo; the rest get letter icons, biggest stock first.
  async getServices() {
    let matrix = null;
    try { matrix = await getAllPrices(); } catch (e) { matrix = null; }
    const names = await getServiceNames();
    const stock = new Map(); // code -> total numbers across all countries
    if (matrix && typeof matrix === 'object') {
      for (const svcMap of Object.values(matrix)) {
        if (!svcMap || typeof svcMap !== 'object') continue;
        for (const [code, info] of Object.entries(svcMap)) {
          if (info && Number(info.count)) stock.set(code, (stock.get(code) || 0) + Number(info.count));
        }
      }
    }
    if (stock.size) {
      const pop = POPULAR.filter(p => stock.has(p.code)).map(p => ({ ...p }));
      const rest = [];
      for (const code of stock.keys()) {
        if (POPULAR.some(p => p.code === code)) continue;
        const name = names[code] || code;
        rest.push({ code, name, logo: 'letter', ext: true, icon: null, color: 'hsl(' + hashHue(name) + ', 65%, 48%)' });
      }
      rest.sort((a, b) => (stock.get(b.code) || 0) - (stock.get(a.code) || 0));
      return [...pop, ...rest];
    }
    // Price matrix unavailable — still show the popular services SMSBower
    // lists (or the full popular set if even that failed); their country
    // lists keep loading per-service as usual.
    const listed = Object.keys(names);
    return POPULAR.filter(p => !listed.length || listed.includes(p.code)).map(p => ({ ...p }));
  },

  async getCountries(service) {
    const [prices, names] = await Promise.all([getPricesFor(service), getCountryNames()]);
    const out = [];
    for (const [cid, svcMap] of Object.entries(prices)) {
      const info = svcMap && svcMap[service];
      if (!info || !info.count) continue;
      out.push({
        code: cid,
        name: NAMES[cid] || names[cid] || ('Country ' + cid),
        flag: FLAGS[cid] || '🌍',
        baseUsd: info.cost,
        count: info.count,
      });
    }
    out.sort((a, b) => a.baseUsd - b.baseUsd);
    // ALL of SMSBower's countries, untrimmed — Version 2 is SMSBower's own
    // shop; a cheapest-60 cut here used to hide the USA/Canada (pricier
    // than dozens of cheaper countries) from the list and from search.
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
    const m = /^ACCESS_NUMBER:(\d+):(\+?\d+)$/.exec(text);
    if (!m) throw new Error('Unexpected SMSBower response: ' + text.slice(0, 60));
    return { providerId: m[1], number: '+' + m[2].replace(/^\+/, '') };
  },

  async getSms(providerId) {
    const text = await api('getStatus', { id: providerId });
    if (text.startsWith('STATUS_OK:')) {
      const code = text.slice('STATUS_OK:'.length).trim();
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
