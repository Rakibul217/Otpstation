const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
};
const fmtUSD = (v) => {
  const n = Number(v);
  return '$' + (n < 1 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0') : n.toFixed(2));
};

let me = null;
let authMode = 'login';

// ---------- auth ----------
async function refreshMe() {
  const { user, siteName } = await api('GET', '/api/me');
  me = user;
  $('siteName').textContent = siteName || 'OTPStation';
  document.title = siteName || 'OTPStation';
  if (me) {
    $('authArea').innerHTML = `<button class="link" id="logoutBtn">Log out</button>`;
    $('logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };
    $('profileBar').classList.remove('hidden');
    $('pUsername').textContent = me.username;
    $('pBalance').textContent = Number(me.balance).toFixed(2);
    $('adminPlate').classList.toggle('hidden', !me.isAdmin);
    $('profilePlate').classList.remove('hidden');
    $('plates').classList.remove('hidden');
  } else {
    $('authArea').innerHTML = `<button class="link" id="loginBtn">Log in / Register</button>`;
    $('loginBtn').onclick = () => { $('authModal').classList.remove('hidden'); };
    $('profileBar').classList.add('hidden');
    $('adminPlate').classList.add('hidden');
    $('profilePlate').classList.add('hidden');
    $('plates').classList.add('hidden');
  }
}
$('aClose').onclick = () => $('authModal').classList.add('hidden');
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('authTitle').textContent = reg ? 'Create account' : 'Log in';
  $('aName').classList.toggle('hidden', !reg);
  $('aContact').classList.toggle('hidden', !reg);
  $('aUser').placeholder = reg ? 'Username' : 'Username or email';
  $('aSwitch').textContent = reg ? 'Log in' : 'Create a new account';
  $('aGo').textContent = reg ? 'Register' : 'Log in';
  $('aMsg').textContent = '';
}
$('aSwitch').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('aGo').onclick = async () => {
  try {
    if (authMode === 'login') {
      await api('POST', '/api/login', { username: $('aUser').value.trim(), password: $('aPass').value });
    } else {
      await api('POST', '/api/register', {
        name: $('aName').value.trim(), username: $('aUser').value.trim(),
        contact: $('aContact').value.trim(), password: $('aPass').value
      });
    }
    location.reload();
  } catch (e) { showMsg('aMsg', e.message, 'err'); }
};
$('googleBtn').onclick = () => { location.href = '/api/auth/google'; };
// show "Continue with Google" only when the admin configured it
api('GET', '/api/auth/providers').then(p => {
  if (p.google) $('googleBox').classList.remove('hidden');
}).catch(() => {});

// ---------- plates (navigation) ----------
function goHome() {
  const svc = document.querySelector('#plates [data-tab="services"]');
  if (svc) svc.click();
  else { document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden')); $('tab-services').classList.remove('hidden'); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('#plates .plate').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#plates .plate').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden'));
    $('tab-' + b.dataset.tab).classList.remove('hidden');
    if (b.dataset.tab === 'numbers') loadOrders();
    if (b.dataset.tab === 'topup') { loadPayInfo(); loadMyTopups(); }
    if (b.dataset.tab === 'profile') loadProfile();
    if (b.dataset.tab === 'admin') loadAdmin();
    if (b.dataset.tab === 'services') document.getElementById('servicesHead').scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };
});

// ---------- services ----------
async function loadServices() {
  try {
    const { services } = await api('GET', '/api/services');
    $('serviceGrid').innerHTML = services.map(s => `
      <div class="svc" onclick="openService('${s.code}','${s.name}')">
        <span class="logo-chip" style="background:${s.color}"><img class="logo-img" src="logos/${s.logo}.svg" alt="${s.name}"></span>${s.name}<span class="pr">from ${fmtUSD(s.fromPrice)}</span>
      </div>`).join('');
  } catch (e) { $('serviceGrid').innerHTML = `<div class="card">${e.message}</div>`; }
}
async function openService(code, name) {
  $('serviceGrid').classList.add('hidden');
  $('countryBox').classList.remove('hidden');
  $('countryTitle').textContent = name + ' — choose country';
  const { countries } = await api('GET', '/api/countries?service=' + code);
  $('countryList').innerHTML = countries.map(c => `
    <div class="country">
      <div><div class="nm">${c.flag} ${c.name}</div><div class="ct">${Number(c.count).toLocaleString()} numbers</div></div>
      <button class="buy" onclick="buyNumber('${code}','${c.code}','${fmtUSD(c.priceUsd)}')">${fmtUSD(c.priceUsd)}</button>
    </div>`).join('');
}
$('backBtn').onclick = () => { $('countryBox').classList.add('hidden'); $('serviceGrid').classList.remove('hidden'); };

