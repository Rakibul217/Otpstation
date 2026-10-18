// OTPStation — OTP selling website (Grizzly SMS style)
// Currency: USD. Payments: manual bKash / Nagad top-ups (TrxID + admin approval).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { getProvider } = require('./providers');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- session (MVP: in-memory) ----------------
const sessions = new Map();
function getSessionUser(req) {
  const m = /sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const uid = sessions.get(m[1]);
  return uid ? db.findUserById(uid) : null;
}
function setSession(res, uid) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uid);
  res.setHeader('Set-Cookie', `sess=${token}; Path=/; HttpOnly; SameSite=Lax`);
}
function requireAuth(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in first' });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ---------------- helpers ----------------
const uid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.createHash('sha256').update(salt + pw).digest('hex');
// USD price with up to 4 decimals, trimmed
function priceUSD(baseUsd) {
  const c = db.getConfig();
  const p = baseUsd * (1 + c.markupPercent / 100);
  return Math.max(0.01, Math.round(p * 10000) / 10000);
}
const fmtUSD = (v) => '$' + Number(v).toFixed(v < 1 ? 4 : 2).replace(/\.?0+$/, (m) => m.startsWith('.') ? '' : m) || '$0';
function fmtMoney(v) {
  const n = Number(v);
  return '$' + (n < 1 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2));
}
const pub = (u) => ({ id: u.id, name: u.name || '', username: u.username, email: u.email || '', phone: u.phone || '', balance: u.balance, isAdmin: u.isAdmin, hasPassword: !!u.hash, createdAt: u.createdAt });

// seed admin
if (!db.findUserByName('admin')) {
  const salt = crypto.randomBytes(8).toString('hex');
  db.addUser({ id: uid(), username: 'admin', salt, hash: hashPw('admin123', salt), balance: 0, isAdmin: true, createdAt: Date.now() });
  console.log('Seed admin created -> username: admin / password: admin123 (change it after first login!)');
}

