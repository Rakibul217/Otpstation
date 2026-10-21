// OTPStation — OTP selling website (Grizzly SMS style)
// Currency: USD. Payments: manual bKash / Nagad top-ups (TrxID + admin approval).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- session (stored in Postgres when DATABASE_URL is set, else in-memory) ----------------
async function getSessionUser(req) {
  const m = /sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const userId = await db.sessionGet(m[1]);
  return userId ? await db.findUserById(userId) : null;
}
async function setSession(res, uid) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.sessionCreate(token, uid);
  res.setHeader('Set-Cookie', `sess=${token}; Path=/; HttpOnly; SameSite=Lax`);
}
async function requireAuth(req, res, next) {
  try {
    const u = await getSessionUser(req);
    if (!u) return res.status(401).json({ error: 'Please log in first' });
    if ((u.status || 'active') === 'banned' && !u.isAdmin)
      return res.status(403).json({ error: 'Your account has been banned' });
    req.user = u; next();
  } catch (e) { next(e); }
}
function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Provider picker — async because it reads the (possibly Postgres-backed) config.
// NOTE: providers/index.js still exports the old sync getProvider; it is no longer
// used here because db.getConfig() is now async.
async function getProvider() {
  const name = ((await db.getConfig()).provider || 'mock').toLowerCase();
  if (name === 'grizzly') return require('./providers/grizzly');
  return require('./providers/mock');
}

// ---------------- helpers ----------------
const uid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.createHash('sha256').update(salt + pw).digest('hex');
// USD price with up to 4 decimals, trimmed
async function priceUSD(baseUsd) {
  const c = await db.getConfig();
  const p = baseUsd * (1 + c.markupPercent / 100) + (Number(c.flatFeeUsd) || 0);
  return Math.max(0.01, Math.round(p * 10000) / 10000);
}
const fmtUSD = (v) => '$' + Number(v).toFixed(v < 1 ? 4 : 2).replace(/\.?0+$/, (m) => m.startsWith('.') ? '' : m) || '$0';
function fmtMoney(v) {
  const n = Number(v);
  return '$' + (n < 1 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2));
}
const pub = (u) => ({ id: u.id, name: u.name || '', username: u.username, email: u.email || '', phone: u.phone || '', balance: u.balance, isAdmin: u.isAdmin, hasPassword: !!u.hash, createdAt: u.createdAt });

// (Seed admin is created inside db.init() — see db.js — so it works in both
// Postgres and JSON modes.)

// ---------------- auth ----------------
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const isPhone = (s) => /^\+?[0-9][0-9\s\-()]{5,18}$/.test(s);
async function uniqueUsername(base) {
  let b = String(base || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'user';
  if (b.length < 3) b = 'user' + b;
  let name = b, i = 1;
  while (await db.findUserByName(name)) name = b + (i++);
  return name;
}
app.post('/api/register', async (req, res) => {
  const { name, username, contact, password } = req.body || {};
  if (!name || String(name).trim().length < 2 || String(name).length > 50) return res.status(400).json({ error: 'Please enter your full name' });
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 chars (a-z, 0-9, _)' });
  const c = String(contact || '').trim();
  let email = '', phone = '';
  if (isEmail(c)) email = c.toLowerCase();
  else if (isPhone(c)) phone = c.replace(/[\s\-()]/g, '');
  else return res.status(400).json({ error: 'Enter a valid email address or phone number' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (await db.findUserByName(username)) return res.status(400).json({ error: 'Username already taken' });
  if (email && await db.findUserByEmail(email)) return res.status(400).json({ error: 'This email is already registered' });
  const salt = crypto.randomBytes(8).toString('hex');
  const u = await db.addUser({ id: uid(), name: String(name).trim(), username, email, phone, salt, hash: hashPw(password, salt), balance: 0, isAdmin: false, createdAt: Date.now() });
  await setSession(res, u.id);
  res.json({ user: pub(u) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const id = String(username || '').trim();
  const u = await db.findUserByName(id) || await db.findUserByEmail(id);
  if (!u || !u.hash || u.hash !== hashPw(password, u.salt)) return res.status(401).json({ error: 'Wrong username or password' });
  if ((u.status || 'active') === 'banned') return res.status(403).json({ error: 'This account has been banned' });
  await setSession(res, u.id);
  res.json({ user: pub(u) });
});

app.post('/api/logout', async (req, res) => {
  const m = /sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) await db.sessionDelete(m[1]);
  res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const u = await getSessionUser(req);
  res.json({ user: u ? pub(u) : null, siteName: (await db.getConfig()).siteName });
});

// ---------------- profile ----------------
app.put('/api/profile', requireAuth, async (req, res) => {
  const { name, contact } = req.body || {};
  const u = req.user;
  const newName = String(name || '').trim();
  if (!newName || newName.length < 2 || newName.length > 50) return res.status(400).json({ error: 'Please enter your full name' });
  const c = String(contact || '').trim();
  let email = '', phone = '';
  if (c) {
    if (isEmail(c)) email = c.toLowerCase();
    else if (isPhone(c)) phone = c.replace(/[\s\-()]/g, '');
    else return res.status(400).json({ error: 'Enter a valid email address or phone number' });
  }
  if (email && (await db.getUsers()).some(x => x.id !== u.id && x.email && x.email.toLowerCase() === email))
    return res.status(400).json({ error: 'This email is already registered' });
  await db.updateUser(u.id, { name: newName, email, phone });
  res.json({ user: pub(await db.findUserById(u.id)) });
});

app.post('/api/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = req.user;
  if (u.hash && (!currentPassword || u.hash !== hashPw(currentPassword, u.salt)))
    return res.status(400).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const salt = crypto.randomBytes(8).toString('hex');
  await db.updateUser(u.id, { salt, hash: hashPw(newPassword, salt) });
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const u = req.user;
  const items = [];
  for (const t of await db.userTopups(u.id)) {
    const amt = Number(t.amount) || 0;
    if (t.status === 'approved') items.push({ label: `Top-up approved (${t.method || ''})`, amount: amt, at: t.createdAt, kind: 'credit' });
    else if (t.status === 'rejected') items.push({ label: 'Top-up rejected', amount: amt, at: t.createdAt, kind: 'none' });
    else items.push({ label: t.status === 'pending' ? 'Top-up pending review' : 'Top-up awaiting payment', amount: amt, at: t.createdAt, kind: 'none' });
  }
  for (const b of await db.userBonuses(u.id)) {
    const bAmt = Number(b.amount) || 0;
    items.push({ label: b.label || 'Bonus', amount: bAmt, at: b.createdAt, kind: bAmt >= 0 ? 'credit' : 'debit' });
  }
  for (const o of await db.userOrders(u.id)) {
    const amt = Number(o.priceUsd) || 0;
    const what = `${o.serviceName || o.service}${o.number ? ' — ' + o.number : ''}`;
    if (o.status === 'cancelled') items.push({ label: 'Refund — ' + what, amount: amt, at: o.createdAt, kind: 'credit' });
    else items.push({ label: what, amount: -amt, at: o.createdAt, kind: 'debit' });
  }
  items.sort((a, b) => b.at - a.at);
  res.json({ history: items, balance: u.balance });
});

// ---------------- Continue with Google (OAuth 2.0) ----------------
// Admin sets Client ID + Secret in Settings (Google Cloud Console → Credentials →
// OAuth client ID → Authorized redirect URI must include <site>/api/auth/google/callback).
const oauthStates = new Map(); // state -> expiry timestamp (CSRF protection)
async function googleRedirectUri(req) {
  const cfg = await db.getConfig();
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '') + '/api/auth/google/callback';
  let proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host') || '';
  if (host.endsWith('.loca.lt')) proto = 'https'; // tunnels terminate TLS at the edge
  return `${proto}://${host}/api/auth/google/callback`;
}
app.get('/api/auth/providers', async (req, res) => {
  res.json({ google: !!(await db.getConfig()).googleClientId });
});
app.get('/api/auth/google', async (req, res) => {
  const cfg = await db.getConfig();
  if (!cfg.googleClientId) return res.status(400).send('Google login is not configured. Ask the site admin to set it up in Admin → Settings.');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: await googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const exp = oauthStates.get(state);
    oauthStates.delete(state);
    if (!code || !exp || exp < Date.now()) return res.status(400).send('Invalid or expired login session. Please try again.');
    const cfg = await db.getConfig();
    if (!cfg.googleClientId || !cfg.googleClientSecret) return res.status(400).send('Google login is not configured.');
    // exchange code for tokens
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
        redirect_uri: await googleRedirectUri(req), grant_type: 'authorization_code'
      })
    });
    const tj = await tr.json();
    if (!tj.access_token) return res.status(400).send('Google sign-in failed. Please try again.');
    // fetch profile
    const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tj.access_token }
    });
    const profile = await ur.json();
    if (!profile.sub || !profile.email) return res.status(400).send('Could not read your Google profile.');
    const email = String(profile.email).toLowerCase();
    let u = await db.findUserByGoogleId(profile.sub) || await db.findUserByEmail(email);
    if (u) {
      if (!u.googleId) await db.updateUser(u.id, { googleId: profile.sub });
    } else {
      const salt = crypto.randomBytes(8).toString('hex');
      u = await db.addUser({
        id: uid(), name: String(profile.name || email.split('@')[0]).slice(0, 50),
        username: await uniqueUsername(email.split('@')[0]), email, phone: '',
        salt, hash: '', googleId: profile.sub, balance: 0, isAdmin: false, createdAt: Date.now()
      });
    }
    await setSession(res, u.id);
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Google sign-in error: ' + e.message);
  }
});

