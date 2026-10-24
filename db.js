// OTPStation data layer — dual mode.
//
// PostgreSQL mode: used when DATABASE_URL is set and reachable (e.g. Neon on
// Render). Tables are created with CREATE TABLE IF NOT EXISTS at startup, so
// users / top-ups / orders / config / sessions survive redeploys.
// JSON-file mode: the original MVP behavior (data/db.json), used when
// DATABASE_URL is unset or Postgres is unreachable. The site NEVER crashes
// because Postgres is unavailable — it logs a warning and falls back.
//
// Every exported function is async (returns a Promise) in both modes.
// Call db.init() once at startup before serving requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function defaultConfig() {
  return {
    provider: 'mock', markupPercent: 40, flatFeeUsd: 0, siteName: 'OTPStation',
    // Manual bKash/Nagad top-ups — admin's personal numbers + BDT→USD rate
    bkashNumber: '', nagadNumber: '', bdtRate: 125,
    // Google OAuth ("Continue with Google") — set in Admin → Settings
    googleClientId: '', googleClientSecret: '', baseUrl: '',
    // Welcome bonus: $X free credit on first approved deposit (once per user)
    welcomeBonusUsd: 1, welcomeBonusEnabled: true, welcomeBonusLimit: 0, welcomeBonusGiven: 0,
    // SMS auto-approval: phone forwards bKash/Nagad payment SMS to webhook → matching top-up auto-approved
    smsAutoApprove: false, smsWebhookSecret: '',
    // Balance check: verify claimed payment against bKash/Nagad balance in SMS (anti-fake-SMS)
    smsBalanceCheck: false, smsLastBalances: {},
    // Backup provider (SMSBower): orders route there when the primary is
    // out of stock for a service+country or SMSBower is cheaper
    smsbowerEnabled: false, smsbowerApiKey: ''
  };
}
function defaultDb() {
  return {
    users: [],   // {id, name, username, email, phone, salt, hash, googleId, balance, isAdmin, createdAt}
    orders: [],  // {id, userId, service, serviceName, country, countryName, number, priceUsd, providerId, status, code, createdAt}
    topups: [],  // {id, userId, username, amount, amountBdt, bdtRate, method, senderNumber, trxid, status, createdAt}
    config: defaultConfig(),
    accountProducts: [], // {id, name, description, priceUsd, logo, active, createdAt}
    accountStock: [],    // {id, productId, credential, status:'available'|'sold', soldToUserId, soldAt, createdAt}
    accountOrders: [],   // {id, userId, productId, productName, qty, totalUsd, items[], createdAt}
    chatThreads: [],  // {id, userId|null, guestName, guestToken, status:'open'|'closed', createdAt, updatedAt}
    chatMessages: [],  // {id, threadId, sender:'user'|'bot'|'agent'|'admin', text, createdAt}
    chatFaqs: [],       // {id, keywords, answer, active, createdAt}
    bonuses: [],       // {id, userId, amount, kind:'welcome', label, createdAt}
    complaints: []     // {id, userId, username, kind:'account'|'order', refId, productId, productName, item, category, description, image, status:'pending'|'replaced'|'rejected'|'resolved', adminNote, replacement, createdAt, updatedAt}
  };
}

const uid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.createHash('sha256').update(salt + pw).digest('hex');

// ---------------- JSON-file mode ----------------
function save(d) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
}
function load() {
  try {
    if (!fs.existsSync(DB_FILE)) { const d = defaultDb(); save(d); return d; }
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // forward-fill keys added after this file was created (e.g. accounts shop)
    const fresh = defaultDb();
    for (const k of Object.keys(fresh)) if (d[k] === undefined) d[k] = fresh[k];
    return d;
  } catch (e) {
    const d = defaultDb(); save(d); return d;
  }
}
let cache = null;
function mem() { if (!cache) cache = load(); return cache; }
const jsonSessions = new Map(); // token -> userId (in-memory, like before)

// ---------------- PostgreSQL mode ----------------
let pool = null;
let pgMode = false;
let initDone = false;

function isPostgres() { return pgMode; }

