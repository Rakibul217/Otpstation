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
    items.push({ label: b.label || 'Bonus', amount: Number(b.amount) || 0, at: b.createdAt, kind: 'credit' });
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
  imo: '#00B0FF'
};
app.get('/api/services', async (req, res) => {
  try {
    const p = await getProvider();
    const services = await p.getServices();
    const out = [];
    for (const s of services) {
      const countries = await p.getCountries(s.code);
      const prices = await Promise.all(countries.map(c => priceUSD(c.baseUsd)));
      const min = Math.min(...prices);
      out.push({ ...s, fromPrice: min, color: BRAND_COLORS[s.logo] || '#4f7cff' });
    }
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
function parsePaymentSms(msg) {
  const m = String(msg || '');
  const trxM = m.match(/Txn\s*ID\s*:?\s*([A-Z0-9]{5,})/i);
  const amtM = m.match(/Tk\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
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
