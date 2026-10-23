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

module.exports = {
  name: 'smsbower',
  setKey,

  async getServices() { return []; }, // catalog stays with the primary provider

  async getCountries(service) {
    const [prices, names] = await Promise.all([getPricesFor(service), getCountryNames()]);
    const out = [];
    for (const [cid, svcMap] of Object.entries(prices)) {
      const info = svcMap && svcMap[service];
      if (!info || !info.count) continue;
      out.push({
        code: cid,
        name: names[cid] || ('Country ' + cid),
        flag: FLAGS[cid] || '🌍',
        baseUsd: info.cost,
        count: info.count,
      });
    }
    out.sort((a, b) => a.baseUsd - b.baseUsd);
    return out.slice(0, 60);
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