async function buyNumber(service, country, priceLabel) {
  if (!me) { $('authModal').classList.remove('hidden'); return; }
  if (!confirm(`Buy a number for ${priceLabel}?`)) return;
  try {
    const { order } = await api('POST', '/api/orders', { service, country });
    alert('Your number: ' + order.number);
    await refreshMe();
    document.querySelector('[data-tab="numbers"]').click();
  } catch (e) { alert(e.message); }
}

// ---------- orders ----------
let pollTimer = null;
async function loadOrders() {
  if (!me) { $('orderList').innerHTML = '<div class="card">Log in to see your numbers.</div>'; return; }
  const { orders } = await api('GET', '/api/orders');
  if (!orders.length) { $('orderList').innerHTML = '<div class="card">No numbers purchased yet.</div>'; return; }
  $('orderList').innerHTML = orders.map(o => `
    <div class="order" id="ord-${o.id}">
      <div><b>${o.serviceName}</b> · ${o.countryName} <span class="badge ${o.status}">${statusEn(o.status)}</span></div>
      <div class="num">📞 ${o.number}</div>
      ${o.status === 'done' ? `<div class="code">${o.code}</div><button class="btn green" onclick="copyCode('${o.code}')">Copy code</button>` : ''}
      ${o.status === 'waiting' ? `<div class="wait">⏳ Waiting for SMS… (checking automatically)</div><button class="link" onclick="cancelOrder('${o.id}')">Cancel and refund</button>` : ''}
      <div class="row"><span>${fmtUSD(o.priceUsd)}</span><span>${new Date(o.createdAt).toLocaleString('en-US')}</span></div>
    </div>`).join('');
  clearInterval(pollTimer);
  const waiting = orders.filter(o => o.status === 'waiting');
  if (waiting.length) {
    pollTimer = setInterval(async () => {
      let anyLeft = false;
      for (const o of waiting) {
        try {
          const { order } = await api('GET', '/api/orders/' + o.id);
          if (order.status === 'done') { loadOrders(); return; }
          if (order.status === 'waiting') anyLeft = true;
        } catch (e) {}
      }
      if (!anyLeft) { clearInterval(pollTimer); loadOrders(); }
    }, 5000);
  }
}
function statusEn(s) { return { waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' }[s] || s; }
function copyCode(c) { navigator.clipboard.writeText(c); alert('Copied: ' + c); }
async function cancelOrder(id) {
  if (!confirm('Cancel this order and get a refund?')) return;
  await api('POST', '/api/orders/' + id + '/cancel');
  await refreshMe(); loadOrders();
}

// ---------- topup (manual bKash / Nagad) ----------
let payMethods = [], payRate = 120, payMin = 100, payMax = 50000, payMethod = null;
const PAY_BRAND = {
  bkash: { grad: 'linear-gradient(135deg,#E2136E 0%,#a80c4e 100%)', glow: 'rgba(226,19,110,.45)', logo: 'logos/bkash.png' },
  nagad: { grad: 'linear-gradient(135deg,#F6921E 0%,#cf6a05 100%)', glow: 'rgba(246,146,30,.45)', logo: 'logos/nagad.png' }
};
const payBrand = (id) => PAY_BRAND[id] || { grad: 'linear-gradient(135deg,#4f7cff,#a04fff)', glow: 'rgba(100,110,255,.45)', logo: '' };
const selMethod = () => payMethods.find(x => x.id === payMethod) || payMethods[0];
function renderMethodCards() {
  if (!payMethod && payMethods.length) payMethod = payMethods[0].id;
  $('tMethodCards').innerHTML = payMethods.map(m => {
    const b = payBrand(m.id);
    const logo = b.logo ? `<span class="mc-logo"><img src="${b.logo}" alt="${esc(m.name)}"></span>` : '';
    return `<button type="button" class="method-card${m.id === payMethod ? ' selected' : ''}" data-m="${m.id}" style="--mgrad:${b.grad};--mglow:${b.glow}">
      ${logo}<span class="mc-text"><span class="mc-name">${esc(m.name)}</span><span class="mc-num">${esc(m.number)}</span></span>
      <span class="mc-check">✓</span></button>`;
  }).join('');
  document.querySelectorAll('.method-card').forEach(c => c.onclick = () => {
    payMethod = c.dataset.m; renderMethodCards(); updateRateInfo();
  });
}
async function loadPayInfo() {
  try {
    const info = await api('GET', '/api/payinfo');
    payMethods = info.methods || []; payRate = info.bdtRate || 120;
    payMin = info.minBdt || 100; payMax = info.maxBdt || 50000;
    if (!payMethods.length) {
      $('payInfo').innerHTML = `<div class="warn">⚠️ Payments are not configured yet. Please try again later.</div>`;
      $('topupForm').classList.add('hidden');
      return;
    }
    renderMethodCards();
    $('tAmountBdt').min = payMin;
    $('tAmountBdt').placeholder = `e.g. ${payMin} (min $${info.minUsd || 5})`;
    updateRateInfo();
    $('payInfo').innerHTML = `<div class="pay-ok">✅ ${payMethods.map(m => m.name).join(' / ')} accepted — send money, then submit the TrxID below.</div>`;
    $('topupForm').classList.remove('hidden');
  } catch (e) { $('payInfo').innerHTML = ''; }
}
function updateRateInfo() {
  const m = selMethod();
  const bdt = Math.round(Number($('tAmountBdt').value) || 0);
  const usd = bdt ? (bdt / payRate).toFixed(2) : '0.00';
  const b = payBrand(m ? m.id : '');
  $('tRateInfo').innerHTML = m
    ? `<div class="rate-card" style="--mgrad:${b.grad};--mglow:${b.glow}">
        <div class="rc-top">Send <b>৳${bdt || '—'}</b> via <b>${esc(m.name)}</b> Send Money to</div>
        <div class="rc-num"><span class="mono">${esc(m.number)}</span><button class="rc-copy" onclick="copyPayNumber()">⧉ Copy</button></div>
        <div class="rc-bot">You will get <b>$${usd}</b> balance <span class="rc-rate">(rate ৳${payRate} = $1)</span></div>
      </div>`
    : '';
}
function copyPayNumber() {
  const m = selMethod();
  if (m) { navigator.clipboard.writeText(m.number); alert('Number copied'); }
}
$('tAmountBdt').oninput = updateRateInfo;
$('tSubmit').onclick = async () => {
  try {
    const { topup } = await api('POST', '/api/topups', {
      method: payMethod,
      amountBdt: $('tAmountBdt').value,
      senderNumber: $('tSender').value.trim(),
      trxid: $('tTrxid').value.trim()
    });
    showMsg('tMsg', `Submitted! ৳${topup.amountBdt} via ${topup.method} — $${Number(topup.amount).toFixed(2)} will be credited after review.`, 'ok');
    $('tAmountBdt').value = ''; $('tSender').value = ''; $('tTrxid').value = '';
    updateRateInfo(); loadMyTopups();
  } catch (e) { showMsg('tMsg', e.message, 'err'); }
};
function topupStatusEn(s) { return { pending: 'In review', approved: 'Approved', rejected: 'Rejected', awaiting: 'Awaiting payment' }[s] || s; }
async function loadMyTopups() {
  if (!me) return;
  const { topups } = await api('GET', '/api/topups/mine');
  $('myTopups').innerHTML = topups.length ? topups.map(t => `
    <div class="topup-row"><span><b>${esc(t.method || 'Top-up')}</b> · ৳${t.amountBdt || ''} → $${Number(t.amount).toFixed(2)}<br><span class="mono">TrxID: ${esc(t.trxid || t.txid || '')}</span></span><span class="badge ${t.status}">${topupStatusEn(t.status)}</span></div>`).join('')
    : '<div class="card">No top-ups yet.</div>';
}

// ---------- profile ----------
async function loadProfile() {
  if (!me) return;
  try {
    const { user } = await api('GET', '/api/me');
    $('pName').value = user.name || '';
    $('pUser').value = user.username || '';
    $('pContact').value = user.email || user.phone || '';
    $('pJoined').textContent = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—';
    $('pwCurrentBox').classList.toggle('hidden', !user.hasPassword);
    showMsg('pMsg', '', ''); showMsg('pwMsg', '', '');
  } catch (e) { showMsg('pMsg', e.message, 'err'); }
  try {
    const { history } = await api('GET', '/api/history');
    $('histList').innerHTML = history.length ? history.map(h => {
      const cls = h.kind === 'credit' ? 'pos' : h.kind === 'debit' ? 'neg' : '';
      const sign = h.kind === 'credit' ? '+' : h.kind === 'debit' ? '−' : '';
      return `<div class="hist-row"><span>${esc(h.label)}<br><span class="muted">${new Date(h.at).toLocaleString()}</span></span><b class="${cls}">${sign}$${Math.abs(h.amount).toFixed(2)}</b></div>`;
    }).join('')
      : 'No transactions yet.';
  } catch (e) { $('histList').innerHTML = 'Could not load history.'; }
}
$('pSave').onclick = async () => {
  try {
    const { user } = await api('PUT', '/api/profile', { name: $('pName').value.trim(), contact: $('pContact').value.trim() });
    me = user; refreshMe();
    showMsg('pMsg', 'Profile saved ✓', 'ok');
  } catch (e) { showMsg('pMsg', e.message, 'err'); }
};
$('pwSave').onclick = async () => {
  if ($('pwNew').value !== $('pwNew2').value) { showMsg('pwMsg', 'New passwords do not match', 'err'); return; }
  try {
    await api('POST', '/api/password', { currentPassword: $('pwCur').value, newPassword: $('pwNew').value });
    $('pwCur').value = $('pwNew').value = $('pwNew2').value = '';
    showMsg('pwMsg', 'Password changed ✓', 'ok');
  } catch (e) { showMsg('pwMsg', e.message, 'err'); }
};

// ---------- admin ----------
// Admin dashboard uses plates like the user panel. Nothing loads until a plate is clicked.
const adminLoaded = {};
async function loadAdmin() {
  if (!me || !me.isAdmin) return;
  document.querySelectorAll('.apanel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('#adminPlates .plate').forEach(x => x.classList.remove('active'));
  for (const k in adminLoaded) delete adminLoaded[k];
}
document.querySelectorAll('#adminPlates .plate').forEach(b => {
  b.onclick = () => toggleAdminPanel(b.dataset.apanel);
});
async function toggleAdminPanel(name) {
  const panel = $('apanel-' + name);
  if (!panel) return;
  const willShow = panel.classList.contains('hidden');
  document.querySelectorAll('.apanel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('#adminPlates .plate').forEach(x => x.classList.remove('active'));
  if (!willShow) return;
  panel.classList.remove('hidden');
  const btn = document.querySelector('#adminPlates .plate[data-apanel="' + name + '"]');
  if (btn) btn.classList.add('active');
  // payment queues always refresh; the rest load once per visit
  if (name === 'awaiting' || name === 'review' || !adminLoaded[name]) {
    adminLoaded[name] = true;
    await loadAdminPanel(name);
  }
}
async function loadAdminPanel(name) {
  if (name === 'stats') {
  const { users, orders, revenue, totalReceived, pendingTopups } = await api('GET', '/api/admin/stats');
  $('adminStats').innerHTML = `👥 Users: <b>${users}</b> · 🛒 Orders: <b>${orders}</b> · 💵 Revenue: <b>${fmtUSD(revenue)}</b> · 💰 Received: <b>${fmtUSD(totalReceived || 0)}</b> · ⏳ Pending: <b>${pendingTopups}</b>`;
  }
  if (name === 'awaiting') {
  const awaiting = await api('GET', '/api/admin/topups?status=awaiting');
  $('adminAwaiting').innerHTML = awaiting.topups.length ? awaiting.topups.map(t => `
    <div class="topup-row"><span><b>${t.username}</b> · $${Number(t.amount).toFixed(2)}<br><span class="mono">${esc(t.trxid || t.txid || '')}</span></span></div>`).join('')
    : 'None.';
  }
  if (name === 'review') {
  const { topups } = await api('GET', '/api/admin/topups?status=pending');
  $('adminTopups').innerHTML = topups.length ? topups.map(t => `
    <div class="topup-row"><span><b>${t.username}</b> · <b>${esc(t.method || '')}</b> · ৳${t.amountBdt || ''} → $${Number(t.amount).toFixed(2)}<br><span class="muted">From:</span> <span class="mono">${esc(t.senderNumber || '')}</span> · <span class="muted">TrxID:</span> <span class="mono">${esc(t.trxid || t.txid || '')}</span></span>
    <span><button class="appr" onclick="decideTopup('${t.id}','approve')">✓</button><button class="rej" onclick="decideTopup('${t.id}','reject')">✕</button></span></div>`).join('')
    : 'Nothing to review.';
  }
  if (name === 'settings') {
  const { config } = await api('GET', '/api/admin/config');
  $('cMarkup').value = config.markupPercent;
  $('cProvider').value = config.provider; $('cSite').value = config.siteName;
  $('cBkash').value = config.bkashNumber || '';
  $('cNagad').value = config.nagadNumber || '';
  $('cRate').value = config.bdtRate || 120;
  $('cGoogleId').value = config.googleClientId || '';
  $('cGoogleSecret').value = config.googleClientSecret ? '•••••••• (set — paste a new one to replace)' : '';
  $('cGoogleSecret').placeholder = config.googleClientSecret ? '' : 'GOCSPX-…';
  $('cBaseUrl').value = config.baseUrl || '';
  $('googleRedirectHint').textContent = (config.baseUrl || location.origin) + '/api/auth/google/callback';
  }
  if (name === 'users') {
  // users with full details
  try {
    const { users } = await api('GET', '/api/admin/users');
    $('adminUsers').innerHTML = users.length ? users.map(u => `
      <div class="user-card">
        <div class="user-head"><div class="avatar">${esc((u.name || u.username || '?').trim().charAt(0).toUpperCase())}</div>
        <div><b>${esc(u.name || u.username)}</b>${u.isAdmin ? ' <span class="badge awaiting">ADMIN</span>' : ''}${u.viaGoogle ? ' <span class="badge done">Google</span>' : ''}<br>
        <span class="muted">@${esc(u.username)}</span></div>
        <span class="user-bal">$${Number(u.balance).toFixed(2)}</span></div>
        <div class="user-details">
          <div><span class="muted">Email</span><br>${u.email ? esc(u.email) : '—'}</div>
          <div><span class="muted">Phone</span><br>${u.phone ? esc(u.phone) : '—'}</div>
          <div><span class="muted">Joined</span><br>${new Date(u.createdAt).toLocaleDateString()}</div>
          <div><span class="muted">Orders</span><br>${u.orders} (${fmtUSD(u.spent)} spent)</div>
          <div><span class="muted">Top-ups</span><br>${u.topups} approved (${fmtUSD(u.toppedUp)})</div>
          <div><span class="muted">User ID</span><br><span class="mono">${esc(u.id)}</span></div>
        </div>
      </div>`).join('')
      : 'No users yet.';
  } catch (e) { $('adminUsers').innerHTML = 'Could not load users.'; }
  }
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function decideTopup(id, action) {
  if (!confirm(action === 'approve' ? 'Approve and credit the balance?' : 'Reject this top-up?')) return;
  await api('POST', '/api/admin/topups/' + id, { action });
  await loadAdminPanel('awaiting'); await loadAdminPanel('review');
}
$('cSave').onclick = async () => {
  try {
    const body = {
      markupPercent: $('cMarkup').value,
      provider: $('cProvider').value, siteName: $('cSite').value,
      bkashNumber: $('cBkash').value.trim(),
      nagadNumber: $('cNagad').value.trim(),
      bdtRate: $('cRate').value
    };
    body.googleClientId = $('cGoogleId').value.trim();
    const gSec = $('cGoogleSecret').value.trim();
    if (gSec && !gSec.startsWith('•')) body.googleClientSecret = gSec;
    body.baseUrl = $('cBaseUrl').value.trim();
    await api('POST', '/api/admin/config', body);
    showMsg('cMsg', 'Saved ✓', 'ok'); refreshMe(); loadServices();
  } catch (e) { showMsg('cMsg', e.message, 'err'); }
};

function showMsg(id, txt, cls) { const el = $(id); el.textContent = txt; el.className = 'msg ' + cls; }

// ---------- DB backup / restore ----------
$('cBackup').onclick = async () => {
  try {
    const r = await fetch('/api/admin/backup', { credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Backup failed');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'otpstation-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showMsg('cBackupMsg', 'Backup downloaded ✓', 'ok');
  } catch (e) { showMsg('cBackupMsg', e.message, 'err'); }
};
$('cRestore').onclick = async () => {
  const f = $('cRestoreFile').files[0];
  if (!f) { showMsg('cBackupMsg', 'Choose a backup file first.', 'err'); return; }
  if (!confirm('Restore this backup? Current data will be replaced.')) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    const r = await api('POST', '/api/admin/restore', { data });
    showMsg('cBackupMsg', r.message || 'Restored ✓ — reloading…', 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (e) { showMsg('cBackupMsg', e.message, 'err'); }
};

// ---------- announcement ticker ----------
(function () {
  const items = [
    '📢 Support open daily 9 AM – 12 AM',
    'Numbers in stock for all countries — order now and get your number instantly',
    'OTP not received? Full refund to your balance, automatically',
  ];
  const half = items.map(t => `<span>${t}</span>`).join('<span class="tick-sep">✦</span>');
  $('tickerTrack').innerHTML = half + '<span class="tick-sep">✦</span>' + half + '<span class="tick-sep">✦</span>';
})();

refreshMe().then(() => { loadServices(); });