// ---------------- shop ----------------
// brand colors for the white monochrome logos (white-on-white is invisible on the light theme)
const BRAND_COLORS = {
  facebook: '#1877F2',
  whatsapp: '#25D366',
  telegram: '#229ED9',
  instagram: 'linear-gradient(45deg,#f09433,#dc2743,#bc1888)',
  google: '#4285F4',
  youtube: '#FF0000',
  tiktok: '#010101',
  imo: '#00B0FF',
  amazon: '#FF9900',
  netflix: '#E50914',
  discord: '#5865F2',
  twitter: '#000000',
  snapchat: '#FFFC00',
  paypal: '#003087',
  uber: '#000000',
  openai: '#000000',
  microsoft: '#00A4EF',
  line: '#06C755',
  binance: '#F0B90B',
  apple: '#111111',
  tinder: '#FE3C72'
};
app.get('/api/services', async (req, res) => {
  try {
    const p = await getProvider();
    const services = await p.getServices();
    // Fetch every service's cheapest price in PARALLEL — sequential fetching
    // gets slower with every service added.
    const out = await Promise.all(services.map(async (s) => {
      let min = null;
      if (!s.ext) {
        // Curated popular services get a live "from $X" price. Long-tail
        // services skip the price call (a per-service call for 2000+
        // services would hang the page) — price shows when tapped.
        try {
          const countries = await p.getCountries(s.code);
          const prices = await Promise.all(countries.map(c => priceUSD(c.baseUsd)));
          if (prices.length) min = Math.min(...prices);
        } catch (e) {}
      }
      return { ...s, fromPrice: min, color: s.color || BRAND_COLORS[s.logo] || '#4f7cff' };
    }));
    res.json({ services: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/countries', async (req, res) => {
  try {
    const p = await getProvider();
    const list = await p.getCountries(req.query.service);
    res.json({ countries: await Promise.all(list.map(async c => ({ ...c, priceUsd: await priceUSD(c.baseUsd) }))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  try {
    if ((req.user.status || 'active') !== 'active')
      return res.status(403).json({ error: 'Your account is on hold — please contact support' });
    const { service, country, expectedPrice } = req.body || {};
    const p = await getProvider();
    const countries = await p.getCountries(service);
    const c = countries.find(x => x.code === country);
    if (!c) return res.status(400).json({ error: 'Just sold out — please choose another country', soldOut: true });
    const services = await p.getServices();
    const s = services.find(x => x.code === service) || { name: service };
    const price = await priceUSD(c.baseUsd);
    // Price-shift guard: Grizzly's live price moved since the user saw the list —
    // stop the stale buy so the customer never pays a price they didn't confirm.
    if (expectedPrice !== undefined && Math.abs(Number(expectedPrice) - price) > 0.005) {
      return res.status(409).json({ error: 'Price just changed — please try again', priceChanged: true, priceUsd: price });
    }
    const me = await db.findUserById(req.user.id);
    if (me.balance < price) return res.status(400).json({ error: `Insufficient balance — need ${fmtMoney(price)}, have ${fmtMoney(me.balance)}` });
    const bought = await p.buyNumber(service, country);
    await db.addBalance(me.id, -price);
    const order = await db.addOrder({
      id: uid(), userId: me.id, service, serviceName: s.name,
      country, countryName: c.name, number: bought.number,
      priceUsd: price, providerId: bought.providerId,
      status: 'waiting', code: null, createdAt: Date.now()
    });
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  res.json({ orders: await db.userOrders(req.user.id) });
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const o = await db.getOrder(req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'waiting') {
    try {
      const code = await (await getProvider()).getSms(o.providerId);
      if (code) await db.updateOrder(o.id, { status: 'done', code });
    } catch (e) { /* stays waiting on provider error */ }
  }
  res.json({ order: await db.getOrder(o.id) });
});

// Grizzly policy: a number can only be cancelled 5 minutes after purchase.
const CANCEL_MIN_MS = 5 * 60 * 1000;
app.post('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  const o = await db.getOrder(req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'waiting') return res.status(400).json({ error: 'This order cannot be cancelled' });
  if (Date.now() - o.createdAt < CANCEL_MIN_MS)
    return res.status(400).json({ error: 'You can cancel this number 5 minutes after purchase (Grizzly policy)' });
  try { await (await getProvider()).cancel(o.providerId); } catch (e) {}
  await db.updateOrder(o.id, { status: 'cancelled' });
  await db.addBalance(o.userId, o.priceUsd);
  res.json({ ok: true, refund: o.priceUsd });
});

// ---------------- top-up: manual bKash / Nagad ----------------
// User sends BDT to the admin's number, then submits the TrxID.
// Admin verifies in the bKash/Nagad app and approves -> USD credited.
const MIN_USD = 5, MAX_BDT = 50000;
const METHOD_NAMES = { bkash: 'bKash', nagad: 'Nagad' };

app.get('/api/payinfo', async (req, res) => {
  const c = await db.getConfig();
  const rate = c.bdtRate || 125;
  const methods = [];
  if (c.bkashNumber) methods.push({ id: 'bkash', name: 'bKash', number: c.bkashNumber });
  if (c.nagadNumber) methods.push({ id: 'nagad', name: 'Nagad', number: c.nagadNumber });
  res.json({ methods, bdtRate: rate, minBdt: Math.ceil(MIN_USD * rate), maxBdt: MAX_BDT, minUsd: MIN_USD,
    welcomeBonus: { enabled: c.welcomeBonusEnabled !== false, amount: Number(c.welcomeBonusUsd) || 0 } });
});

// Submit a top-up: { method: 'bkash'|'nagad', amountBdt, senderNumber, trxid }
app.post('/api/topups', requireAuth, async (req, res) => {
  const { method, amountBdt, senderNumber, trxid } = req.body || {};
  const cfg = await db.getConfig();
  const num = method === 'bkash' ? cfg.bkashNumber : method === 'nagad' ? cfg.nagadNumber : '';
  if (!METHOD_NAMES[method] || !num)
    return res.status(400).json({ error: 'This payment method is not available right now.' });
  const bdt = Math.round(Number(amountBdt));
  const rate = cfg.bdtRate || 125;
  const minBdt = Math.ceil(MIN_USD * rate);
  if (!bdt || bdt < minBdt) return res.status(400).json({ error: `Minimum top-up is ৳${minBdt} ($${MIN_USD})` });
  if (bdt > MAX_BDT) return res.status(400).json({ error: `Maximum top-up is ৳${MAX_BDT}` });
  const tx = String(trxid || '').trim().toUpperCase();
  if (tx.length < 6 || tx.length > 30 || !/^[A-Z0-9]+$/.test(tx))
    return res.status(400).json({ error: 'Invalid TrxID — check it in your bKash/Nagad app and try again.' });
  const sender = String(senderNumber || '').trim().replace(/[\s-]/g, '');
  if (!/^01[3-9]\d{8}$/.test(sender))
    return res.status(400).json({ error: 'Enter the bKash/Nagad number you sent money from (01XXXXXXXXX).' });
  // TrxID must be unique (not used in any non-rejected top-up)
  if (await db.getTopupByTrxid(tx)) return res.status(400).json({ error: 'This TrxID was already submitted.' });
  const usd = Math.round((bdt / rate) * 100) / 100;
  const t = await db.addTopup({
    id: uid(), userId: req.user.id, username: req.user.username,
    amount: usd, amountBdt: bdt, bdtRate: rate,
    method: METHOD_NAMES[method], senderNumber: sender, trxid: tx,
    status: 'pending', createdAt: Date.now()
  });
  res.json({ topup: t });
});

app.get('/api/topups/mine', requireAuth, async (req, res) => {
  res.json({ topups: await db.userTopups(req.user.id) });
});

// ---------------- accounts shop (AccsZone-style digital accounts) ----------------
// Admin uploads credential stock (one account per line); customers buy N pieces
// and get N credentials instantly, deducted from their USD balance.
function cleanPriceUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 10000) / 10000;
}
function cleanProductPatch(b) {
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (name.length < 2 || name.length > 80) throw new Error('Product name: 2-80 characters');
    patch.name = name;
  }
  if (b.description !== undefined) patch.description = String(b.description).trim().slice(0, 2000);
  if (b.price_usd !== undefined || b.priceUsd !== undefined) {
    const p = cleanPriceUsd(b.price_usd !== undefined ? b.price_usd : b.priceUsd);
    if (p === null) throw new Error('Price must be a number between 0 and 100000 USD');
    patch.priceUsd = p;
  }
  if (b.logo !== undefined) patch.logo = String(b.logo).trim().slice(0, 60);
  if (b.active !== undefined) patch.active = !!b.active;
  return patch;
}

// Admin: product CRUD + stock upload (counts only — credentials never listed)
app.post('/api/admin/account-products', requireAuth, requireAdmin, async (req, res) => {
  try {
    const patch = cleanProductPatch(req.body || {});
    if (!patch.name) return res.status(400).json({ error: 'Product name is required' });
    if (patch.priceUsd === undefined) return res.status(400).json({ error: 'Price (price_usd) is required' });
    const product = await db.createAccountProduct({
      name: patch.name, description: patch.description || '',
      priceUsd: patch.priceUsd, logo: patch.logo || ''
    });
    res.json({ product });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/account-products', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ products: await db.listAccountProductsAdmin() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/account-products/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const patch = cleanProductPatch(req.body || {});
    const product = await db.updateAccountProduct(req.params.id, patch);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/admin/account-products/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const product = await db.getAccountProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await db.deleteAccountProduct(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/account-products/:id/stock', requireAuth, requireAdmin, async (req, res) => {
  try {
    const product = await db.getAccountProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const lines = String((req.body || {}).lines || '').split('\n')
      .map(l => l.trim()).filter(l => l.length > 0).slice(0, 5000);
    if (!lines.length) return res.status(400).json({ error: 'Paste at least one account line' });
    const added = await db.addAccountStock(product.id, lines);
    res.json({ added, productId: product.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: active products with stock counts (NO credentials)
app.get('/api/account-products', async (req, res) => {
  try { res.json({ products: await db.listAccountProductsPublic() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// User: buy N pieces -> credentials instantly delivered, balance deducted
app.post('/api/account-products/:id/buy', requireAuth, async (req, res) => {
  try {
    if ((req.user.status || 'active') !== 'active')
      return res.status(403).json({ error: 'Your account is on hold — please contact support' });
    const qty = Math.floor(Number((req.body || {}).qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 100)
      return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    const { order, items } = await db.buyAccountStock(req.params.id, req.user.id, qty);
    res.json({ order, items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// User: own past account orders (with their credentials)
app.get('/api/my-accounts', requireAuth, async (req, res) => {
  try { res.json({ orders: await db.myAccountOrders(req.user.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- live chat ----------------
// Floating widget on the site. Guests chat with a random token; logged-in
// users are matched by session. A keyword bot answers FAQs instantly; anything
// else waits for the support agent (polled via /api/internal/chat/*).
async function chatAccess(req, thread) {
  if (!thread) return false;
  if (thread.userId) {
    const u = await getSessionUser(req);
    return !!(u && u.id === thread.userId);
  }
  const token = (req.body && req.body.token) || req.query.token || '';
  return !!(thread.guestToken && token && token === thread.guestToken);
}
function scoreChatFaq(faq, text) {
  const t = String(text).toLowerCase();
  let hits = 0;
  for (const kw of String(faq.keywords || '').split(',')) {
    const k = kw.trim().toLowerCase();
    if (k && t.includes(k)) hits++;
  }
  return hits;
}

// ---------- smart chat bot: understands intents with live data ----------
// Runs BEFORE the FAQ keyword match. Answers prices (live), payment-done
// reassurance (checks the user's real pending top-up), welcome bonus,
// greetings, how-to-buy — in Bengali when the customer writes Bengali.
const CHAT_SERVICES = [
  { code: 'fb', name: 'Facebook', keys: ['facebook', 'ফেসবুক', 'এফবি'] },
  { code: 'wa', name: 'WhatsApp', keys: ['whatsapp', 'হোয়াটসঅ্যাপ', 'হোয়াটসএপ', 'whats app'] },
  { code: 'tg', name: 'Telegram', keys: ['telegram', 'টেলিগ্রাম'] },
  { code: 'ig', name: 'Instagram', keys: ['instagram', 'ইনস্টাগ্রাম'] },
  { code: 'go', name: 'Google', keys: ['google', 'গুগল', 'youtube', 'ইউটিউব'] },
  { code: 'lf', name: 'TikTok', keys: ['tiktok', 'টিকটক', 'tik tok'] },
  { code: 'im', name: 'imo', keys: ['imo', 'ইমো'] },
  { code: 'am', name: 'Amazon', keys: ['amazon', 'অ্যামাজন'] },
  { code: 'nf', name: 'Netflix', keys: ['netflix', 'নেটফ্লিক্স'] },
  { code: 'ds', name: 'Discord', keys: ['discord', 'ডিসকর্ড'] },
  { code: 'tw', name: 'Twitter / X', keys: ['twitter', 'টুইটার', ' x '] },
  { code: 'fu', name: 'Snapchat', keys: ['snapchat', 'স্ন্যাপচ্যাট'] },
  { code: 'ts', name: 'PayPal', keys: ['paypal', 'পেপাল'] },
  { code: 'ub', name: 'Uber', keys: ['uber', 'উবার'] },
  { code: 'dr', name: 'ChatGPT', keys: ['chatgpt', 'openai', 'চ্যাটজিপিটি', 'gpt'] },
  { code: 'mm', name: 'Microsoft', keys: ['microsoft', 'মাইক্রোসফট'] },
  { code: 'me', name: 'Line', keys: [' line ', 'লাইন'] },
  { code: 'wx', name: 'Apple', keys: ['apple', 'অ্যাপল'] }
];
const CHAT_PRICE_WORDS = ['দাম', 'প্রাইস', 'price', 'কত টাকা', 'রেট', 'rate', 'খরচ', 'cost', 'charge', 'কত করে', 'পড়বে', 'কতো'];
const CHAT_PAID_WORDS = ['পেমেন্ট করেছি', 'পেমেন্ট দিয়েছি', 'পেমেন্ট দিলাম', 'পেমেন্ট করলাম', 'টাকা পাঠিয়েছি', 'টাকা দিয়েছি', 'টাকা পাঠালাম', 'টাকা সেন্ড করেছি', 'paid', 'payment done', 'payment sent', 'i have paid', 'already paid', 'sent the money', 'পেমেন্ট ডান'];
const CHAT_PAY_HOW_WORDS = ['কিভাবে', 'কীভাবে', 'কেমনে', 'কি ভাবে', 'how to pay', 'how do i pay', 'পেমেন্ট করব', 'পেমেন্ট করতে'];
const CHAT_BONUS_WORDS = ['বোনাস', 'bonus', 'ফ্রি', 'free', 'এক ডলার', '১ ডলার', '$1', 'one dollar', 'অফারটা'];
function chatServiceOf(t) {
  for (const s of CHAT_SERVICES) if (s.keys.some(k => t.includes(k))) return s;
  return null;
}
async function smartChatReply(msg, thread) {
  const t = ' ' + String(msg).toLowerCase() + ' ';
  const bn = /[\u0980-\u09FF]/.test(msg);
  try {
    // Greeting
    if (/^(hi+|hello+|hey+|হ্যালো|হাই|আসসালামু|সালাম|নমস্কার|আদাব)\b/.test(msg.trim().toLowerCase()) && msg.trim().length <= 30) {
      return bn
        ? 'হ্যালো! 👋 OTPStation সাপোর্টে স্বাগতম। আমি দাম, পেমেন্ট স্ট্যাটাস, ওয়েলকাম বোনাস — সবকিছু জানাতে পারি। কী সাহায্য করতে পারি?'
        : 'Hello! 👋 Welcome to OTPStation support. I can help with prices, payment status, and the welcome bonus. How can I help you?';
    }
    // Payment done — reassure, with their real pending top-up when possible
    if (CHAT_PAID_WORDS.some(k => t.includes(k)) && !CHAT_PAY_HOW_WORDS.some(k => t.includes(k))) {
      let pending = null;
      if (thread.userId) {
        const tops = await db.userTopups(thread.userId);
        pending = (tops || []).find(x => x.status === 'pending');
      }
      if (pending) {
        const method = pending.method === 'nagad' ? 'Nagad' : 'bKash';
        return bn
          ? `হ্যাঁ, দেখতে পাচ্ছি! ✅ আপনার ৳${pending.amountBdt} (${method}) পেমেন্টটা যাচাইয়ের অপেক্ষায় আছে — একটু সময় দিন, approve হলেই ${fmtMoney(pending.amount)} ব্যালেন্সে যোগ হয়ে যাবে।`
          : `Yes, I can see it! ✅ Your ৳${pending.amountBdt} (${method}) payment is waiting for verification — please give us a little time; once approved, ${fmtMoney(pending.amount)} will be added to your balance.`;
      }
      return bn
        ? 'ধন্যবাদ! ✅ আপনার পেমেন্ট আমরা দেখতে পাচ্ছি — একটু সময় দিন, যাচাই করে ব্যালেন্সে যোগ করে দিচ্ছি। Add Funds পেজে My Top-ups-এ স্ট্যাটাস দেখতে পারবেন।'
        : 'Thank you! ✅ We have received your payment — please give us a little time while we verify it and credit your balance. You can watch the status under Add Funds → My Top-ups.';
    }
    // Welcome bonus
    if (CHAT_BONUS_WORDS.some(k => t.includes(k))) {
      const cfg = await db.getConfig();
      const amt = Number(cfg.welcomeBonusUsd) || 0;
      if (cfg.welcomeBonusEnabled !== false && amt > 0) {
        return bn
          ? `হ্যাঁ, অফারটা এখনো আছে! 🎁 প্রথম ডিপোজিট approve হলেই ফ্রি ${fmtMoney(amt)} ওয়েলকাম বোনাস অটো আপনার ব্যালেন্সে যোগ হয়ে যাবে (শুধু প্রথম টপ-আপে, একবারই)।`
          : `Yes, the offer is live! 🎁 On your first approved deposit you get a free ${fmtMoney(amt)} welcome bonus added automatically to your balance (first top-up only, one time).`;
      }
      return bn ? 'দুঃখিত, এই মুহূর্তে ওয়েলকাম বোনাস অফারটা চালু নেই।'
                : 'Sorry, the welcome bonus offer is not active at the moment.';
    }
    // Prices — live from the provider
    const svc = chatServiceOf(t);
    if (CHAT_PRICE_WORDS.some(k => t.includes(k)) || (svc && (t.includes('কত') || t.includes('price') || t.includes('দাম')))) {
      const use = svc || CHAT_SERVICES[0];
      try {
        const p = await getProvider();
        const list = await p.getCountries(use.code);
        const priced = await Promise.all(list.map(async c => ({ name: c.name, priceUsd: await priceUSD(c.baseUsd) })));
        priced.sort((a, b) => a.priceUsd - b.priceUsd);
        if (priced.length) {
          const cheap = priced[0];
          const usa = priced.find(c => /united states|usa/i.test(c.name));
          const usaTxt = usa ? `, USA ${fmtMoney(usa.priceUsd)}` : '';
          return bn
            ? `${use.name} OTP নাম্বারের দাম দেশ অনুযায়ী আলাদা — সবচেয়ে সস্তা ${cheap.name} ${fmtMoney(cheap.priceUsd)} থেকে শুরু${usaTxt}। Services পেজে গিয়ে ${use.name} সিলেক্ট করলেই সব দেশের লাইভ দাম দেখতে পারবেন। অন্য সার্ভিসের দাম জানতে চাইলে নামটা বলুন!`
            : `${use.name} OTP numbers are priced per country — starting from ${fmtMoney(cheap.priceUsd)} (${cheap.name})${usaTxt}. Tap ${use.name} on the Services page to see live prices for all countries. Ask me about any other service too!`;
        }
      } catch (e) {}
      return bn
        ? 'দাম সার্ভিস আর দেশ অনুযায়ী আলাদা — Services পেজে সার্ভিস সিলেক্ট করলেই প্রতিটা দেশের লাইভ দাম দেখতে পারবেন। কোন সার্ভিসের দাম জানতে চান?'
        : 'Prices depend on the service and country — select a service on the Services page to see live prices per country. Which service are you interested in?';
    }
    // How to buy a number
    if ((t.includes('কিভাবে') || t.includes('কীভাবে') || t.includes('how')) &&
        (t.includes('কিন') || t.includes('buy') || t.includes('number') || t.includes('নাম্বার'))) {
      return bn
        ? 'খুব সহজ! 👉 ১) Add Funds থেকে ব্যালেন্সে টাকা যোগ করুন ২) Services থেকে সার্ভিস + দেশ সিলেক্ট করুন ৩) দামের বাটনে ট্যাপ করলেই নাম্বার কেনা হয়ে যাবে — SMS কোড My Numbers-এ অটো চলে আসবে।'
        : 'Easy! 👉 1) Add funds to your balance 2) Pick a service + country under Services 3) Tap the price to buy — the SMS code arrives automatically under My Numbers.';
    }
  } catch (e) {}
  return null;
}

// Start (or resume) a chat. Guests get a guest_token they must send back.
app.post('/api/chat/start', async (req, res) => {
  try {
    const u = await getSessionUser(req);
    if (u) {
      let thread = await db.findOpenChatThreadByUser(u.id);
      if (!thread) thread = await db.createChatThread({ userId: u.id, guestName: '', guestToken: null });
      return res.json({ thread: { id: thread.id, status: thread.status } });
    }
    const name = String((req.body || {}).name || '').trim().slice(0, 50) || 'Guest';
    const thread = await db.createChatThread({
      userId: null, guestName: name, guestToken: crypto.randomBytes(16).toString('hex')
    });
    res.json({ thread: { id: thread.id, guest_token: thread.guestToken, status: thread.status } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a user message; the FAQ bot may answer instantly.
app.post('/api/chat/message', async (req, res) => {
  try {
    const { threadId, text } = req.body || {};
    const thread = await db.getChatThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    if (!(await chatAccess(req, thread))) return res.status(403).json({ error: 'Not your chat' });
    if (thread.status !== 'open') return res.status(400).json({ error: 'This chat is closed' });
    const msg = String(text || '').trim().slice(0, 2000);
    if (!msg) return res.status(400).json({ error: 'Message is empty' });
    await db.addChatMessage(thread.id, 'user', msg);
    // Smart bot: intent detection with live data (prices, bonus, payment status)
    const smart = await smartChatReply(msg, thread);
    if (smart) {
      await db.addChatMessage(thread.id, 'bot', smart);
      return res.json({ botReply: smart });
    }
    // FAQ bot: highest keyword-hit count wins (>=1 hit); tie -> earliest FAQ
    let best = null, bestScore = 0;
    for (const faq of await db.listChatFaqs()) {
      if (!faq.active) continue;
      const s = scoreChatFaq(faq, msg);
      if (s > bestScore) { bestScore = s; best = faq; }
    }
    if (best) {
      await db.addChatMessage(thread.id, 'bot', best.answer);
      return res.json({ botReply: best.answer });
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat/messages', async (req, res) => {
  try {
    const thread = await db.getChatThread(req.query.threadId);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    if (!(await chatAccess(req, thread))) return res.status(403).json({ error: 'Not your chat' });
    const messages = await db.listChatMessages(thread.id);
    res.json({ messages: messages.map(m => ({ id: m.id, sender: m.sender, text: m.text, createdAt: m.createdAt })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Server-Sent Events: push new chat messages the moment they arrive,
// so replies feel instant (no polling delay). Reconnects every ~50s.
// NOTE: chat message ids are random hex strings — never compare them as numbers.
function chatStream(req, res, thread, since) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  let lastSeen = String(since || '');
  let alive = true;
  req.on('close', () => { alive = false; });
  const timer = setInterval(async () => {
    if (!alive) { clearInterval(timer); return; }
    try {
      const msgs = await db.listChatMessages(thread.id);
      if (!msgs.length) return;
      let fresh;
      if (!lastSeen) {
        fresh = msgs; // fresh thread: the client hasn't rendered anything yet
      } else {
        const i = msgs.findIndex(m => String(m.id) === lastSeen);
        if (i === -1) { lastSeen = String(msgs[msgs.length - 1].id); return; } // resync quietly
        fresh = msgs.slice(i + 1);
      }
      if (fresh.length) {
        lastSeen = String(msgs[msgs.length - 1].id);
        res.write('data: ' + JSON.stringify({
          messages: fresh.map(m => ({ id: m.id, sender: m.sender, text: m.text, createdAt: m.createdAt }))
        }) + '\n\n');
      }
    } catch (e) {}
  }, 800);
  setTimeout(() => { clearInterval(timer); try { res.end(); } catch (e) {} }, 50000);
}

app.get('/api/chat/stream', async (req, res) => {
  try {
    const thread = await db.getChatThread(req.query.threadId);
    if (!thread || !(await chatAccess(req, thread))) return res.status(403).json({ error: 'Not your chat' });
    chatStream(req, res, thread, req.query.since);
  } catch (e) { try { res.status(500).end(); } catch (_) {} }
});

// ---------------- internal agent endpoints ----------------
// Used by the support-agent poller (not the browser). Auth: X-Agent-Token must
// equal CHAT_AGENT_TOKEN. If the env var is unset, these endpoints are disabled.
function requireAgent(req, res, next) {
  const expected = process.env.CHAT_AGENT_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Agent endpoint disabled' });
  const got = req.get('X-Agent-Token') || '';
  if (got.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)))
    return res.status(401).json({ error: 'Bad agent token' });
  next();
}
// Open threads whose latest message is from the user (nobody answered yet).
app.get('/api/internal/chat/pending', requireAgent, async (req, res) => {
  try { res.json({ pending: await db.pendingChatThreads() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/internal/chat/reply', requireAgent, async (req, res) => {
  try {
    const { threadId, text } = req.body || {};
    const thread = await db.getChatThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    const msg = String(text || '').trim().slice(0, 2000);
    if (!msg) return res.status(400).json({ error: 'Message is empty' });
    const message = await db.addChatMessage(thread.id, 'agent', msg);
    res.json({ ok: true, message: { id: message.id, sender: message.sender, text: message.text, createdAt: message.createdAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- admin ----------------
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  const s = await db.stats();
  s.revenue = Math.round(s.revenue * 100) / 100;
  res.json(s);
});
app.get('/api/admin/topups', requireAuth, requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const list = status === 'awaiting' ? await db.topupsByStatus('awaiting') : await db.topupsByStatus(status);
  res.json({ topups: list });
});
// ---------------- live presence (in-memory; resets on redeploy) ----------------
const presence = new Map(); // vizId -> { lastSeen, username|null }
app.post('/api/heartbeat', async (req, res) => {
  try {
    const viz = String((req.body && req.body.viz) || '').slice(0, 64);
    if (!viz) return res.status(400).json({ error: 'viz required' });
    const u = await getSessionUser(req).catch(() => null);
    presence.set(viz, { lastSeen: Date.now(), username: u ? u.username : null });
    if (presence.size > 500) { const cut = Date.now() - 3 * 60 * 1000; for (const [k, v] of presence) if (v.lastSeen < cut) presence.delete(k); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'heartbeat failed' }); }
});
app.get('/api/admin/online', requireAuth, requireAdmin, (req, res) => {
  const now = Date.now(), cut = now - 2 * 60 * 1000;
  let total = 0, guests = 0; const users = [];
  for (const [k, v] of presence) {
    if (v.lastSeen < cut) { presence.delete(k); continue; }
    total++;
    if (v.username) users.push({ username: v.username, secondsAgo: Math.round((now - v.lastSeen) / 1000) });
    else guests++;
  }
  users.sort((a, b) => a.secondsAgo - b.secondsAgo);
  res.json({ online: total, loggedIn: users.length, guests, users });
});

// Full user list with profile + activity details (password hashes never sent)
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = [];
  for (const u of await db.getUsers()) {
    const orders = await db.userOrders(u.id);
    const topups = await db.userTopups(u.id);
    users.push({
      id: u.id, name: u.name || '', username: u.username,
      email: u.email || '', phone: u.phone || '',
      viaGoogle: !!u.googleId, balance: u.balance, isAdmin: !!u.isAdmin,
      status: u.status || 'active',
      createdAt: u.createdAt,
      orders: orders.length,
      spent: Math.round(orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.priceUsd || 0), 0) * 100) / 100,
      topups: topups.filter(t => t.status === 'approved').length,
      toppedUp: Math.round(topups.filter(t => t.status === 'approved').reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100
    });
  }
  users.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ users });
});
// Admin: adjust a user's balance (delta can be + or -); recorded in history
app.post('/api/admin/users/:id/adjust', requireAuth, requireAdmin, async (req, res) => {
  const t = await db.findUserById(req.params.id);
  if (!t) return res.status(404).json({ error: 'User not found' });
  const delta = Number((req.body || {}).delta);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000)
    return res.status(400).json({ error: 'Invalid amount' });
  const nb = Math.round((Number(t.balance) + delta) * 100) / 100;
  if (nb < 0) return res.status(400).json({ error: 'Balance would go negative' });
  await db.addBalance(t.id, delta);
  await db.addBonus({ userId: t.id, amount: delta, kind: 'adjust', label: 'Admin balance adjustment' });
  res.json({ ok: true, balance: nb });
});
// Admin: set user status — active | hold (no purchases) | banned (no login)
app.post('/api/admin/users/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const t = await db.findUserById(req.params.id);
  if (!t) return res.status(404).json({ error: 'User not found' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own status' });
  if (t.isAdmin) return res.status(400).json({ error: 'Admin accounts are protected' });
  const s = (req.body || {}).status;
  if (!['active', 'hold', 'banned'].includes(s)) return res.status(400).json({ error: 'Invalid status' });
  await db.setUserStatus(t.id, s);
  res.json({ ok: true, status: s });
});
// Admin: reset a user's password (support flow — the user forgot it and
// asked support; admin sets a fresh one, no current password needed)
app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const t = await db.findUserById(req.params.id);
  if (!t) return res.status(404).json({ error: 'User not found' });
  const pw = String((req.body || {}).password || '');
  if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const salt = crypto.randomBytes(8).toString('hex');
  await db.updateUser(t.id, { salt, hash: hashPw(pw, salt) });
  res.json({ ok: true });
});
app.post('/api/admin/topups/:id', requireAuth, requireAdmin, async (req, res) => {
  const t = await db.getTopup(req.params.id);
  if (!t || (t.status !== 'pending' && t.status !== 'awaiting')) return res.status(400).json({ error: 'Top-up is not pending' });
  if (req.body.action === 'approve') {
    const { bonus } = await approveTopupInternal(t);
    return res.json({ ok: true, bonus });
  } else {
    await db.updateTopup(t.id, { status: 'rejected' });
  }
  res.json({ ok: true });
});

// Shared approve logic: credit USD + once-per-user welcome bonus. Idempotent.
async function approveTopupInternal(t) {
  const cur = await db.getTopup(t.id);
  if (!cur || cur.status !== 'pending') return { already: true, bonus: 0 };
  await db.updateTopup(t.id, { status: 'approved' });
  await db.addBalance(t.userId, t.amount);
  // Welcome bonus: $X free on first approved deposit (once per user)
  let bonusGiven = 0;
  try {
    const cfg = await db.getConfig();
    const bonusUsd = Number(cfg.welcomeBonusUsd) || 0;
    if (cfg.welcomeBonusEnabled !== false && bonusUsd > 0 && !(await db.hasWelcomeBonus(t.userId))) {
      const limit = Number(cfg.welcomeBonusLimit) || 0;
      const given = Number(cfg.welcomeBonusGiven) || 0;
      if (limit === 0 || given < limit) {
        await db.addBonus({ userId: t.userId, amount: bonusUsd, kind: 'welcome', label: '🎁 Welcome bonus — first deposit' });
        await db.addBalance(t.userId, bonusUsd);
        await db.setConfig({ welcomeBonusGiven: given + 1 });
        bonusGiven = bonusUsd;
      }
    }
  } catch (e) { console.error('[bonus]', e.message); }
  return { bonus: bonusGiven };
}

// Parse a bKash/Nagad payment SMS → { trxid, amountBdt, balance } (nulls when not found)
// NOTE: bKash writes "TrxID: XXXXX" while Nagad writes "Txn ID: XXXXX" — accept both.
function parsePaymentSms(msg) {
  const m = String(msg || '');
  const trxM = m.match(/(?:Trx|Txn|Transaction)\s*ID\s*:?\s*([A-Z0-9]{6,})/i);
  const amtM = m.match(/(?:received|Amount)\s*:?\s*Tk\.?\s*([\d,]+(?:\.\d{1,2})?)/i)
    || m.match(/Tk\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const balM = m.match(/Balance\s*(?:is\s*)?:?\s*Tk\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
  return {
    trxid: trxM ? trxM[1].toUpperCase().replace(/\s+/g, '') : null,
    amountBdt: amtM ? parseFloat(amtM[1].replace(/,/g, '')) : null,
    balance: balM ? parseFloat(balM[1].replace(/,/g, '')) : null
  };
}

// Guess MFS method from SMS sender ("bKash" / "16247" → bkash, "Nagad" → nagad)
function smsMethod(sender) {
  const s = String(sender || '').toLowerCase();
  if (s.includes('bkash') || s.includes('16247')) return 'bkash';
  if (s.includes('nagad')) return 'nagad';
  return null;
}

// Latest OTP code forwarded from the payment phone (in-memory only, 5-min
// life) — powers the OTP Viewer app on the owner's main phone.
let smsOtp = { code: null, service: null, at: 0 };

// SMS webhook: phone forwarder calls this → auto-approve matching pending top-up.
// Accepts GET or POST, JSON or form-encoded. Field aliases for app compatibility:
//   secret | sender/from | message/text/body
async function handlePaymentWebhook(req, res) {
  try {
    const cfg = await db.getConfig();
    const b = req.body || {}, q = req.query || {};
    const secret = b.secret || q.secret;
    const sender = b.sender || b.from || q.sender || q.from || '';
    const message = b.message || b.text || b.body || q.message || q.text || q.body || '';
    if (!cfg.smsAutoApprove || !cfg.smsWebhookSecret || secret !== cfg.smsWebhookSecret)
      return res.status(403).json({ ok: false, reason: 'forbidden' });
    const { trxid, amountBdt, balance } = parsePaymentSms(message);
    const method = smsMethod(sender);
    // OTP capture: a login/verification SMS (has an OTP code, no payment
    // TrxID) → keep the code briefly for the owner's OTP Viewer app.
    if (!trxid) {
      const otpM = message.match(/(?:OTP|verification code|security code|one-time(?: password)?)\D{0,30}(\d{4,6})/i);
      if (otpM) {
        smsOtp = { code: otpM[1], service: method || String(sender || '').slice(0, 20), at: Date.now() };
        return res.json({ ok: true, otpStored: true });
      }
    }
    const balances = { ...(cfg.smsLastBalances || {}) };
    // Track last known balance from ANY bKash/Nagad SMS (keeps baseline fresh)
    if (method && balance != null && !trxid) {
      await db.setConfig({ smsLastBalances: { ...balances, [method]: balance } });
      return res.json({ ok: true, balanceTracked: balance });
    }
    if (!trxid) return res.json({ ok: false, reason: 'no-trxid-in-sms' });
    // Balance check (anti-fake-SMS): claimed amount must match actual balance jump
    if (cfg.smsBalanceCheck && method && balance != null && amountBdt != null && balances[method] != null) {
      const expected = balances[method] + amountBdt;
      if (Math.abs(balance - expected) > 2) {
        console.warn(`[sms-auto] BALANCE MISMATCH ${method}: last=${balances[method]} claimed=+${amountBdt} smsBalance=${balance} trxid=${trxid} — held for manual review`);
        return res.json({ ok: false, reason: 'balance-mismatch' });
      }
    }
    const pending = await db.topupsByStatus('pending');
    const t = pending.find(x => String(x.trxid || '').toUpperCase().replace(/\s+/g, '') === trxid);
    if (!t) return res.json({ ok: false, reason: 'no-matching-topup' });
    if (amountBdt != null && Math.abs(Number(t.amountBdt) - amountBdt) > 1)
      return res.json({ ok: false, reason: 'amount-mismatch' });
    const { bonus, already } = await approveTopupInternal(t);
    if (!already && method && balance != null)
      await db.setConfig({ smsLastBalances: { ...balances, [method]: balance } });
    console.log(`[sms-auto] topup ${t.id} (${t.username}, ৳${t.amountBdt}) auto-approved${already ? ' (already done)' : ''}`);
    res.json({ ok: true, credited: already ? 0 : t.amount, bonus });
  } catch (e) { console.error('[sms-webhook]', e.message); res.status(500).json({ ok: false }); }
}
app.post('/api/payment-webhook', handlePaymentWebhook);
app.get('/api/payment-webhook', handlePaymentWebhook);

// OTP Viewer app polls this (same webhook secret) for the latest OTP code
// forwarded from the payment phone. Codes expire after 5 minutes.
app.get('/api/otp-view', async (req, res) => {
  const cfg = await db.getConfig();
  if (!cfg.smsWebhookSecret || (req.query.secret || '') !== cfg.smsWebhookSecret)
    return res.status(403).json({ ok: false, reason: 'forbidden' });
  const ageSec = Math.round((Date.now() - (smsOtp.at || 0)) / 1000);
  if (!smsOtp.code || ageSec > 300) return res.json({ ok: true, otp: null });
  res.json({ ok: true, otp: { code: smsOtp.code, service: smsOtp.service, ageSec, expiresInSec: Math.max(0, 300 - ageSec) } });
});

// Regenerate the SMS webhook secret (admin)
app.post('/api/admin/sms-secret', requireAuth, requireAdmin, async (req, res) => {
  const secret = require('crypto').randomBytes(24).toString('hex');
  await db.setConfig({ smsWebhookSecret: secret });
  res.json({ ok: true, secret });
});

// ---------------- admin: live chat ----------------
app.get('/api/admin/chat/threads', requireAuth, requireAdmin, async (req, res) => {
  try {
    const threads = await db.listChatThreadsAdmin();
    res.json({
      threads: threads.map(t => ({
        id: t.id, status: t.status, displayName: t.displayName, username: t.username,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
        lastText: t.lastText, lastSender: t.lastSender, lastAt: t.lastAt, unread: t.unread
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/chat/stream/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const thread = await db.getChatThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    chatStream(req, res, thread, req.query.since);
  } catch (e) { try { res.status(500).end(); } catch (_) {} }
});
app.get('/api/admin/chat/thread/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const thread = await db.getChatThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    let displayName = thread.guestName || 'Guest';
    if (thread.userId) {
      const u = await db.findUserById(thread.userId);
      displayName = u ? (u.name || u.username) : 'User';
    }
    const messages = await db.listChatMessages(thread.id);
    res.json({
      thread: { id: thread.id, status: thread.status, displayName, createdAt: thread.createdAt, updatedAt: thread.updatedAt },
      messages: messages.map(m => ({ id: m.id, sender: m.sender, text: m.text, createdAt: m.createdAt }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chat/reply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { threadId, text } = req.body || {};
    const thread = await db.getChatThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    const msg = String(text || '').trim().slice(0, 2000);
    if (!msg) return res.status(400).json({ error: 'Message is empty' });
    const message = await db.addChatMessage(thread.id, 'admin', msg);
    res.json({ ok: true, message: { id: message.id, sender: message.sender, text: message.text, createdAt: message.createdAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chat/close/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const thread = await db.updateChatThread(req.params.id, { status: 'closed' });
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true, status: thread.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chat/reopen/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const thread = await db.updateChatThread(req.params.id, { status: 'open' });
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true, status: thread.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// FAQ manager (bot answers)
app.get('/api/admin/chat/faqs', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ faqs: await db.listChatFaqs() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chat/faqs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const keywords = String((req.body || {}).keywords || '').trim().slice(0, 500);
    const answer = String((req.body || {}).answer || '').trim().slice(0, 2000);
    if (!keywords || !answer) return res.status(400).json({ error: 'Keywords and answer are required' });
    const faq = await db.createChatFaq({ keywords, answer, active: true });
    res.json({ faq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/chat/faqs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const patch = {};
    if ((req.body || {}).keywords !== undefined) patch.keywords = String(req.body.keywords).trim().slice(0, 500);
    if ((req.body || {}).answer !== undefined) patch.answer = String(req.body.answer).trim().slice(0, 2000);
    if ((req.body || {}).active !== undefined) patch.active = !!req.body.active;
    if (!patch.keywords && !patch.answer && patch.active === undefined)
      return res.status(400).json({ error: 'Nothing to update' });
    const faq = await db.updateChatFaq(req.params.id, patch);
    if (!faq) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ faq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/chat/faqs/:id', requireAuth, requireAdmin, async (req, res) => {
  try { await db.deleteChatFaq(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// DB backup / restore — essential on hosts with an ephemeral disk (e.g. Render free),
// where the local data file is wiped on every redeploy. With DATABASE_URL set
// (Postgres), data survives redeploys automatically; backups still work in both modes.
app.get('/api/admin/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await db.exportJson();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="otpstation-backup-${stamp}.json"`);
    res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (e) { res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});
app.post('/api/admin/restore', requireAuth, requireAdmin, async (req, res) => {
  const data = (req.body || {}).data;
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.orders) ||
      !Array.isArray(data.topups) || typeof data.config !== 'object' || !data.config)
    return res.status(400).json({ error: 'Invalid backup file.' });
  try {
    await db.importJson(data);
    res.json({ ok: true, message: 'Backup restored. Users/topups/orders are back.' });
  } catch (e) { res.status(500).json({ error: 'Restore failed: ' + e.message }); }
});
app.get('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
  const c = await db.getConfig();
  res.json({ config: { ...c, bkashSet: !!c.bkashNumber, nagadSet: !!c.nagadNumber } });
});
app.post('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
  const { markupPercent, flatFeeUsd, provider, siteName, bkashNumber, nagadNumber, bdtRate, googleClientId, googleClientSecret, baseUrl, welcomeBonusUsd, welcomeBonusEnabled, welcomeBonusLimit, smsAutoApprove, smsBalanceCheck } = req.body || {};
  const patch = {};
  if (smsAutoApprove !== undefined) patch.smsAutoApprove = !!smsAutoApprove;
  if (smsBalanceCheck !== undefined) patch.smsBalanceCheck = !!smsBalanceCheck;
  if (markupPercent !== undefined) patch.markupPercent = Math.max(0, Math.min(500, Number(markupPercent) || 0));
  if (flatFeeUsd !== undefined) patch.flatFeeUsd = Math.max(0, Math.min(10, Number(flatFeeUsd) || 0));
  if (welcomeBonusUsd !== undefined) patch.welcomeBonusUsd = Math.max(0, Math.min(100, Number(welcomeBonusUsd) || 0));
  if (welcomeBonusEnabled !== undefined) patch.welcomeBonusEnabled = !!welcomeBonusEnabled;
  if (welcomeBonusLimit !== undefined) patch.welcomeBonusLimit = Math.max(0, Math.min(100000, Math.floor(Number(welcomeBonusLimit) || 0)));
  if (provider) patch.provider = provider;
  if (siteName) patch.siteName = String(siteName).slice(0, 40);
  if (bkashNumber !== undefined) {
    const v = String(bkashNumber).trim().replace(/[\s-]/g, '');
    if (v && !/^01[3-9]\d{8}$/.test(v)) return res.status(400).json({ error: 'Invalid bKash number (01XXXXXXXXX)' });
    patch.bkashNumber = v;
  }
  if (nagadNumber !== undefined) {
    const v = String(nagadNumber).trim().replace(/[\s-]/g, '');
    if (v && !/^01[3-9]\d{8}$/.test(v)) return res.status(400).json({ error: 'Invalid Nagad number (01XXXXXXXXX)' });
    patch.nagadNumber = v;
  }
  if (bdtRate !== undefined) {
    const r = Number(bdtRate);
    if (!r || r < 1 || r > 10000) return res.status(400).json({ error: 'Invalid BDT rate' });
    patch.bdtRate = r;
  }
  if (googleClientId !== undefined) patch.googleClientId = String(googleClientId).trim().slice(0, 120);
  if (googleClientSecret !== undefined) patch.googleClientSecret = String(googleClientSecret).trim().slice(0, 120);
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).trim().replace(/\/$/, '').slice(0, 120);
  await db.setConfig(patch);
  // auto-generate webhook secret the first time SMS auto-approve is enabled
  const c0 = await db.getConfig();
  if (c0.smsAutoApprove && !c0.smsWebhookSecret) {
    await db.setConfig({ smsWebhookSecret: require('crypto').randomBytes(24).toString('hex') });
  }
  const c = await db.getConfig();
  res.json({ config: { ...c, bkashSet: !!c.bkashNumber, nagadSet: !!c.nagadNumber } });
});

// Init the data layer first (Postgres when DATABASE_URL works, else JSON file),
// then start serving.
(async () => {
  await db.init();
  app.listen(PORT, async () => {
    const cfg = await db.getConfig();
    console.log(`OK ${cfg.siteName} running -> http://localhost:${PORT}`);
  });
})();