// ---------------- auth ----------------
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const isPhone = (s) => /^\+?[0-9][0-9\s\-()]{5,18}$/.test(s);
function uniqueUsername(base) {
  let b = String(base || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'user';
  if (b.length < 3) b = 'user' + b;
  let name = b, i = 1;
  while (db.findUserByName(name)) name = b + (i++);
  return name;
}
app.post('/api/register', (req, res) => {
  const { name, username, contact, password } = req.body || {};
  if (!name || String(name).trim().length < 2 || String(name).length > 50) return res.status(400).json({ error: 'Please enter your full name' });
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 chars (a-z, 0-9, _)' });
  const c = String(contact || '').trim();
  let email = '', phone = '';
  if (isEmail(c)) email = c.toLowerCase();
  else if (isPhone(c)) phone = c.replace(/[\s\-()]/g, '');
  else return res.status(400).json({ error: 'Enter a valid email address or phone number' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (db.findUserByName(username)) return res.status(400).json({ error: 'Username already taken' });
  if (email && db.findUserByEmail(email)) return res.status(400).json({ error: 'This email is already registered' });
  const salt = crypto.randomBytes(8).toString('hex');
  const u = db.addUser({ id: uid(), name: String(name).trim(), username, email, phone, salt, hash: hashPw(password, salt), balance: 0, isAdmin: false, createdAt: Date.now() });
  setSession(res, u.id);
  res.json({ user: pub(u) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const id = String(username || '').trim();
  const u = db.findUserByName(id) || db.findUserByEmail(id);
  if (!u || !u.hash || u.hash !== hashPw(password, u.salt)) return res.status(401).json({ error: 'Wrong username or password' });
  setSession(res, u.id);
  res.json({ user: pub(u) });
});

app.post('/api/logout', (req, res) => {
  const m = /sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) sessions.delete(m[1]);
  res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = getSessionUser(req);
  res.json({ user: u ? pub(u) : null, siteName: db.getConfig().siteName });
});

// ---------------- profile ----------------
app.put('/api/profile', requireAuth, (req, res) => {
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
  if (email && db.getUsers().some(x => x.id !== u.id && x.email && x.email.toLowerCase() === email))
    return res.status(400).json({ error: 'This email is already registered' });
  db.updateUser(u.id, { name: newName, email, phone });
  res.json({ user: pub(db.findUserById(u.id)) });
});

app.post('/api/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = req.user;
  if (u.hash && (!currentPassword || u.hash !== hashPw(currentPassword, u.salt)))
    return res.status(400).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const salt = crypto.randomBytes(8).toString('hex');
  db.updateUser(u.id, { salt, hash: hashPw(newPassword, salt) });
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req, res) => {
  const u = req.user;
  const items = [];
  for (const t of db.userTopups(u.id)) {
    const amt = Number(t.amount) || 0;
    if (t.status === 'approved') items.push({ label: `Top-up approved (${t.method || ''})`, amount: amt, at: t.createdAt, kind: 'credit' });
    else if (t.status === 'rejected') items.push({ label: 'Top-up rejected', amount: amt, at: t.createdAt, kind: 'none' });
    else items.push({ label: t.status === 'pending' ? 'Top-up pending review' : 'Top-up awaiting payment', amount: amt, at: t.createdAt, kind: 'none' });
  }
  for (const o of db.userOrders(u.id)) {
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
function googleRedirectUri(req) {
  const cfg = db.getConfig();
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '') + '/api/auth/google/callback';
  let proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host') || '';
  if (host.endsWith('.loca.lt')) proto = 'https'; // tunnels terminate TLS at the edge
  return `${proto}://${host}/api/auth/google/callback`;
}
app.get('/api/auth/providers', (req, res) => {
  res.json({ google: !!db.getConfig().googleClientId });
});
app.get('/api/auth/google', (req, res) => {
  const cfg = db.getConfig();
  if (!cfg.googleClientId) return res.status(400).send('Google login is not configured. Ask the site admin to set it up in Admin → Settings.');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: googleRedirectUri(req),
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
    const cfg = db.getConfig();
    if (!cfg.googleClientId || !cfg.googleClientSecret) return res.status(400).send('Google login is not configured.');
    // exchange code for tokens
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
        redirect_uri: googleRedirectUri(req), grant_type: 'authorization_code'
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
    let u = db.findUserByGoogleId(profile.sub) || db.findUserByEmail(email);
    if (u) {
      if (!u.googleId) db.updateUser(u.id, { googleId: profile.sub });
    } else {
      const salt = crypto.randomBytes(8).toString('hex');
      u = db.addUser({
        id: uid(), name: String(profile.name || email.split('@')[0]).slice(0, 50),
        username: uniqueUsername(email.split('@')[0]), email, phone: '',
        salt, hash: '', googleId: profile.sub, balance: 0, isAdmin: false, createdAt: Date.now()
      });
    }
    setSession(res, u.id);
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
    const p = getProvider();
    const services = await p.getServices();
    const out = [];
    for (const s of services) {
      const countries = await p.getCountries(s.code);
      const min = Math.min(...countries.map(c => priceUSD(c.baseUsd)));
      out.push({ ...s, fromPrice: min, color: BRAND_COLORS[s.logo] || '#4f7cff' });
    }
    res.json({ services: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/countries', async (req, res) => {
  try {
    const p = getProvider();
    const list = await p.getCountries(req.query.service);
    res.json({ countries: list.map(c => ({ ...c, priceUsd: priceUSD(c.baseUsd) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  try {
    const { service, country } = req.body || {};
    const p = getProvider();
    const countries = await p.getCountries(service);
    const c = countries.find(x => x.code === country);
    if (!c) return res.status(400).json({ error: 'Country not found' });
    const services = await p.getServices();
    const s = services.find(x => x.code === service) || { name: service };
    const price = priceUSD(c.baseUsd);
    const me = db.findUserById(req.user.id);
    if (me.balance < price) return res.status(400).json({ error: `Insufficient balance — need ${fmtMoney(price)}, have ${fmtMoney(me.balance)}` });
    const bought = await p.buyNumber(service, country);
    me.balance = Math.round((me.balance - price) * 10000) / 10000; db.persist();
    const order = db.addOrder({
      id: uid(), userId: me.id, service, serviceName: s.name,
      country, countryName: c.name, number: bought.number,
      priceUsd: price, providerId: bought.providerId,
      status: 'waiting', code: null, createdAt: Date.now()
    });
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', requireAuth, (req, res) => {
  res.json({ orders: db.userOrders(req.user.id) });
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const o = db.getOrder(req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'waiting') {
    try {
      const code = await getProvider().getSms(o.providerId);
      if (code) db.updateOrder(o.id, { status: 'done', code });
    } catch (e) { /* stays waiting on provider error */ }
  }
  res.json({ order: db.getOrder(o.id) });
});

app.post('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  const o = db.getOrder(req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'waiting') return res.status(400).json({ error: 'This order cannot be cancelled' });
  try { await getProvider().cancel(o.providerId); } catch (e) {}
  db.updateOrder(o.id, { status: 'cancelled' });
  db.addBalance(o.userId, o.priceUsd);
  res.json({ ok: true, refund: o.priceUsd });
});

// ---------------- top-up: manual bKash / Nagad ----------------
// User sends BDT to the admin's number, then submits the TrxID.
// Admin verifies in the bKash/Nagad app and approves -> USD credited.
const MIN_USD = 5, MAX_BDT = 50000;
const METHOD_NAMES = { bkash: 'bKash', nagad: 'Nagad' };

app.get('/api/payinfo', (req, res) => {
  const c = db.getConfig();
  const rate = c.bdtRate || 125;
  const methods = [];
  if (c.bkashNumber) methods.push({ id: 'bkash', name: 'bKash', number: c.bkashNumber });
  if (c.nagadNumber) methods.push({ id: 'nagad', name: 'Nagad', number: c.nagadNumber });
  res.json({ methods, bdtRate: rate, minBdt: Math.ceil(MIN_USD * rate), maxBdt: MAX_BDT, minUsd: MIN_USD });
});

// Submit a top-up: { method: 'bkash'|'nagad', amountBdt, senderNumber, trxid }
app.post('/api/topups', requireAuth, (req, res) => {
  const { method, amountBdt, senderNumber, trxid } = req.body || {};
  const cfg = db.getConfig();
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
  if (db.getTopupByTrxid(tx)) return res.status(400).json({ error: 'This TrxID was already submitted.' });
  const usd = Math.round((bdt / rate) * 100) / 100;
  const t = db.addTopup({
    id: uid(), userId: req.user.id, username: req.user.username,
    amount: usd, amountBdt: bdt, bdtRate: rate,
    method: METHOD_NAMES[method], senderNumber: sender, trxid: tx,
    status: 'pending', createdAt: Date.now()
  });
  res.json({ topup: t });
});

app.get('/api/topups/mine', requireAuth, (req, res) => {
  res.json({ topups: db.userTopups(req.user.id) });
});

// ---------------- admin ----------------
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const s = db.stats();
  s.revenue = Math.round(s.revenue * 100) / 100;
  res.json(s);
});
app.get('/api/admin/topups', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const list = status === 'awaiting' ? db.topupsByStatus('awaiting') : db.topupsByStatus(status);
  res.json({ topups: list });
});
// Full user list with profile + activity details (password hashes never sent)
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.getUsers().map(u => {
    const orders = db.userOrders(u.id);
    const topups = db.userTopups(u.id);
    return {
      id: u.id, name: u.name || '', username: u.username,
      email: u.email || '', phone: u.phone || '',
      viaGoogle: !!u.googleId, balance: u.balance, isAdmin: !!u.isAdmin,
      createdAt: u.createdAt,
      orders: orders.length,
      spent: Math.round(orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.priceUsd || 0), 0) * 100) / 100,
      topups: topups.filter(t => t.status === 'approved').length,
      toppedUp: Math.round(topups.filter(t => t.status === 'approved').reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ users });
});
app.post('/api/admin/topups/:id', requireAuth, requireAdmin, (req, res) => {
  const t = db.getTopup(req.params.id);
  if (!t || (t.status !== 'pending' && t.status !== 'awaiting')) return res.status(400).json({ error: 'Top-up is not pending' });
  if (req.body.action === 'approve') {
    db.updateTopup(t.id, { status: 'approved' });
    db.addBalance(t.userId, t.amount);
  } else {
    db.updateTopup(t.id, { status: 'rejected' });
  }
  res.json({ ok: true });
});

// DB backup / restore — essential on hosts with an ephemeral disk (e.g. Render free),
// where data/db.json is wiped on every redeploy. Download a backup regularly!
const DB_FILE_PATH = path.join(__dirname, 'data', 'db.json');
app.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
    JSON.parse(raw); // sanity check
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="otpstation-backup-${stamp}.json"`);
    res.type('application/json').send(raw);
  } catch (e) { res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});
app.post('/api/admin/restore', requireAuth, requireAdmin, (req, res) => {
  const data = (req.body || {}).data;
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.orders) ||
      !Array.isArray(data.topups) || typeof data.config !== 'object' || !data.config)
    return res.status(400).json({ error: 'Invalid backup file.' });
  try {
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(data, null, 2));
    db.reload();
    res.json({ ok: true, message: 'Backup restored. Users/topups/orders are back.' });
  } catch (e) { res.status(500).json({ error: 'Restore failed: ' + e.message }); }
});
app.get('/api/admin/config', requireAuth, requireAdmin, (req, res) => {
  const c = db.getConfig();
  res.json({ config: { ...c, bkashSet: !!c.bkashNumber, nagadSet: !!c.nagadNumber } });
});
app.post('/api/admin/config', requireAuth, requireAdmin, (req, res) => {
  const { markupPercent, provider, siteName, bkashNumber, nagadNumber, bdtRate, googleClientId, googleClientSecret, baseUrl } = req.body || {};
  const patch = {};
  if (markupPercent !== undefined) patch.markupPercent = Math.max(0, Math.min(500, Number(markupPercent) || 0));
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
  db.setConfig(patch);
  const c = db.getConfig();
  res.json({ config: { ...c, bkashSet: !!c.bkashNumber, nagadSet: !!c.nagadNumber } });
});

app.listen(PORT, () => console.log(`OK ${db.getConfig().siteName} running -> http://localhost:${PORT}`));