// TLS is required by hosted Postgres (Neon, Render, ...); local dev/test
// instances usually run without it. An explicit ?sslmode=require always wins.
function pgSslFor(url) {
  if (/sslmode=require/.test(url)) return { rejectUnauthorized: false };
  if (/(localhost|127\.0\.0\.1)/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      username TEXT UNIQUE,
      email TEXT,
      phone TEXT,
      salt TEXT,
      hash TEXT,
      "googleId" TEXT,
      balance NUMERIC DEFAULT 0,
      "isAdmin" BOOLEAN DEFAULT FALSE,
      "createdAt" BIGINT,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      service TEXT,
      "serviceName" TEXT,
      country TEXT,
      "countryName" TEXT,
      number TEXT,
      "priceUsd" NUMERIC,
      "providerId" TEXT,
      status TEXT,
      code TEXT,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS topups (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      username TEXT,
      amount NUMERIC,
      "amountBdt" NUMERIC,
      "bdtRate" NUMERIC,
      method TEXT,
      trxid TEXT,
      "senderNumber" TEXT,
      status TEXT,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS config (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      "userId" TEXT,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS account_products (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      "priceUsd" NUMERIC,
      logo TEXT,
      active BOOLEAN DEFAULT TRUE,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS account_stock (
      id TEXT PRIMARY KEY,
      "productId" TEXT,
      credential TEXT,
      status TEXT DEFAULT 'available',
      "soldToUserId" TEXT,
      "soldAt" BIGINT,
      "createdAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_account_stock_product ON account_stock ("productId", status);
    CREATE TABLE IF NOT EXISTS account_orders (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      "productId" TEXT,
      "productName" TEXT,
      qty INTEGER,
      "totalUsd" NUMERIC,
      items JSONB,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      "guestName" TEXT,
      "guestToken" TEXT,
      status TEXT DEFAULT 'open',
      "createdAt" BIGINT,
      "updatedAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads ("userId", status);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      "threadId" TEXT,
      sender TEXT,
      "text" TEXT,
      "createdAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages ("threadId", "createdAt");
    CREATE TABLE IF NOT EXISTS chat_faqs (
      id TEXT PRIMARY KEY,
      keywords TEXT,
      answer TEXT,
      active BOOLEAN DEFAULT TRUE,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS bonuses (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      amount NUMERIC DEFAULT 0,
      kind TEXT,
      label TEXT,
      "createdAt" BIGINT
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      username TEXT,
      kind TEXT,
      "refId" TEXT,
      "productId" TEXT,
      "productName" TEXT,
      item TEXT,
      category TEXT,
      description TEXT,
      image TEXT,
      status TEXT DEFAULT 'pending',
      "adminNote" TEXT,
      replacement TEXT,
      "createdAt" BIGINT,
      "updatedAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints ("userId", "createdAt");
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints (status, "createdAt");
  `);
}

// ---- row mappers: pg types -> the plain JS shapes the app expects ----
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function mapUser(r) {
  if (!r) return undefined;
  return {
    id: r.id, name: r.name || '', username: r.username,
    email: r.email || '', phone: r.phone || '',
    salt: r.salt || '', hash: r.hash || '',
    googleId: r.googleId === null || r.googleId === undefined ? undefined : r.googleId,
    balance: num(r.balance), isAdmin: !!r.isAdmin, createdAt: num(r.createdAt),
    status: r.status || 'active'
  };
}
function mapOrder(r) {
  if (!r) return undefined;
  return {
    id: r.id, userId: r.userId, service: r.service, serviceName: r.serviceName,
    country: r.country, countryName: r.countryName, number: r.number,
    priceUsd: num(r.priceUsd), providerId: r.providerId, status: r.status,
    code: r.code === undefined ? null : r.code, createdAt: num(r.createdAt)
  };
}
function mapTopup(r) {
  if (!r) return undefined;
  return {
    id: r.id, userId: r.userId, username: r.username,
    amount: num(r.amount), amountBdt: num(r.amountBdt), bdtRate: num(r.bdtRate),
    method: r.method, trxid: r.trxid, senderNumber: r.senderNumber,
    status: r.status, createdAt: num(r.createdAt)
  };
}
function mapAccountProduct(r) {
  if (!r) return undefined;
  return {
    id: r.id, name: r.name || '', description: r.description || '',
    priceUsd: num(r.priceUsd), logo: r.logo || '',
    active: !!r.active, createdAt: num(r.createdAt)
  };
}
function mapAccountOrder(r) {
  if (!r) return undefined;
  let items = r.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
  return {
    id: r.id, userId: r.userId, productId: r.productId, productName: r.productName || '',
    qty: Number(r.qty) || 0, totalUsd: num(r.totalUsd),
    items: Array.isArray(items) ? items : [], createdAt: num(r.createdAt)
  };
}
function mapChatThread(r) {
  if (!r) return undefined;
  return {
    id: r.id, userId: r.userId || null, guestName: r.guestName || '',
    guestToken: r.guestToken || null, status: r.status || 'open',
    createdAt: num(r.createdAt), updatedAt: num(r.updatedAt)
  };
}
function mapChatMessage(r) {
  if (!r) return undefined;
  return { id: r.id, threadId: r.threadId, sender: r.sender, text: r.text || '', createdAt: num(r.createdAt) };
}
function mapChatFaq(r) {
  if (!r) return undefined;
  return { id: r.id, keywords: r.keywords || '', answer: r.answer || '', active: !!r.active, createdAt: num(r.createdAt) };
}

const USER_COLS = ['id', 'name', 'username', 'email', 'phone', 'salt', 'hash', 'googleId', 'balance', 'isAdmin', 'createdAt', 'status'];
const ORDER_COLS = ['id', 'userId', 'service', 'serviceName', 'country', 'countryName', 'number', 'priceUsd', 'providerId', 'status', 'code', 'createdAt'];
const TOPUP_COLS = ['id', 'userId', 'username', 'amount', 'amountBdt', 'bdtRate', 'method', 'trxid', 'senderNumber', 'status', 'createdAt'];
const ACCOUNT_PRODUCT_COLS = ['id', 'name', 'description', 'priceUsd', 'logo', 'active', 'createdAt'];
const ACCOUNT_STOCK_COLS = ['id', 'productId', 'credential', 'status', 'soldToUserId', 'soldAt', 'createdAt'];
const ACCOUNT_ORDER_COLS = ['id', 'userId', 'productId', 'productName', 'qty', 'totalUsd', 'items', 'createdAt'];
const CHAT_THREAD_COLS = ['id', 'userId', 'guestName', 'guestToken', 'status', 'createdAt', 'updatedAt'];
const CHAT_MESSAGE_COLS = ['id', 'threadId', 'sender', 'text', 'createdAt'];
const CHAT_FAQ_COLS = ['id', 'keywords', 'answer', 'active', 'createdAt'];
const BONUS_COLS = ['id', 'userId', 'amount', 'kind', 'label', 'createdAt'];
const COMPLAINT_COLS = ['id', 'userId', 'username', 'kind', 'refId', 'productId', 'productName', 'item', 'category', 'description', 'image', 'status', 'adminNote', 'replacement', 'createdAt', 'updatedAt'];
function mapComplaint(r) {
  if (!r) return undefined;
  return {
    id: r.id, userId: r.userId, username: r.username || '', kind: r.kind || 'account',
    refId: r.refId, productId: r.productId || null, productName: r.productName || '',
    item: r.item || '', category: r.category || '', description: r.description || '',
    image: r.image || null, status: r.status || 'pending', adminNote: r.adminNote || '',
    replacement: r.replacement || null, createdAt: num(r.createdAt), updatedAt: num(r.updatedAt)
  };
}
function mapBonus(r) {
  if (!r) return undefined;
  return { id: r.id, userId: r.userId, amount: num(r.amount), kind: r.kind || '', label: r.label || '', createdAt: num(r.createdAt) };
}
async function pgAddBonus({ userId, amount, kind, label }) {
  const b = { id: uid(), userId, amount, kind: kind || '', label: label || '', createdAt: Date.now() };
  await pgInsert((q, p) => pool.query(q, p), 'bonuses', BONUS_COLS, b);
  return b;
}
async function pgUserBonuses(userId) {
  const r = await pool.query('SELECT * FROM bonuses WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]);
  return r.rows.map(mapBonus);
}

// ---- complaints (pg implementations) ----
async function pgCreateComplaint(c) {
  await pgInsert((q, p) => pool.query(q, p), 'complaints', COMPLAINT_COLS, c);
  return c;
}
async function pgMyComplaints(userId) {
  const r = await pool.query(`SELECT * FROM complaints WHERE "userId" = $1 ${NEWEST_FIRST}`, [userId]);
  return r.rows.map(mapComplaint);
}
async function pgAdminComplaints(status) {
  const r = status === 'pending'
    ? await pool.query(`SELECT * FROM complaints WHERE status = 'pending' ${NEWEST_FIRST} LIMIT 100`)
    : await pool.query(`SELECT * FROM complaints ${NEWEST_FIRST} LIMIT 100`);
  return r.rows.map(mapComplaint);
}
async function pgGetComplaint(id) {
  const r = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
  return mapComplaint(r.rows[0]);
}
async function pgDecideComplaint(id, status, note) {
  const c = await pgGetComplaint(id);
  if (!c) throw new Error('Complaint not found');
  if (c.status !== 'pending') throw new Error('This complaint was already handled');
  await pool.query('UPDATE complaints SET status = $2, "adminNote" = $3, "updatedAt" = $4 WHERE id = $1',
    [id, status, note || '', Date.now()]);
  return pgGetComplaint(id);
}
// Give a free replacement for an account purchase: atomically take the next
// available stock item of the same product, record it as a $0 account order
// in the buyer's My Accounts, and mark the complaint replaced. One shot only
// (the caller also blocks a second complaint for an already-replaced item).
async function pgReplaceComplaint(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);
    const cr = await q('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [id]);
    const c = mapComplaint(cr.rows[0]);
    if (!c) throw new Error('Complaint not found');
    if (c.status !== 'pending') throw new Error('This complaint was already handled');
    if (c.kind !== 'account' || !c.productId) throw new Error('Replacement is only available for account purchases');
    const sr = await q(
      `SELECT id, credential FROM account_stock WHERE "productId" = $1 AND status = 'available' ORDER BY "createdAt" ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [c.productId]
    );
    if (!sr.rows.length) throw new Error('No stock left for this product — add stock first, or reject/resolve instead');
    const stock = sr.rows[0];
    const now = Date.now();
    await q('UPDATE account_stock SET status = \'sold\', "soldToUserId" = $2, "soldAt" = $3 WHERE id = $1', [stock.id, c.userId, now]);
    const order = {
      id: uid(), userId: c.userId, productId: c.productId,
      productName: (c.productName || 'Account') + ' (Replacement)', qty: 1, totalUsd: 0,
      items: [stock.credential], createdAt: now
    };
    await pgInsert(q, 'account_orders', ACCOUNT_ORDER_COLS, Object.assign({}, order, { items: JSON.stringify(order.items) }));
    await q('UPDATE complaints SET status = \'replaced\', replacement = $2, "updatedAt" = $3 WHERE id = $1', [id, stock.credential, now]);
    await client.query('COMMIT');
    return pgGetComplaint(id);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

function dbVal(v) { return v === undefined ? null : v; }
function pickCols(obj, cols) {
  const out = {};
  for (const c of cols) out[c] = dbVal(obj[c]);
  return out;
}
async function pgInsert(q, table, cols, obj) {
  const row = pickCols(obj, cols);
  const quoted = cols.map(c => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await q(`INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`, cols.map(c => row[c]));
}
async function pgUpdate(table, cols, id, patch, mapRow) {
  const keys = Object.keys(patch || {}).filter(k => k !== 'id' && cols.includes(k));
  if (keys.length === 0) {
    const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return mapRow(r.rows[0]);
  }
  const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const vals = keys.map(k => dbVal(patch[k]));
  const r = await pool.query(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`, [id, ...vals]);
  return mapRow(r.rows[0]);
}
async function pgGetById(table, id, mapRow) {
  const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return mapRow(r.rows[0]);
}
const NEWEST_FIRST = `ORDER BY "createdAt" DESC, id DESC`;

// ---- pg implementations ----
async function pgGetConfig() {
  const r = await pool.query('SELECT data FROM config WHERE id = 1');
  const stored = (r.rows[0] && r.rows[0].data) || {};
  return Object.assign({}, defaultConfig(), stored);
}
async function pgSetConfig(patch) {
  const merged = Object.assign(await pgGetConfig(), patch);
  await pool.query(
    'INSERT INTO config (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
    [JSON.stringify(merged)]
  );
}
async function pgStats() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COALESCE(SUM("priceUsd"), 0) FROM orders WHERE (status <> 'cancelled' OR status IS NULL)) AS revenue,
      (SELECT COALESCE(SUM(amount), 0) FROM topups WHERE status = 'approved') AS "totalReceived",
      (SELECT COUNT(*) FROM topups WHERE status IN ('pending', 'awaiting')) AS "pendingTopups"
  `);
  const row = r.rows[0];
  return {
    users: Number(row.users), orders: Number(row.orders),
    revenue: Number(row.revenue), totalReceived: Number(row.totalReceived),
    pendingTopups: Number(row.pendingTopups)
  };
}
async function pgExport() {
  const [u, o, t, ap, as_, ao, ct, cm, cf, bn] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY "createdAt" ASC, id ASC'),
    pool.query(`SELECT * FROM orders ${NEWEST_FIRST}`),
    pool.query(`SELECT * FROM topups ${NEWEST_FIRST}`),
    pool.query('SELECT * FROM account_products ORDER BY "createdAt" ASC, id ASC'),
    pool.query('SELECT * FROM account_stock ORDER BY "createdAt" ASC, id ASC'),
    pool.query(`SELECT * FROM account_orders ${NEWEST_FIRST}`),
    pool.query('SELECT * FROM chat_threads ORDER BY "createdAt" ASC, id ASC'),
    pool.query('SELECT * FROM chat_messages ORDER BY "createdAt" ASC, id ASC'),
    pool.query('SELECT * FROM chat_faqs ORDER BY "createdAt" ASC, id ASC'),
    pool.query('SELECT * FROM bonuses ORDER BY "createdAt" ASC, id ASC')
  ]);
  return {
    users: u.rows.map(mapUser),
    orders: o.rows.map(mapOrder),
    topups: t.rows.map(mapTopup),
    config: await pgGetConfig(),
    accountProducts: ap.rows.map(mapAccountProduct),
    accountStock: as_.rows.map(r => ({
      id: r.id, productId: r.productId, credential: r.credential, status: r.status,
      soldToUserId: r.soldToUserId || null, soldAt: r.soldAt === null ? null : num(r.soldAt),
      createdAt: num(r.createdAt)
    })),
    accountOrders: ao.rows.map(mapAccountOrder),
    chatThreads: ct.rows.map(mapChatThread),
    chatMessages: cm.rows.map(mapChatMessage),
    chatFaqs: cf.rows.map(mapChatFaq),
    bonuses: bn.rows.map(mapBonus),
    complaints: await pgAdminComplaints('all')
  };
}
function validateBackup(data) {
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.orders) ||
      !Array.isArray(data.topups) || typeof data.config !== 'object' || !data.config) {
    throw new Error('Invalid backup file.');
  }
  for (const k of ['accountProducts', 'accountStock', 'accountOrders', 'chatThreads', 'chatMessages', 'chatFaqs', 'bonuses', 'complaints']) {
    if (data[k] === undefined) data[k] = [];
    else if (!Array.isArray(data[k])) throw new Error('Invalid backup file.');
  }
}
async function pgImport(data) {
  validateBackup(data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (text, params) => client.query(text, params);
    await q('DELETE FROM chat_faqs');
    await q('DELETE FROM chat_messages');
    await q('DELETE FROM chat_threads');
    await q('DELETE FROM account_orders');
    await q('DELETE FROM account_stock');
    await q('DELETE FROM account_products');
    await q('DELETE FROM topups');
    await q('DELETE FROM orders');
    await q('DELETE FROM users');
    await q('DELETE FROM config');
    for (const u of data.users) await pgInsert(q, 'users', USER_COLS, u);
    for (const o of data.orders) await pgInsert(q, 'orders', ORDER_COLS, o);
    for (const t of data.topups) await pgInsert(q, 'topups', TOPUP_COLS, t);
    for (const p of data.accountProducts) await pgInsert(q, 'account_products', ACCOUNT_PRODUCT_COLS, p);
    for (const s of data.accountStock) await pgInsert(q, 'account_stock', ACCOUNT_STOCK_COLS, s);
    for (const o of data.accountOrders) await pgInsert(q, 'account_orders', ACCOUNT_ORDER_COLS, Object.assign({}, o, { items: JSON.stringify(o.items || []) }));
    for (const ct of data.chatThreads) await pgInsert(q, 'chat_threads', CHAT_THREAD_COLS, ct);
    for (const cm of data.chatMessages) await pgInsert(q, 'chat_messages', CHAT_MESSAGE_COLS, cm);
    for (const cf of data.chatFaqs) await pgInsert(q, 'chat_faqs', CHAT_FAQ_COLS, cf);
    await q('DELETE FROM bonuses');
    for (const b of data.bonuses || []) await pgInsert(q, 'bonuses', BONUS_COLS, b);
    await q('DELETE FROM complaints');
    for (const c of data.complaints || []) await pgInsert(q, 'complaints', COMPLAINT_COLS, c);
    await q('INSERT INTO config (id, data) VALUES (1, $1)', [JSON.stringify(data.config || {})]);
    await q('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ---- accounts shop (pg implementations) ----
async function pgProductStockCounts() {
  const r = await pool.query(`
    SELECT "productId",
      COUNT(*) FILTER (WHERE status = 'available') AS available,
      COUNT(*) FILTER (WHERE status = 'sold') AS sold
    FROM account_stock GROUP BY "productId"`);
  const m = {};
  for (const row of r.rows) m[row.productId] = { available: Number(row.available), sold: Number(row.sold) };
  return m;
}
function withCounts(products, counts) {
  return products.map(p => Object.assign({}, p, counts[p.id] || { available: 0, sold: 0 }));
}
async function pgAddAccountStock(productId, lines) {
  if (!lines.length) return 0;
  const now = Date.now();
  const values = [], params = [];
  lines.forEach((line, i) => {
    const o = i * 6;
    values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
    params.push(uid(), productId, line, 'available', null, now);
  });
  await pool.query(
    `INSERT INTO account_stock (id, "productId", credential, status, "soldToUserId", "createdAt") VALUES ${values.join(', ')}`,
    params
  );
  return lines.length;
}
// Atomic buy: locks product + user + stock rows in ONE transaction.
// Throws a clean Error and changes NOTHING on any failure.
async function pgBuyAccountStock(productId, userId, qty) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);
    const pr = await q('SELECT * FROM account_products WHERE id = $1 FOR UPDATE', [productId]);
    const product = mapAccountProduct(pr.rows[0]);
    if (!product) throw new Error('Product not found');
    if (!product.active) throw new Error('This product is not available right now');
    const price = num(product.priceUsd);
    if (!(price > 0)) throw new Error('This product has an invalid price');
    const ur = await q('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = mapUser(ur.rows[0]);
    if (!user) throw new Error('User not found');
    const total = Math.round(price * qty * 10000) / 10000;
    if (num(user.balance) < total) throw new Error(`Insufficient balance — need $${total.toFixed(2)}`);
    const sr = await q(
      `SELECT id, credential FROM account_stock WHERE "productId" = $1 AND status = 'available' ORDER BY "createdAt" ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [productId, qty]
    );
    if (sr.rows.length < qty) throw new Error('Not enough stock available');
    const items = sr.rows.map(r => r.credential);
    const ids = sr.rows.map(r => r.id);
    const now = Date.now();
    await q('UPDATE users SET balance = ROUND((COALESCE(balance, 0) - $2)::numeric, 4) WHERE id = $1', [userId, total]);
    await q(`UPDATE account_stock SET status = 'sold', "soldToUserId" = $2, "soldAt" = $3 WHERE id = ANY($1)`, [ids, userId, now]);
    const order = { id: uid(), userId, productId, productName: product.name, qty, totalUsd: total, items, createdAt: now };
    await pgInsert(q, 'account_orders', ACCOUNT_ORDER_COLS, Object.assign({}, order, { items: JSON.stringify(items) }));
    await q('COMMIT');
    return { order, items };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ---- live chat (pg implementations) ----
async function pgCreateChatThread({ userId, guestName, guestToken }) {
  const now = Date.now();
  const t = {
    id: uid(), userId: userId || null, guestName: guestName || '',
    guestToken: guestToken || null, status: 'open', createdAt: now, updatedAt: now
  };
  await pgInsert((q, p) => pool.query(q, p), 'chat_threads', CHAT_THREAD_COLS, t);
  return t;
}
async function pgFindOpenChatThreadByUser(userId) {
  const r = await pool.query(
    `SELECT * FROM chat_threads WHERE "userId" = $1 AND status = 'open' ORDER BY "updatedAt" DESC, id DESC LIMIT 1`,
    [userId]
  );
  return mapChatThread(r.rows[0]);
}
async function pgUpdateChatThread(id, patch) {
  return pgUpdate('chat_threads', CHAT_THREAD_COLS, id, patch, mapChatThread);
}
async function pgAddChatMessage(threadId, sender, text) {
  const m = { id: uid(), threadId, sender, text, createdAt: Date.now() };
  await pgInsert((q, p) => pool.query(q, p), 'chat_messages', CHAT_MESSAGE_COLS, m);
  await pool.query('UPDATE chat_threads SET "updatedAt" = $2 WHERE id = $1', [threadId, m.createdAt]);
  return m;
}
async function pgListChatMessages(threadId) {
  const r = await pool.query(
    `SELECT * FROM chat_messages WHERE "threadId" = $1 ORDER BY "createdAt" ASC, id ASC`,
    [threadId]
  );
  return r.rows.map(mapChatMessage);
}
// Cheapest possible "did anything change?" probe: one row, one column.
// Used by the chat poll endpoint so idle polls stop pulling whole threads
// out of Postgres (Neon bills/counts every byte of that egress).
async function pgLatestChatMessageId(threadId) {
  const r = await pool.query(
    `SELECT id FROM chat_messages WHERE "threadId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
    [threadId]
  );
  return r.rows.length ? r.rows[0].id : null;
}
// Admin thread list: open first, newest first, with last-message preview + unread count
// (user messages after the last bot/agent/admin message).
async function pgListChatThreadsAdmin() {
  const r = await pool.query(
    `SELECT t.*, u.username AS "uUsername", u.name AS "uName",
      (SELECT m."text" FROM chat_messages m WHERE m."threadId" = t.id ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1) AS "lastText",
      (SELECT m.sender FROM chat_messages m WHERE m."threadId" = t.id ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1) AS "lastSender",
      (SELECT MAX(m."createdAt") FROM chat_messages m WHERE m."threadId" = t.id) AS "lastAt",
      (SELECT COUNT(*) FROM chat_messages m2 WHERE m2."threadId" = t.id AND m2.sender = 'user'
        AND m2."createdAt" > COALESCE(
          (SELECT MAX(m3."createdAt") FROM chat_messages m3 WHERE m3."threadId" = t.id AND m3.sender IN ('bot','agent','admin')),
          0)) AS unread
     FROM chat_threads t
     LEFT JOIN users u ON u.id = t."userId"
     ORDER BY (t.status = 'open') DESC, t."updatedAt" DESC, t.id DESC`
  );
  return r.rows.map(row => {
    const t = mapChatThread(row);
    delete t.guestToken; // never expose guest tokens in list views
    return Object.assign(t, {
      displayName: row.uUsername ? (row.uName || row.uUsername) : (row.guestName || 'Guest'),
      username: row.uUsername || null,
      lastText: row.lastText || '', lastSender: row.lastSender || null,
      lastAt: row.lastAt === null ? null : num(row.lastAt), unread: Number(row.unread) || 0
    });
  });
}
// Open threads whose latest message is from 'user' (nobody answered yet).
async function pgPendingChatThreads() {
  const r = await pool.query(
    `SELECT DISTINCT ON (t.id) t.*,
       m.sender AS "lastSender", m."text" AS "lastText", m."createdAt" AS "lastAt"
     FROM chat_threads t
     JOIN chat_messages m ON m."threadId" = t.id
     WHERE t.status = 'open'
     ORDER BY t.id, m."createdAt" DESC, m.id DESC`
  );
  return r.rows
    .filter(row => row.lastSender === 'user')
    .sort((a, b) => num(a.updatedAt) - num(b.updatedAt))
    .map(row => {
      const t = mapChatThread(row);
      delete t.guestToken; // never expose guest tokens in the pending queue
      return {
        thread: t,
        lastMessage: { sender: row.lastSender, text: row.lastText || '', createdAt: num(row.lastAt) }
      };
    });
}
async function pgListChatFaqs() {
  const r = await pool.query('SELECT * FROM chat_faqs ORDER BY "createdAt" ASC, id ASC');
  return r.rows.map(mapChatFaq);
}
async function pgCreateChatFaq({ keywords, answer, active }) {
  const f = { id: uid(), keywords, answer, active: active !== false, createdAt: Date.now() };
  await pgInsert((q, p) => pool.query(q, p), 'chat_faqs', CHAT_FAQ_COLS, f);
  return f;
}
async function pgUpdateChatFaq(id, patch) {
  return pgUpdate('chat_faqs', CHAT_FAQ_COLS, id, patch, mapChatFaq);
}
async function pgDeleteChatFaq(id) {
  await pool.query('DELETE FROM chat_faqs WHERE id = $1', [id]);
  return true;
}
async function pgChatFaqCount() {
  const r = await pool.query('SELECT COUNT(*) AS c FROM chat_faqs');
  return Number(r.rows[0].c);
}

// ---- startup ----
// Starter bot answers for the live-chat widget. Seeded once (only when the
// FAQ table is empty) so restarts never duplicate them. Admin can edit all of
// these in Admin → Live Chat.
const CHAT_FAQ_SEED = [
  {
    keywords: 'add fund,top up,topup,recharge,deposit,টাকা,বিকাশ,নগদ',
    answer: 'To add funds: tap Add Funds → choose bKash or Nagad → Send Money to 01324836536 → submit the TrxID and your sender number. Admin approves within a short time and your balance is credited in USD.'
  },
  {
    keywords: 'minimum,min,maximum,max,limit,মিনিমাম',
    answer: 'Minimum top-up is ৳625 ($5) and maximum is ৳50,000 per request.'
  },
  {
    keywords: 'buy number,buy otp,how to buy,number kinbo,নম্বর',
    answer: 'Go to Services → pick a service and country → Buy. You get a number instantly and the SMS code arrives automatically.'
  },
  {
    keywords: 'price,rate,cost,দাম,প্রাইস',
    answer: 'Each number costs the provider rate plus a flat $0.08 service fee. The exact price is shown before you buy.'
  },
  {
    keywords: 'number empty,no number,empty,স্টক',
    answer: "'Number empty' means that service has no numbers in stock right now. Please try again later."
  },
  {
    keywords: 'facebook account,account buy,premium account,অ্যাকাউন্ট',
    answer: 'Tap the Facebook plate → choose a product → select quantity → Buy. Login details are delivered instantly on screen and saved under My Accounts.'
  },
  {
    keywords: 'payment,bkash,nagad,pay,পেমেন্ট',
    answer: 'We accept bKash and Nagad via manual Send Money to 01324836536. Online/card payments are not available.'
  },
  {
    keywords: 'login,password,forgot,পাসওয়ার্ড,লগইন',
    answer: "If you forgot your password, use Profile → Change password after logging in. If you cannot log in at all, tell me your username here and I'll help."
  }
];
async function seedChatFaqs() {
  const count = pgMode ? await pgChatFaqCount() : mem().chatFaqs.length;
  if (count > 0) return;
  for (const f of CHAT_FAQ_SEED) {
    if (pgMode) await pgCreateChatFaq({ keywords: f.keywords, answer: f.answer, active: true });
    else mem().chatFaqs.push({ id: uid(), keywords: f.keywords, answer: f.answer, active: true, createdAt: Date.now() });
  }
  if (!pgMode) save(cache);
  console.log('[db] Seeded ' + CHAT_FAQ_SEED.length + ' chat FAQs');
}
async function ensureSeed() {
  const admin = await module.exports.findUserByName('admin');
  if (!admin) {
    const salt = crypto.randomBytes(8).toString('hex');
    await module.exports.addUser({
      id: uid(), username: 'admin', salt, hash: hashPw('admin123', salt),
      balance: 0, isAdmin: true, createdAt: Date.now()
    });
    console.log('Seed admin created -> username: admin / password: admin123 (change it after first login!)');
  }
  await seedChatFaqs();
}

async function init() {
  if (initDone) return;
  initDone = true;
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: url, ssl: pgSslFor(url), connectionTimeoutMillis: 10000 });
      await pool.query('SELECT 1');
      await createTables();
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'");
      pgMode = true;
      console.log('[db] PostgreSQL connected — using Postgres mode (data survives redeploys)');
    } catch (e) {
      console.warn('[db] WARNING: PostgreSQL unavailable (' + (e && e.message ? e.message : e) + ') — falling back to JSON file mode');
      if (pool) { try { await pool.end(); } catch (_) { /* ignore */ } pool = null; }
    }
  }
  if (!pgMode) {
    mem(); // ensure data/db.json exists
    console.log('[db] Using JSON file mode (data/db.json)');
  }
  await ensureSeed();
}

module.exports = {
  init,
  isPostgres,
  close: async () => { if (pool) { try { await pool.end(); } catch (_) {} pool = null; } },

  persist: async () => { if (!pgMode) save(mem()); }, // no-op in Postgres mode (writes are immediate)
  reload: async () => { cache = null; }, // re-read db.json from disk (JSON mode); nothing cached in pg mode

  getConfig: async () => pgMode ? pgGetConfig() : Object.assign({}, defaultConfig(), mem().config),
  setConfig: async (patch) => {
    if (pgMode) { await pgSetConfig(patch); return; }
    Object.assign(mem().config, patch); save(cache);
  },

  findUserById: async (id) => pgMode ? pgGetById('users', id, mapUser) : mem().users.find(u => u.id === id),
  findUserByName: async (name) => {
    if (pgMode) {
      const r = await pool.query('SELECT * FROM users WHERE username = $1', [name]);
      return mapUser(r.rows[0]);
    }
    return mem().users.find(u => u.username === name);
  },
  findUserByEmail: async (email) => {
    if (pgMode) {
      const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      return mapUser(r.rows[0]);
    }
    return mem().users.find(u => u.email && u.email.toLowerCase() === String(email).toLowerCase());
  },
  findUserByGoogleId: async (gid) => {
    if (pgMode) {
      const r = await pool.query('SELECT * FROM users WHERE "googleId" = $1', [gid]);
      return mapUser(r.rows[0]);
    }
    return mem().users.find(u => u.googleId === gid);
  },
  getUsers: async () => {
    if (pgMode) {
      const r = await pool.query('SELECT * FROM users ORDER BY "createdAt" ASC, id ASC');
      return r.rows.map(mapUser);
    }
    return mem().users;
  },
  updateUser: async (id, patch) => {
    if (pgMode) return pgUpdate('users', USER_COLS, id, patch, mapUser);
    const u = mem().users.find(x => x.id === id);
    if (u) Object.assign(u, patch);
    save(cache);
    return u;
  },
  addUser: async (u) => {
    u.status = u.status || 'active';
    if (pgMode) { await pgInsert((t, p) => pool.query(t, p), 'users', USER_COLS, u); return u; }
    mem().users.push(u); save(cache); return u;
  },
  setUserStatus: async (userId, status) => {
    if (pgMode) { await pool.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]); return; }
    const u = mem().users.find(x => x.id === userId);
    if (u) { u.status = status; save(cache); }
  },
  addBalance: async (userId, amount) => {
    if (pgMode) {
      // atomic + rounded to 4 decimals, exactly like the JSON behavior
      await pool.query(
        'UPDATE users SET balance = ROUND((COALESCE(balance, 0) + $2)::numeric, 4) WHERE id = $1',
        [userId, amount]
      );
      return;
    }
    const u = mem().users.find(x => x.id === userId);
    if (u) { u.balance = Math.round((u.balance + amount) * 10000) / 10000; save(cache); }
  },

  addOrder: async (o) => {
    if (pgMode) { await pgInsert((t, p) => pool.query(t, p), 'orders', ORDER_COLS, o); return o; }
    mem().orders.unshift(o); save(cache); return o;
  },
  getOrder: async (id) => pgMode ? pgGetById('orders', id, mapOrder) : mem().orders.find(o => o.id === id),
  updateOrder: async (id, patch) => {
    if (pgMode) return pgUpdate('orders', ORDER_COLS, id, patch, mapOrder);
    const o = mem().orders.find(x => x.id === id);
    if (o) Object.assign(o, patch);
    save(cache);
    return o;
  },
  userOrders: async (userId) => {
    if (pgMode) {
      const r = await pool.query(`SELECT * FROM orders WHERE "userId" = $1 ${NEWEST_FIRST}`, [userId]);
      return r.rows.map(mapOrder);
    }
    return mem().orders.filter(o => o.userId === userId);
  },

  addTopup: async (t) => {
    if (pgMode) { await pgInsert((t2, p) => pool.query(t2, p), 'topups', TOPUP_COLS, t); return t; }
    mem().topups.unshift(t); save(cache); return t;
  },
  getTopup: async (id) => pgMode ? pgGetById('topups', id, mapTopup) : mem().topups.find(t => t.id === id),
  getTopupByTrxid: async (tx) => {
    if (pgMode) {
      const r = await pool.query(
        `SELECT * FROM topups WHERE trxid = $1 AND (status <> 'rejected' OR status IS NULL) ${NEWEST_FIRST} LIMIT 1`, [tx]);
      return mapTopup(r.rows[0]);
    }
    return mem().topups.find(t => t.trxid === tx && t.status !== 'rejected');
  },
  updateTopup: async (id, patch) => {
    if (pgMode) return pgUpdate('topups', TOPUP_COLS, id, patch, mapTopup);
    const t = mem().topups.find(x => x.id === id);
    if (t) Object.assign(t, patch);
    save(cache);
    return t;
  },
  topupsByStatus: async (status) => {
    if (pgMode) {
      const r = await pool.query(`SELECT * FROM topups WHERE status = $1 ${NEWEST_FIRST}`, [status]);
      return r.rows.map(mapTopup);
    }
    return mem().topups.filter(t => t.status === status);
  },
  userTopups: async (userId) => {
    if (pgMode) {
      const r = await pool.query(`SELECT * FROM topups WHERE "userId" = $1 ${NEWEST_FIRST}`, [userId]);
      return r.rows.map(mapTopup);
    }
    return mem().topups.filter(t => t.userId === userId);
  },

  // ---- accounts shop ----
  createAccountProduct: async ({ name, description, priceUsd, logo }) => {
    const p = { id: uid(), name, description: description || '', priceUsd, logo: logo || '', active: true, createdAt: Date.now() };
    if (pgMode) { await pgInsert((t, prm) => pool.query(t, prm), 'account_products', ACCOUNT_PRODUCT_COLS, p); return p; }
    mem().accountProducts.push(p); save(cache); return p;
  },
  getAccountProduct: async (id) => pgMode ? pgGetById('account_products', id, mapAccountProduct) : mem().accountProducts.find(p => p.id === id),
  listAccountProductsAdmin: async () => {
    if (pgMode) {
      const r = await pool.query('SELECT * FROM account_products ORDER BY "createdAt" DESC, id DESC');
      return withCounts(r.rows.map(mapAccountProduct), await pgProductStockCounts());
    }
    const d = mem();
    const counts = {};
    for (const s of d.accountStock) {
      const c = counts[s.productId] || (counts[s.productId] = { available: 0, sold: 0 });
      if (s.status === 'sold') c.sold++; else c.available++;
    }
    return withCounts(d.accountProducts.slice().sort((a, b) => b.createdAt - a.createdAt), counts);
  },
  listAccountProductsPublic: async () => {
    // active products only, with stock counts — credentials NEVER leave the server here
    const all = await module.exports.listAccountProductsAdmin();
    return all.filter(p => p.active).map(p => ({
      id: p.id, name: p.name, description: p.description,
      priceUsd: p.priceUsd, logo: p.logo,
      available: p.available, sold: p.sold
    }));
  },
  updateAccountProduct: async (id, patch) => {
    if (pgMode) return pgUpdate('account_products', ACCOUNT_PRODUCT_COLS, id, patch, mapAccountProduct);
    const p = mem().accountProducts.find(x => x.id === id);
    if (p) {
      for (const k of ['name', 'description', 'priceUsd', 'logo', 'active']) if (patch[k] !== undefined) p[k] = patch[k];
    }
    save(cache);
    return p;
  },
  deleteAccountProduct: async (id) => {
    if (pgMode) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM account_stock WHERE "productId" = $1', [id]);
        await client.query('DELETE FROM account_products WHERE id = $1', [id]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      return true;
    }
    const d = mem();
    d.accountProducts = d.accountProducts.filter(x => x.id !== id);
    d.accountStock = d.accountStock.filter(s => s.productId !== id);
    save(cache);
    return true;
  },
  addAccountStock: async (productId, lines) => {
    if (pgMode) return pgAddAccountStock(productId, lines);
    const d = mem();
    const now = Date.now();
    for (const line of lines) {
      d.accountStock.push({ id: uid(), productId, credential: line, status: 'available', soldToUserId: null, soldAt: null, createdAt: now });
    }
    save(cache);
    return lines.length;
  },
  buyAccountStock: async (productId, userId, qty) => {
    qty = Math.floor(Number(qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new Error('Quantity must be 1-100');
    if (pgMode) return pgBuyAccountStock(productId, userId, qty);
    // JSON mode: single synchronous pass, one save — effectively atomic
    const d = mem();
    const product = d.accountProducts.find(p => p.id === productId);
    if (!product) throw new Error('Product not found');
    if (!product.active) throw new Error('This product is not available right now');
    const price = Number(product.priceUsd);
    if (!(price > 0)) throw new Error('This product has an invalid price');
    const user = d.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    const total = Math.round(price * qty * 10000) / 10000;
    if ((user.balance || 0) < total) throw new Error(`Insufficient balance — need $${total.toFixed(2)}`);
    const rows = d.accountStock.filter(s => s.productId === productId && s.status === 'available').slice(0, qty);
    if (rows.length < qty) throw new Error('Not enough stock available');
    const now = Date.now();
    const items = rows.map(r => r.credential);
    user.balance = Math.round(((user.balance || 0) - total) * 10000) / 10000;
    for (const r of rows) { r.status = 'sold'; r.soldToUserId = userId; r.soldAt = now; }
    const order = { id: uid(), userId, productId, productName: product.name, qty, totalUsd: total, items, createdAt: now };
    d.accountOrders.unshift(order);
    save(cache);
    return { order, items };
  },
  myAccountOrders: async (userId) => {
    if (pgMode) {
      const r = await pool.query(`SELECT * FROM account_orders WHERE "userId" = $1 ${NEWEST_FIRST}`, [userId]);
      return r.rows.map(mapAccountOrder);
    }
    return mem().accountOrders.filter(o => o.userId === userId);
  },

  // ---- complaints / replacement box ----
  createComplaint: async (c) => {
    if (pgMode) return pgCreateComplaint(c);
    const d = mem(); if (!d.complaints) d.complaints = [];
    d.complaints.unshift(c); save(cache); return c;
  },
  myComplaints: async (userId) => {
    if (pgMode) return pgMyComplaints(userId);
    return (mem().complaints || []).filter(c => c.userId === userId);
  },
  adminComplaints: async (status) => {
    if (pgMode) return pgAdminComplaints(status);
    const all = (mem().complaints || []).slice(0, 100);
    return status === 'pending' ? all.filter(c => c.status === 'pending') : all;
  },
  getComplaint: async (id) => {
    if (pgMode) return pgGetComplaint(id);
    return (mem().complaints || []).find(c => c.id === id);
  },
  decideComplaint: async (id, status, note) => {
    if (pgMode) return pgDecideComplaint(id, status, note);
    const d = mem(); if (!d.complaints) d.complaints = [];
    const c = d.complaints.find(x => x.id === id);
    if (!c) throw new Error('Complaint not found');
    if (c.status !== 'pending') throw new Error('This complaint was already handled');
    c.status = status; c.adminNote = note || ''; c.updatedAt = Date.now();
    save(cache); return c;
  },
  replaceComplaint: async (id) => {
    if (pgMode) return pgReplaceComplaint(id);
    const d = mem(); if (!d.complaints) d.complaints = [];
    const c = d.complaints.find(x => x.id === id);
    if (!c) throw new Error('Complaint not found');
    if (c.status !== 'pending') throw new Error('This complaint was already handled');
    if (c.kind !== 'account' || !c.productId) throw new Error('Replacement is only available for account purchases');
    const row = d.accountStock
      .filter(s => s.productId === c.productId && s.status === 'available')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!row) throw new Error('No stock left for this product — add stock first, or reject/resolve instead');
    const now = Date.now();
    row.status = 'sold'; row.soldToUserId = c.userId; row.soldAt = now;
    d.accountOrders.unshift({
      id: uid(), userId: c.userId, productId: c.productId,
      productName: (c.productName || 'Account') + ' (Replacement)', qty: 1, totalUsd: 0,
      items: [row.credential], createdAt: now
    });
    c.status = 'replaced'; c.replacement = row.credential; c.updatedAt = now;
    save(cache); return c;
  },

  // ---- live chat ----
  createChatThread: async ({ userId, guestName, guestToken }) => {
    if (pgMode) return pgCreateChatThread({ userId, guestName, guestToken });
    const now = Date.now();
    const t = {
      id: uid(), userId: userId || null, guestName: guestName || '',
      guestToken: guestToken || null, status: 'open', createdAt: now, updatedAt: now
    };
    mem().chatThreads.push(t); save(cache); return t;
  },
  getChatThread: async (id) => pgMode
    ? pgGetById('chat_threads', id, mapChatThread)
    : mem().chatThreads.find(t => t.id === id),
  findOpenChatThreadByUser: async (userId) => {
    if (pgMode) return pgFindOpenChatThreadByUser(userId);
    return mem().chatThreads
      .filter(t => t.userId === userId && t.status === 'open')
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))[0];
  },
  updateChatThread: async (id, patch) => {
    if (pgMode) return pgUpdateChatThread(id, patch);
    const t = mem().chatThreads.find(x => x.id === id);
    if (t) {
      for (const k of ['status']) if (patch[k] !== undefined) t[k] = patch[k];
      t.updatedAt = Date.now();
    }
    save(cache);
    return t;
  },
  addChatMessage: async (threadId, sender, text) => {
    if (pgMode) return pgAddChatMessage(threadId, sender, text);
    const now = Date.now();
    const m = { id: uid(), threadId, sender, text, createdAt: now };
    mem().chatMessages.push(m);
    const t = mem().chatThreads.find(x => x.id === threadId);
    if (t) t.updatedAt = now;
    save(cache);
    return m;
  },
  listChatMessages: async (threadId) => {
    if (pgMode) return pgListChatMessages(threadId);
    return mem().chatMessages
      .filter(m => m.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  },
  latestChatMessageId: async (threadId) => {
    if (pgMode) return pgLatestChatMessageId(threadId);
    const list = mem().chatMessages
      .filter(m => m.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    return list.length ? list[list.length - 1].id : null;
  },
  // Admin: open first, newest first; last-message preview + unread count.
  // Never includes guestToken or emails.
  listChatThreadsAdmin: async () => {
    if (pgMode) return pgListChatThreadsAdmin();
    const d = mem();
    const byThread = {};
    for (const m of d.chatMessages) (byThread[m.threadId] = byThread[m.threadId] || []).push(m);
    const usersById = {};
    for (const u of d.users) usersById[u.id] = u;
    const out = d.chatThreads.map(t => {
      const msgs = (byThread[t.id] || []).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      const last = msgs[msgs.length - 1];
      let lastStaffAt = 0;
      for (const m of msgs) if (m.sender !== 'user' && m.createdAt > lastStaffAt) lastStaffAt = m.createdAt;
      const unread = msgs.filter(m => m.sender === 'user' && m.createdAt > lastStaffAt).length;
      const u = t.userId ? usersById[t.userId] : null;
      return {
        id: t.id, userId: t.userId, status: t.status,
        displayName: u ? (u.name || u.username) : (t.guestName || 'Guest'),
        username: u ? u.username : null,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
        lastText: last ? last.text : '', lastSender: last ? last.sender : null,
        lastAt: last ? last.createdAt : null, unread
      };
    });
    out.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
      || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    return out;
  },
  pendingChatThreads: async () => {
    if (pgMode) return pgPendingChatThreads();
    const d = mem();
    const out = [];
    for (const t of d.chatThreads.filter(x => x.status === 'open')) {
      const msgs = d.chatMessages
        .filter(m => m.threadId === t.id)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      const last = msgs[msgs.length - 1];
      if (last && last.sender === 'user') {
        out.push({
          thread: {
            id: t.id, userId: t.userId, guestName: t.guestName,
            status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt
          },
          lastMessage: { sender: last.sender, text: last.text, createdAt: last.createdAt }
        });
      }
    }
    out.sort((a, b) => a.thread.updatedAt - b.thread.updatedAt);
    return out;
  },
  listChatFaqs: async () => {
    if (pgMode) return pgListChatFaqs();
    return mem().chatFaqs.slice().sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  },
  createChatFaq: async ({ keywords, answer, active }) => {
    if (pgMode) return pgCreateChatFaq({ keywords, answer, active });
    const f = { id: uid(), keywords, answer, active: active !== false, createdAt: Date.now() };
    mem().chatFaqs.push(f); save(cache); return f;
  },
  updateChatFaq: async (id, patch) => {
    if (pgMode) return pgUpdateChatFaq(id, patch);
    const f = mem().chatFaqs.find(x => x.id === id);
    if (f) {
      for (const k of ['keywords', 'answer', 'active']) if (patch[k] !== undefined) f[k] = patch[k];
    }
    save(cache);
    return f;
  },

  // ---- bonuses ----
  addBonus: async ({ userId, amount, kind, label }) => {
    if (pgMode) return pgAddBonus({ userId, amount, kind, label });
    const b = { id: uid(), userId, amount, kind: kind || '', label: label || '', createdAt: Date.now() };
    const m = mem(); m.bonuses = m.bonuses || []; m.bonuses.push(b); save(cache); return b;
  },
  userBonuses: async (userId) => {
    if (pgMode) return pgUserBonuses(userId);
    return (mem().bonuses || []).filter(b => b.userId === userId).slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  hasWelcomeBonus: async (userId) => {
    if (pgMode) { const r = await pool.query('SELECT 1 FROM bonuses WHERE "userId" = $1 AND kind = $2 LIMIT 1', [userId, 'welcome']); return r.rows.length > 0; }
    return (mem().bonuses || []).some(b => b.userId === userId && b.kind === 'welcome');
  },
  deleteChatFaq: async (id) => {
    if (pgMode) return pgDeleteChatFaq(id);
    const d = mem();
    d.chatFaqs = d.chatFaqs.filter(x => x.id !== id);
    save(cache);
    return true;
  },

  stats: async () => {
    if (pgMode) return pgStats();
    const d = mem();
    return {
      users: d.users.length,
      orders: d.orders.length,
      revenue: d.orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.priceUsd || 0), 0),
      totalReceived: d.topups.filter(t => t.status === 'approved').reduce((s, t) => s + (Number(t.amount) || 0), 0),
      pendingTopups: d.topups.filter(t => t.status === 'pending' || t.status === 'awaiting').length
    };
  },

  // ---- backup / restore ----
  exportJson: async () => {
    if (pgMode) return pgExport();
    const d = mem();
    return JSON.parse(JSON.stringify({
      users: d.users, orders: d.orders, topups: d.topups, config: d.config,
      accountProducts: d.accountProducts || [], accountStock: d.accountStock || [], accountOrders: d.accountOrders || [],
      chatThreads: d.chatThreads || [], chatMessages: d.chatMessages || [], chatFaqs: d.chatFaqs || [],
      bonuses: d.bonuses || []
    }));
  },
  importJson: async (data) => {
    validateBackup(data);
    if (pgMode) { await pgImport(data); return; }
    cache = {
      users: data.users, orders: data.orders, topups: data.topups, config: data.config,
      accountProducts: data.accountProducts, accountStock: data.accountStock, accountOrders: data.accountOrders,
      chatThreads: data.chatThreads, chatMessages: data.chatMessages, chatFaqs: data.chatFaqs,
      bonuses: data.bonuses || []
    };
    save(cache);
  },

  // ---- sessions ----
  sessionCreate: async (token, userId) => {
    if (pgMode) {
      await pool.query(
        'INSERT INTO sessions (token, "userId", "createdAt") VALUES ($1, $2, $3) ' +
        'ON CONFLICT (token) DO UPDATE SET "userId" = EXCLUDED."userId", "createdAt" = EXCLUDED."createdAt"',
        [token, userId, Date.now()]
      );
      return;
    }
    jsonSessions.set(token, userId);
  },
  sessionGet: async (token) => {
    if (pgMode) {
      const r = await pool.query('SELECT "userId" FROM sessions WHERE token = $1', [token]);
      return r.rows[0] ? r.rows[0].userId : null;
    }
    const v = jsonSessions.get(token);
    return v === undefined ? null : v;
  },
  sessionDelete: async (token) => {
    if (pgMode) { await pool.query('DELETE FROM sessions WHERE token = $1', [token]); return; }
    jsonSessions.delete(token);
  }
};
