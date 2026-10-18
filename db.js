// Simple JSON-file database (MVP).
// বড় হলে PostgreSQL/MySQL দিয়ে বদলে নিও — সব access এই ফাইলের ফাংশন দিয়ে হয়।
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function defaultDb() {
  return {
    users: [],   // {id, name, username, email, phone, salt, hash, googleId, balance, isAdmin, createdAt}
    orders: [],  // {id, userId, service, serviceName, country, countryName, number, priceBdt, providerId, status, code, createdAt}
    topups: [],  // {id, userId, username, amount, method, trxid, status, createdAt}
    config: {
      provider: 'mock', markupPercent: 40, siteName: 'OTPStation',
      // Manual bKash/Nagad top-ups — admin's personal numbers + BDT→USD rate
      bkashNumber: '', nagadNumber: '', bdtRate: 125,
      // Google OAuth ("Continue with Google") — set in Admin → Settings
      googleClientId: '', googleClientSecret: '', baseUrl: ''
    }
  };
}

function save(d) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
}

function load() {
  try {
    if (!fs.existsSync(DB_FILE)) { const d = defaultDb(); save(d); return d; }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    const d = defaultDb(); save(d); return d;
  }
}

let cache = null;
function db() { if (!cache) cache = load(); return cache; }

module.exports = {
  persist() { save(cache); },
  reload() { cache = null; }, // re-read db.json from disk (used after restore)
  getConfig: () => Object.assign({}, defaultDb().config, db().config),
  setConfig: (patch) => { Object.assign(db().config, patch); save(cache); },
  findUserById: (id) => db().users.find(u => u.id === id),
  findUserByName: (name) => db().users.find(u => u.username === name),
  findUserByEmail: (email) => db().users.find(u => u.email && u.email.toLowerCase() === String(email).toLowerCase()),
  findUserByGoogleId: (gid) => db().users.find(u => u.googleId === gid),
  getUsers: () => db().users,
  updateUser: (id, patch) => { const u = db().users.find(x => x.id === id); if (u) Object.assign(u, patch); save(cache); return u; },
  addUser: (u) => { db().users.push(u); save(cache); return u; },
  addBalance: (userId, amount) => { const u = db().users.find(x => x.id === userId); if (u) { u.balance = Math.round((u.balance + amount) * 10000) / 10000; save(cache); } },
  addOrder: (o) => { db().orders.unshift(o); save(cache); return o; },
  getOrder: (id) => db().orders.find(o => o.id === id),
  updateOrder: (id, patch) => { const o = db().orders.find(x => x.id === id); if (o) Object.assign(o, patch); save(cache); return o; },
  userOrders: (userId) => db().orders.filter(o => o.userId === userId),
  addTopup: (t) => { db().topups.unshift(t); save(cache); return t; },
  getTopup: (id) => db().topups.find(t => t.id === id),
  getTopupByTrxid: (tx) => db().topups.find(t => t.trxid === tx && t.status !== 'rejected'),
  updateTopup: (id, patch) => { const t = db().topups.find(x => x.id === id); if (t) Object.assign(t, patch); save(cache); return t; },
  topupsByStatus: (status) => db().topups.filter(t => t.status === status),
  userTopups: (userId) => db().topups.filter(t => t.userId === userId),
  stats: () => {
    const d = db();
    return {
      users: d.users.length,
      orders: d.orders.length,
      revenue: d.orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.priceUsd || 0), 0),
      totalReceived: d.topups.filter(t => t.status === 'approved').reduce((s, t) => s + (Number(t.amount) || 0), 0),
      pendingTopups: d.topups.filter(t => t.status === 'pending' || t.status === 'awaiting').length
    };
  }
};
