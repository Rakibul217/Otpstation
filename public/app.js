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
    initAcctPlates();
    syncBnavAuth();
  } else {
    $('authArea').innerHTML = `<button class="link" id="loginBtn">Log in / Register</button>`;
    $('loginBtn').onclick = () => { $('authModal').classList.remove('hidden'); };
    $('profileBar').classList.add('hidden');
    $('adminPlate').classList.add('hidden');
    $('profilePlate').classList.add('hidden');
    $('plates').classList.add('hidden');
    syncBnavAuth();
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
  $('authModal').classList.add('hidden');
  const svc = document.querySelector('#plates [data-tab="services"]');
  if (svc) svc.click();
  else { document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden')); $('tab-services').classList.remove('hidden'); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// ---------- mobile bottom nav ----------
function bnavTopup() {
  $('authModal').classList.add('hidden');
  if (!me) { $('authModal').classList.remove('hidden'); return; }
  const t = document.querySelector('#plates [data-tab="topup"]');
  if (t) t.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function bnavAuth() {
  $('authModal').classList.add('hidden');
  if (me) { const p = document.querySelector('#plates [data-tab="profile"]'); if (p) p.click(); }
  else $('authModal').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function syncBnavAuth() {
  const lbl = $('bnavAuthLabel'), ic = $('bnavAuthIcon');
  if (!lbl || !ic) return;
  if (me) { lbl.textContent = 'Profile'; ic.textContent = '👤'; }
  else { lbl.textContent = 'Login'; ic.textContent = '🔑'; }
}
// ---------- live chat widget ----------
let chatThread = null; // {id, token}
let chatPollTimer = null;
function chatSenderLabel(sender) {
  if (sender === 'user') return 'You';
  if (sender === 'bot') return 'OTPStation Assistant 🤖';
  if (sender === 'agent') return 'Support 🙋';
  return 'Support 🙋';
}
function chatBubbleHtml(sender, text) {
  const cls = sender === 'user' ? 'me' : 'them';
  return `<div class="chat-row ${cls}"><div class="chat-bubble"><b>${chatSenderLabel(sender)}</b><br>${esc(text).replace(/\n/g, '<br>')}</div></div>`;
}
function chatScroll() { const box = $('chatMsgs'); box.scrollTop = box.scrollHeight; }
function chatStored() {
  try {
    const id = localStorage.getItem('otp_chat_thread');
    if (!id) return null;
    return { id, token: localStorage.getItem('otp_chat_token') || '' };
  } catch (e) { return null; }
}
function chatStore(id, token) {
  try {
    localStorage.setItem('otp_chat_thread', id);
    localStorage.setItem('otp_chat_token', token || '');
  } catch (e) {}
}
function toggleChat() {
  const panel = $('chatPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (opening) openChatPanel();
  else if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
}
async function openChatPanel() {
  chatThread = chatStored();
  if (!chatThread && me) {
    // logged-in: start (or resume) the user's thread — no name needed
    try {
      const { thread } = await api('POST', '/api/chat/start', {});
      chatThread = { id: thread.id, token: '' };
      chatStore(thread.id, '');
    } catch (e) { $('chatMsgs').innerHTML = chatBubbleHtml('bot', 'Could not start chat: ' + e.message); return; }
  }
  if (!chatThread) { renderChatNamePrompt(); return; }
  await chatRefresh();
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(chatRefresh, 5000);
}
function renderChatNamePrompt() {
  let name = '';
  try { name = localStorage.getItem('otp_chat_name') || ''; } catch (e) {}
  $('chatMsgs').innerHTML = chatBubbleHtml('bot', 'Hi! Welcome to OTPStation support.') +
    `<div class="chat-row them"><div class="chat-bubble">What's your name?<br>
     <div style="margin-top:8px;display:flex;gap:6px">
       <input id="chatNameInput" maxlength="50" placeholder="Your name" value="${esc(name)}" style="margin:0">
       <button class="btn" onclick="chatStartAsGuest()">Start</button>
     </div></div></div>`;
  chatScroll();
}
async function chatStartAsGuest() {
  const inp = $('chatNameInput');
  const name = (inp ? inp.value : '').trim().slice(0, 50) || 'Guest';
  try { localStorage.setItem('otp_chat_name', name); } catch (e) {}
  try {
    const { thread } = await api('POST', '/api/chat/start', { name });
    chatThread = { id: thread.id, token: thread.guest_token || '' };
    chatStore(thread.id, chatThread.token);
    await chatRefresh();
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = setInterval(chatRefresh, 5000);
  } catch (e) { $('chatMsgs').innerHTML = chatBubbleHtml('bot', 'Could not start chat: ' + e.message); }
}
async function chatRefresh() {
  if (!chatThread || $('chatPanel').classList.contains('hidden')) return;
  try {
    const q = new URLSearchParams({ threadId: chatThread.id, token: chatThread.token || '' });
    const { messages } = await api('GET', '/api/chat/messages?' + q.toString());
    $('chatMsgs').innerHTML = messages.length
      ? messages.map(m => chatBubbleHtml(m.sender, m.text)).join('')
      : chatBubbleHtml('bot', 'Hi! How can I help you today?');
    chatScroll();
  } catch (e) { /* keep old messages on transient errors */ }
}
async function chatSend() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text || !chatThread) return;
  inp.value = '';
  try {
    await api('POST', '/api/chat/message', { threadId: chatThread.id, token: chatThread.token || '', text });
    await chatRefresh();
  } catch (e) {
    $('chatMsgs').innerHTML += chatBubbleHtml('bot', 'Could not send: ' + e.message);
    chatScroll();
  }
}
$('chatSend').onclick = chatSend;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend(); });
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
    if (b.dataset.tab === 'accounts') { acctServiceKey = null; $('acctDelivered').innerHTML = ''; loadAccountShop(); }
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
let currentService = null;
let currentCountries = [];
function countryRowHtml(code, c) {
  return `
    <div class="country">
      <div><div class="nm">${c.flag} ${esc(c.name)}</div><div class="ct">${Number(c.count).toLocaleString()} numbers</div></div>
      <button class="buy" onclick="buyNumber('${code}','${c.code}','${fmtUSD(c.priceUsd)}',${c.priceUsd})">${fmtUSD(c.priceUsd)}</button>
    </div>`;
}
function renderCountries() {
  const q = ($('countrySearch').value || '').trim().toLowerCase();
  const list = q ? currentCountries.filter(c => c.name.toLowerCase().includes(q)) : currentCountries;
  $('countryList').innerHTML = list.length
    ? list.map(c => countryRowHtml(currentService.code, c)).join('')
    : '<div class="card">No country matches your search.</div>';
}
async function openService(code, name) {
  currentService = { code, name };
  $('serviceGrid').classList.add('hidden');
  $('countryBox').classList.remove('hidden');
  $('countryTitle').textContent = name + ' — choose country';
  $('countrySearch').value = '';
  $('countryList').innerHTML = '<div class="card">Loading countries…</div>';
  const { countries } = await api('GET', '/api/countries?service=' + code);
  currentCountries = countries;
  renderCountries();
}
$('countrySearch').addEventListener('input', renderCountries);
$('backBtn').onclick = () => { $('countryBox').classList.add('hidden'); $('serviceGrid').classList.remove('hidden'); };

async function buyNumber(service, country, priceLabel, priceUsd) {
  if (!me) { $('authModal').classList.remove('hidden'); return; }
  if (!confirm(`Buy a number for ${priceLabel}?`)) return;
  try {
    const { order } = await api('POST', '/api/orders', { service, country, expectedPrice: priceUsd });
    alert('Your number: ' + order.number);
    await refreshMe();
    document.querySelector('[data-tab="numbers"]').click();
  } catch (e) {
    alert(e.message);
    // Price shifted or stock ran out while buying — auto-refresh the list
    // so it shows the new cheapest available price (like Grizzly's app).
    if (currentService) { try { await openService(currentService.code, currentService.name); } catch (_) {} }
  }
}

// ---------- accounts shop ----------
const ACCT_BRAND = { facebook: '#1877F2', whatsapp: '#25D366', telegram: '#229ED9', instagram: '#bc1888', google: '#4285F4', youtube: '#FF0000', tiktok: '#010101', imo: '#00B0FF', netflix: '#E50914' };
function acctLogo(p) {
  const logo = String(p.logo || '').trim();
  if (logo) {
    const bg = ACCT_BRAND[logo.toLowerCase()] || '#4f7cff';
    return `<span class="logo-chip" style="background:${bg}"><img class="logo-img" src="logos/${esc(logo)}.svg" alt=""></span>`;
  }
  return `<span class="logo-chip" style="background:linear-gradient(135deg,#a04fff,#4f7cff)">🔑</span>`;
}
let acctServiceKey = null;
function acctServiceKeyOf(p) { return String(p.logo || '').trim().toLowerCase() || 'other'; }
function acctServiceName(key) {
  if (key === 'other') return 'Other Accounts';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
function renderAcctServicePlates(products) {
  const c = $('acctServicePlates');
  if (!c) return;
  c.innerHTML = '';
  const groups = {};
  for (const p of products) { const k = acctServiceKeyOf(p); (groups[k] = groups[k] || []).push(p); }
  for (const k of Object.keys(groups).sort()) {
    const avail = groups[k].reduce((s, p) => s + (p.available || 0), 0);
    const b = document.createElement('button');
    b.className = 'plate' + (acctServiceKey === k ? ' active' : '');
    const iconBg = ACCT_BRAND[k] || 'linear-gradient(135deg,#a04fff,#4f7cff)';
    const iconInner = k === 'other' ? '🔑' : `<img src="logos/${esc(k)}.svg" alt="" style="width:30px;height:30px;display:block">`;
    b.innerHTML = `<span class="plate-icon" style="background:${iconBg};display:flex;align-items:center;justify-content:center;font-size:22px">${iconInner}</span>
      <span><span class="plate-label">${esc(acctServiceName(k))}</span><br><span class="plate-sub">${avail} pcs. available</span></span>`;
    b.onclick = () => openAcctService(k);
    c.appendChild(b);
  }
}
function openAcctService(key) {
  acctServiceKey = key;
  $('acctDelivered').innerHTML = '';
  $('acctTitle').textContent = acctServiceName(key) + ' Accounts';
  document.querySelectorAll('#plates .plate').forEach(x => x.classList.remove('active'));
  renderAcctServicePlates(window._acctProducts || []);
  document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden'));
  $('tab-accounts').classList.remove('hidden');
  loadAccountShop();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function initAcctPlates() {
  try {
    const { products } = await api('GET', '/api/account-products');
    window._acctProducts = products;
    renderAcctServicePlates(products);
  } catch (e) { /* shop unavailable — plates stay empty */ }
}
function acctProductCard(p) {
  return `
      <div class="acct-card">
        <div class="acct-head">
          ${acctLogo(p)}
          <div class="acct-title"><b>${esc(p.name)}</b>
            <div class="muted">${p.available} pcs. · Sold ${p.sold} pieces</div>
          </div>
          <div class="acct-price">${fmtUSD(p.priceUsd)}<span class="muted">/pc</span></div>
        </div>
        ${p.description ? `<p class="acct-desc">${esc(p.description)}</p>` : ''}
        <div class="acct-buyrow">
          <label class="qty-label">Qty <input type="number" id="aqty-${p.id}" value="1" min="1" max="100"></label>
          <button class="buy" ${p.available < 1 ? 'disabled' : ''} onclick="buyAccount('${p.id}','${esc(p.name)}',${p.priceUsd})">🛒 Buy</button>
        </div>
        ${p.available < 1 ? '<div class="warn">Out of stock</div>' : ''}
      </div>`;
}
async function loadAccountShop() {
  try {
    const { products } = await api('GET', '/api/account-products');
    window._acctProducts = products;
    renderAcctServicePlates(products);
    if (!acctServiceKey) {
      $('acctGrid').innerHTML = '<div class="card">Choose a service above to see its accounts.</div>';
      return;
    }
    const list = products.filter(p => acctServiceKeyOf(p) === acctServiceKey);
    $('acctTitle').textContent = acctServiceName(acctServiceKey || 'other') + ' Accounts';
    $('acctGrid').innerHTML = list.length ? list.map(acctProductCard).join('')
      : '<div class="card">No accounts for sale right now — check back soon.</div>';
  } catch (e) { $('acctGrid').innerHTML = `<div class="card">${esc(e.message)}</div>`; }
  loadMyAccounts();
}
async function buyAccount(id, name, priceUsd) {
  if (!me) { $('authModal').classList.remove('hidden'); return; }
  const qtyEl = $('aqty-' + id);
  const qty = Math.max(1, Math.min(100, Math.floor(Number(qtyEl ? qtyEl.value : 1) || 1)));
  const total = (Number(priceUsd) * qty).toFixed(2);
  if (!confirm(`Buy ${qty} × ${name} for $${total}?`)) return;
  try {
    const { order, items } = await api('POST', '/api/account-products/' + id + '/buy', { qty });
    $('acctDelivered').innerHTML = `
      <div class="card acct-deliver">
        <h3>✅ Your accounts — ${esc(order.productName)} × ${order.qty}</h3>
        <p class="muted">Delivered instantly · also saved in <b>My Accounts</b> below.</p>
        <div class="cred-box mono" id="credNow">${items.map(esc).join('<br>')}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" style="flex:1;min-width:140px" onclick="copyAcctCreds('credNow')">⧉ Copy all</button>
          <button class="btn btn-outline" style="flex:1;min-width:140px" onclick="downloadAcctFile('credNow','${order.id}')">⬇ Download .txt</button>
        </div>
      </div>`;
    $('acctDelivered').scrollIntoView({ behavior: 'smooth' });
    await refreshMe(); loadAccountShop();
  } catch (e) { alert(e.message); }
}
function downloadAcctFile(boxId, orderId) {
  const el = $(boxId);
  const txt = (el.innerText || el.textContent || '').trim();
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'otpstation-accounts-' + String(orderId).replace(/[^a-zA-Z0-9_-]/g, '') + '.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function copyAcctCreds(id) {
  const el = $(id);
  const txt = el.innerText || el.textContent;
  navigator.clipboard.writeText(txt).then(() => alert('Copied ✓')).catch(() => alert('Copy failed — select the text manually.'));
}
async function loadMyAccounts() {
  if (!me) { $('myAccounts').innerHTML = '<div class="card">Log in to see your accounts.</div>'; return; }
  try {
    const { orders } = await api('GET', '/api/my-accounts');
    $('myAccounts').innerHTML = orders.length ? orders.map(o => `
      <div class="order">
        <div><b>${esc(o.productName)}</b> × ${o.qty} · ${fmtUSD(o.totalUsd)} <span class="badge done">Delivered</span></div>
        <div class="row"><span>${new Date(o.createdAt).toLocaleString('en-US')}</span>
        <button class="link" onclick="toggleAcctCreds('${o.id}')">Show credentials</button></div>
        <div id="acreds-${o.id}" class="hidden cred-box mono">${o.items.map(esc).join('<br>')}</div>
      </div>`).join('')
      : '<div class="card">No accounts purchased yet.</div>';
  } catch (e) { $('myAccounts').innerHTML = '<div class="card">Could not load.</div>'; }
}
function toggleAcctCreds(id) {
  const el = $('acreds-' + id);
  el.classList.toggle('hidden');
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
      ${o.status === 'waiting' ? `<div class="wait">⏳ Waiting for SMS… (checking automatically)</div><span class="cancel-slot" data-created="${o.createdAt}" data-id="${o.id}"></span>` : ''}
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
// Grizzly policy: cancel unlocks 5 minutes after purchase — same as Grizzly's own site.
const CANCEL_MIN_MS = 5 * 60 * 1000;
function tickCancelSlots() {
  document.querySelectorAll('.cancel-slot').forEach(el => {
    const age = Date.now() - Number(el.dataset.created || 0);
    if (age >= CANCEL_MIN_MS) {
      if (!el.dataset.open) { el.dataset.open = '1'; el.innerHTML = `<button class="link" onclick="cancelOrder('${el.dataset.id}')">Cancel and refund</button>`; }
    } else {
      const s = Math.ceil((CANCEL_MIN_MS - age) / 1000);
      el.innerHTML = `<span class="muted">Cancel available in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>`;
    }
  });
}
setInterval(tickCancelSlots, 1000);
function copyCode(c) { navigator.clipboard.writeText(c); alert('Copied: ' + c); }
async function cancelOrder(id) {
  if (!confirm('Cancel this order and get a refund?')) return;
  try {
    await api('POST', '/api/orders/' + id + '/cancel');
    await refreshMe(); loadOrders();
  } catch (e) { alert(e.message); loadOrders(); }
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
  // payment queues + live chat always refresh; the rest load once per visit
  if (name === 'awaiting' || name === 'review' || name === 'chat' || !adminLoaded[name]) {
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
  $('cFlatFee').value = config.flatFeeUsd || 0;
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
  if (name === 'accounts') {
  // accounts shop: product list + create/edit + stock upload (counts only, never credentials)
  try {
    const { products } = await api('GET', '/api/admin/account-products');
    $('apList').innerHTML = products.length ? products.map(p => `
      <div class="card ap-prod">
        <div class="acct-head">
          ${acctLogo(p)}
          <div class="acct-title"><b>${esc(p.name)}</b>
            <div class="muted">${p.available} in stock · ${p.sold} sold · ${p.active ? 'Active' : 'Hidden'}</div>
          </div>
          <div class="acct-price">${fmtUSD(p.priceUsd)}<span class="muted">/pc</span></div>
        </div>
        <div class="row2">
          <label>Name <input id="apn-${p.id}" type="text" maxlength="80" value="${esc(p.name)}"></label>
          <label>Price (USD) <input id="app-${p.id}" type="number" step="0.01" min="0.01" value="${p.priceUsd}"></label>
        </div>
        <label>Description <textarea id="apd-${p.id}" rows="2" maxlength="2000">${esc(p.description || '')}</textarea></label>
        <label class="chk"><input type="checkbox" id="apa-${p.id}" ${p.active ? 'checked' : ''}> Active (visible in shop)</label>
        <button class="btn btn-outline" onclick="saveAccountProduct('${p.id}')">Save changes</button>
        <button class="btn btn-danger" onclick="deleteAccountProduct('${p.id}', '${esc(p.name).replace(/'/g, "\\'")}')">Delete</button>
        <div style="margin-top:10px">
          <label>Add stock — one account per line <textarea id="aps-${p.id}" rows="4" placeholder="email:password:2fa&#10;one account per line…"></textarea></label>
          <button class="btn" onclick="uploadAccountStock('${p.id}')">Upload stock</button>
        </div>
        <div id="apm-${p.id}" class="msg"></div>
      </div>`).join('')
      : '<div class="card">No products yet — create one above.</div>';
  } catch (e) { $('apList').innerHTML = '<div class="card">Could not load products.</div>'; }
  }
  if (name === 'chat') {
  await loadChatAdminThreads();
  await loadChatFaqs();
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
      flatFeeUsd: $('cFlatFee').value,
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

$('apCreate').onclick = async () => {
  try {
    await api('POST', '/api/admin/account-products', {
      name: $('apName').value.trim(),
      description: $('apDesc').value.trim(),
      price_usd: $('apPrice').value,
      logo: $('apLogo').value.trim()
    });
    $('apName').value = ''; $('apDesc').value = ''; $('apPrice').value = ''; $('apLogo').value = '';
    showMsg('apMsg', 'Product created ✓', 'ok');
    loadAdminPanel('accounts');
  } catch (e) { showMsg('apMsg', e.message, 'err'); }
};
async function saveAccountProduct(id) {
  try {
    await api('PUT', '/api/admin/account-products/' + id, {
      name: $('apn-' + id).value.trim(),
      description: $('apd-' + id).value.trim(),
      price_usd: $('app-' + id).value,
      active: $('apa-' + id).checked
    });
    showMsg('apm-' + id, 'Saved ✓', 'ok');
  } catch (e) { showMsg('apm-' + id, e.message, 'err'); }
}
async function deleteAccountProduct(id, name) {
  if (!confirm('Delete "' + name + '" and its unsold stock? Past orders are kept.')) return;
  try {
    await api('DELETE', '/api/admin/account-products/' + id);
    loadAdminPanel('accounts');
  } catch (e) { showMsg('apm-' + id, e.message, 'err'); }
}
async function uploadAccountStock(id) {
  const lines = $('aps-' + id).value;
  if (!lines.trim()) { showMsg('apm-' + id, 'Paste at least one account line.', 'err'); return; }
  try {
    const { added } = await api('POST', '/api/admin/account-products/' + id + '/stock', { lines });
    $('aps-' + id).value = '';
    showMsg('apm-' + id, `Added ${added} accounts to stock ✓`, 'ok');
    loadAdminPanel('accounts');
  } catch (e) { showMsg('apm-' + id, e.message, 'err'); }
}
// ---------- admin: live chat ----------
let chatAdminThread = null;
async function loadChatAdminThreads() {
  try {
    const { threads } = await api('GET', '/api/admin/chat/threads');
    $('chatThreads').innerHTML = threads.length ? threads.map(t => `
      <div class="topup-row" style="cursor:pointer" onclick="openChatThread('${t.id}')">
        <span><b>${esc(t.displayName || 'Guest')}</b>
          ${t.status === 'open' ? '<span class="badge awaiting">open</span>' : '<span class="badge done">closed</span>'}
          ${t.unread ? ` <span class="badge pending">${t.unread} new</span>` : ''}<br>
          <span class="muted">${esc((t.lastText || '—').slice(0, 90))}</span></span>
        <span class="muted">${t.updatedAt ? new Date(t.updatedAt).toLocaleString() : ''}</span>
      </div>`).join('')
      : 'No chats yet.';
  } catch (e) { $('chatThreads').innerHTML = 'Could not load chats.'; }
}
async function openChatThread(id) {
  chatAdminThread = id;
  try {
    const { thread, messages } = await api('GET', '/api/admin/chat/thread/' + id);
    $('chatConvoCard').classList.remove('hidden');
    $('chatConvoTitle').textContent = '💬 ' + (thread.displayName || 'Chat') + (thread.status === 'closed' ? ' (closed)' : '');
    $('chatConvo').innerHTML = messages.length
      ? messages.map(m => {
          const who = m.sender === 'user' ? esc(thread.displayName || 'User')
            : m.sender === 'bot' ? 'Bot 🤖' : m.sender === 'agent' ? 'Agent 🙋' : 'Admin';
          const cls = m.sender === 'user' ? 'them' : 'me';
          return `<div class="chat-row ${cls}"><div class="chat-bubble"><b>${who}</b><br>${esc(m.text).replace(/\n/g, '<br>')}</div></div>`;
        }).join('')
      : '<span class="muted">No messages yet.</span>';
    $('chatConvo').scrollTop = $('chatConvo').scrollHeight;
    $('chatCloseBtn').classList.toggle('hidden', thread.status !== 'open');
    $('chatReopenBtn').classList.toggle('hidden', thread.status === 'open');
  } catch (e) { showMsg('chatAdminMsg', e.message, 'err'); }
}
async function chatAdminReply() {
  const text = $('chatReply').value.trim();
  if (!text || !chatAdminThread) return;
  try {
    await api('POST', '/api/admin/chat/reply', { threadId: chatAdminThread, text });
    $('chatReply').value = '';
    showMsg('chatAdminMsg', 'Sent ✓', 'ok');
    await openChatThread(chatAdminThread);
    await loadChatAdminThreads();
  } catch (e) { showMsg('chatAdminMsg', e.message, 'err'); }
}
async function chatAdminSetStatus(action) {
  if (!chatAdminThread) return;
  if (action === 'close' && !confirm('Close this chat?')) return;
  try {
    await api('POST', '/api/admin/chat/' + action + '/' + chatAdminThread, {});
    await openChatThread(chatAdminThread);
    await loadChatAdminThreads();
  } catch (e) { showMsg('chatAdminMsg', e.message, 'err'); }
}
async function loadChatFaqs() {
  try {
    const { faqs } = await api('GET', '/api/admin/chat/faqs');
    $('chatFaqList').innerHTML = faqs.length ? faqs.map(f => `
      <div class="card" style="margin-bottom:8px">
        <div><b>${esc(f.keywords)}</b>
          ${f.active ? '<span class="badge done">active</span>' : '<span class="badge awaiting">off</span>'}</div>
        <div class="muted" style="margin-top:4px">${esc(f.answer)}</div>
        <div style="margin-top:8px">
          <button class="btn btn-outline" onclick="toggleChatFaq('${f.id}', ${!f.active})">${f.active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-danger" onclick="deleteChatFaq('${f.id}')">Delete</button>
        </div>
      </div>`).join('')
      : 'No FAQs yet.';
  } catch (e) { $('chatFaqList').innerHTML = 'Could not load FAQs.'; }
}
async function toggleChatFaq(id, active) {
  try { await api('PUT', '/api/admin/chat/faqs/' + id, { active }); loadChatFaqs(); }
  catch (e) { showMsg('cfMsg', e.message, 'err'); }
}
async function deleteChatFaq(id) {
  if (!confirm('Delete this FAQ?')) return;
  try { await api('DELETE', '/api/admin/chat/faqs/' + id); loadChatFaqs(); }
  catch (e) { showMsg('cfMsg', e.message, 'err'); }
}
$('chatReplySend').onclick = chatAdminReply;
$('chatReply').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatAdminReply(); });
$('chatCloseBtn').onclick = () => chatAdminSetStatus('close');
$('chatReopenBtn').onclick = () => chatAdminSetStatus('reopen');
$('cfAdd').onclick = async () => {
  const keywords = $('cfKeys').value.trim(), answer = $('cfAns').value.trim();
  if (!keywords || !answer) { showMsg('cfMsg', 'Keywords and answer are required.', 'err'); return; }
  try {
    await api('POST', '/api/admin/chat/faqs', { keywords, answer });
    $('cfKeys').value = ''; $('cfAns').value = '';
    showMsg('cfMsg', 'FAQ added ✓', 'ok');
    loadChatFaqs();
  } catch (e) { showMsg('cfMsg', e.message, 'err'); }
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
