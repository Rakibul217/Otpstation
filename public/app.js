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
    if (me.isAdmin) chatAdminWatch(); // sound + title ping on new customer messages
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
// NOTE: chat message ids are random hex strings (uid()), NOT numbers —
// never compare them with Number(). Fresh-message detection uses a seen-set.
let chatSeenIds = new Set(); // ids we've already seen — drives the reply ping
let chatLastSeenId = ''; // last seen message id (string), sent to the SSE stream
let chatBgTimer = null; // background watch: replies ping even with the panel closed
// ---------- soft notification ping (chat reply, OTP arrival) ----------
// Uses the same Web Audio unlock as the order-alerts bell (alertAudio).
function pingSound() {
  const ctx = typeof alertAudio === 'function' ? alertAudio() : null;
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    [[1046.5, 0], [1567.98, 0.12]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = t0 + dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.4);
    });
  } catch (e) {}
}
function flashTitleOnce(msg) {
  const orig = document.title; let n = 0;
  const iv = setInterval(() => {
    document.title = (n++ % 2) ? orig : msg;
    if (n > 9) { clearInterval(iv); document.title = orig; }
  }, 700);
}
function chatFabDot(show) {
  const d = $('chatFabDot');
  if (d) d.classList.toggle('hidden', !show);
}
// Poll quietly every 15s so an admin/agent reply pings even when the
// chat panel is closed.
function ensureChatBg() {
  if (chatBgTimer || !chatThread) return;
  chatBgTimer = setInterval(() => {
    if (!document.hidden) chatRefresh();
  }, 15000);
}
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
// The stored thread can belong to another user/guest on this device
// (e.g. switched accounts) — drop it and start a fresh thread.
let chatRestarting = false;
function chatClearStored() {
  try { localStorage.removeItem('otp_chat_thread'); localStorage.removeItem('otp_chat_token'); } catch (e) {}
  chatThread = null; chatSeenIds = new Set(); chatLastSeenId = '';
}
async function chatRestartWith(pendingText) {
  if (chatRestarting) return;
  chatRestarting = true;
  try {
    chatClearStored();
    await openChatPanel(); // starts a fresh thread for me / guest
    if (pendingText && chatThread) {
      await api('POST', '/api/chat/message', { threadId: chatThread.id, token: chatThread.token || '', text: pendingText });
      await chatRefresh();
    }
  } catch (e) {
    $('chatMsgs').innerHTML = chatBubbleHtml('bot', 'Could not send: ' + e.message);
    chatScroll();
  } finally { chatRestarting = false; }
}
function toggleChat() {
  const panel = $('chatPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (opening) { chatFabDot(false); openChatPanel(); }
  else {
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    chatStreamStop();
  }
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
  ensureChatBg();
  chatStreamStart();
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
    ensureChatBg();
    chatStreamStart();
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = setInterval(chatRefresh, 5000);
  } catch (e) { $('chatMsgs').innerHTML = chatBubbleHtml('bot', 'Could not start chat: ' + e.message); }
}
async function chatRefresh() {
  if (!chatThread) return;
  try {
    const q = new URLSearchParams({ threadId: chatThread.id, token: chatThread.token || '' });
    const { messages } = await api('GET', '/api/chat/messages?' + q.toString());
    const lastIdStr = messages.length ? String(messages[messages.length - 1].id) : '';
    const isFirst = chatSeenIds.size === 0;
    const fresh = isFirst ? [] : messages.filter(m => !chatSeenIds.has(String(m.id)));
    messages.forEach(m => chatSeenIds.add(String(m.id)));
    chatLastSeenId = lastIdStr || chatLastSeenId;
    if (fresh.some(m => m.sender === 'agent' || m.sender === 'admin')) {
      // New reply from support
      pingSound();
      chatFabDot(true);
      flashTitleOnce('💬 OTPStation Support replied!');
    }
    if ($('chatPanel').classList.contains('hidden')) return;
    $('chatMsgs').innerHTML = messages.length
      ? messages.map(m => chatBubbleHtml(m.sender, m.text)).join('')
      : chatBubbleHtml('bot', 'Hi! How can I help you today?');
    chatScroll();
  } catch (e) {
    if (e.message === 'Not your chat') chatRestartWith(); // stale thread → fresh start
    /* keep old messages on transient errors */
  }
}
// ---------- instant delivery: Server-Sent Events ----------
// Pushes new messages the moment they arrive — no more waiting for the next poll.
let chatES = null;
function chatStreamStop() { if (chatES) { try { chatES.close(); } catch (e) {} chatES = null; } }
function chatStreamStart() {
  chatStreamStop();
  if (!chatThread || typeof EventSource === 'undefined') return;
  try {
    const q = new URLSearchParams({ threadId: chatThread.id, token: chatThread.token || '', since: chatLastSeenId || '' });
    const es = new EventSource('/api/chat/stream?' + q.toString());
    chatES = es;
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      const msgs = d.messages || [];
      if (!msgs.length) return;
      const panelHidden = $('chatPanel').classList.contains('hidden');
      msgs.forEach(m => {
        const id = String(m.id);
        if (chatSeenIds.has(id)) return;
        chatSeenIds.add(id); chatLastSeenId = id;
        if (!panelHidden) $('chatMsgs').insertAdjacentHTML('beforeend', chatBubbleHtml(m.sender, m.text));
      });
      if (!panelHidden) chatScroll();
      if (msgs.some(m => m.sender === 'agent' || m.sender === 'admin')) {
        pingSound(); chatFabDot(true); flashTitleOnce('💬 OTPStation Support replied!');
      }
    };
    // EventSource auto-reconnects on drop; the 15s background poll stays as a safety net.
  } catch (e) {}
}
// Watch silently for replies on page load (returning visitor with a stored thread)
if (chatStored()) { chatThread = chatStored(); ensureChatBg(); }
async function chatSend() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text || !chatThread) return;
  inp.value = '';
  try {
    await api('POST', '/api/chat/message', { threadId: chatThread.id, token: chatThread.token || '', text });
    await chatRefresh();
  } catch (e) {
    if (e.message === 'Not your chat') { await chatRestartWith(text); return; }
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
let allServices = [];
async function loadServices() {
  try {
    const { services } = await api('GET', '/api/services');
    allServices = services;
    const cnt = $('serviceCount');
    if (cnt) cnt.textContent = '🔍 ' + allServices.length.toLocaleString() + ' services';
    // Homepage shows the POPULAR services only — the full catalog lives
    // inside the round search selector (less scrolling, find anything).
    $('serviceGrid').innerHTML = allServices.filter(s => !s.ext).map(svcTile).join('');
    const grid = $('serviceGrid');
    if (grid && !grid.dataset.wired) {
      grid.dataset.wired = '1';
      grid.addEventListener('click', e => {
        const t = e.target.closest('.svc');
        if (t && t.dataset.code) openService(t.dataset.code, t.dataset.name);
      });
    }
    const pill = $('servicePill');
    if (pill && !pill.dataset.wired) {
      pill.dataset.wired = '1';
      pill.addEventListener('click', openServiceModal);
    }
    const mx = $('serviceModalX');
    if (mx && !mx.dataset.wired) {
      mx.dataset.wired = '1';
      mx.addEventListener('click', closeServiceModal);
      $('serviceModal').addEventListener('click', e => { if (e.target.id === 'serviceModal') closeServiceModal(); });
      $('modalServiceSearch').addEventListener('input', () => renderModalList($('modalServiceSearch').value));
      $('modalServiceList').addEventListener('click', e => {
        const t = e.target.closest('.svc-row');
        if (t && t.dataset.code) { closeServiceModal(); openService(t.dataset.code, t.dataset.name); }
      });
    }
  } catch (e) { $('serviceGrid').innerHTML = `<div class="card">${e.message}</div>`; }
}
function svcRow(s) {
  const chip = s.ext
    ? `<span class="row-chip letter" style="background:${s.color}">${esc(((s.name || '?').trim()[0] || '?').toUpperCase())}${s.icon ? `<img class="svc-icon" src="${s.icon}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`
    : `<span class="row-chip" style="background:${s.color}"><img class="logo-img" src="logos/${s.logo}.svg" alt="${esc(s.name)}"></span>`;
  return `<div class="svc-row" data-code="${esc(s.code)}" data-name="${esc(s.name)}">${chip}<span class="row-name">${esc(s.name)}</span></div>`;
}
function renderModalList(q) {
  const query = (q || '').trim().toLowerCase();
  const list = query ? allServices.filter(s => s.name.toLowerCase().includes(query)) : allServices;
  const box = $('modalServiceList');
  if (!list.length) { box.innerHTML = '<div class="modal-more">No service matches your search. Try another name.</div>'; return; }
  const shown = list.slice(0, 150);
  box.innerHTML = shown.map(svcRow).join('') + (list.length > 150 ? `<div class="modal-more">Showing 150 of ${list.length.toLocaleString()} — type more letters to narrow it down.</div>` : '');
}
function openServiceModal() {
  const m = $('serviceModal');
  m.hidden = false;
  $('modalServiceSearch').value = '';
  renderModalList('');
  document.body.style.overflow = 'hidden';
}
function closeServiceModal() {
  $('serviceModal').hidden = true;
  document.body.style.overflow = '';
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
      <div class="num-row"><span class="num" onclick="copyNum('${o.number}', this)" title="Tap to copy">📞 ${o.number}</span><button class="copy-mini" onclick="copyNum('${o.number}', this)" title="Copy number">📋</button></div>
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
          if (order.status === 'done') { pingSound(); loadOrders(); return; }
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
function copyNum(n, el) {
  const show = () => {
    if (el) { const old = el.innerHTML; el.innerHTML = 'Copied ✓'; setTimeout(() => { el.innerHTML = old; }, 1200); }
    else alert('Number copied ✓');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(n).then(show).catch(() => alert('Copy failed — select the text manually.'));
  else alert('Copy failed — select the text manually.');
}
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
    const wb = info.welcomeBonus || {};
    $('bonusBadge').innerHTML = (wb.enabled && wb.amount > 0)
      ? `<div class="bonus-badge">🎁 <b>Welcome Bonus:</b> get <b>$${wb.amount} FREE</b> credit on your first deposit!</div>`
      : '';
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
  $('cBonusUsd').value = config.welcomeBonusUsd ?? 1;
  $('cBonusOn').value = config.welcomeBonusEnabled === false ? '0' : '1';
  $('cBonusLimit').value = config.welcomeBonusLimit || 0;
  $('cBonusGiven').textContent = `Bonuses given so far: ${config.welcomeBonusGiven || 0}.`;
  $('cSmsOn').value = config.smsAutoApprove ? '1' : '0';
  $('cSmsUrl').value = location.origin + '/api/payment-webhook';
  $('cSmsSecret').value = config.smsWebhookSecret || '(turn On + Save to generate)';
  $('cSmsBal').value = config.smsBalanceCheck ? '1' : '0';
  const lb = config.smsLastBalances || {};
  $('cSmsBalances').textContent = (lb.bkash != null || lb.nagad != null)
    ? `Last seen — bKash: ৳${lb.bkash ?? '–'}, Nagad: ৳${lb.nagad ?? '–'}.`
    : 'No balance seen yet — arrives with the first forwarded SMS.';
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
  const r = await api('POST', '/api/admin/topups/' + id, { action });
  if (r.bonus > 0) alert(`🎁 Welcome bonus $${r.bonus} credited to the user!`);
  await loadAdminPanel('awaiting'); await loadAdminPanel('review');
}
$('cSave').onclick = async () => {
  try {
    const body = {
      flatFeeUsd: $('cFlatFee').value,
      provider: $('cProvider').value, siteName: $('cSite').value,
      bkashNumber: $('cBkash').value.trim(),
      nagadNumber: $('cNagad').value.trim(),
      bdtRate: $('cRate').value,
      welcomeBonusUsd: $('cBonusUsd').value,
      welcomeBonusEnabled: $('cBonusOn').value === '1',
      welcomeBonusLimit: $('cBonusLimit').value,
      smsAutoApprove: $('cSmsOn').value === '1',
      smsBalanceCheck: $('cSmsBal').value === '1'
    };
    body.googleClientId = $('cGoogleId').value.trim();
    const gSec = $('cGoogleSecret').value.trim();
    if (gSec && !gSec.startsWith('•')) body.googleClientSecret = gSec;
    body.baseUrl = $('cBaseUrl').value.trim();
    const { config: saved } = await api('POST', '/api/admin/config', body);
    if (saved.smsWebhookSecret) $('cSmsSecret').value = saved.smsWebhookSecret;
    const lb2 = saved.smsLastBalances || {};
    $('cSmsBalances').textContent = (lb2.bkash != null || lb2.nagad != null)
      ? `Last seen — bKash: ৳${lb2.bkash ?? '–'}, Nagad: ৳${lb2.nagad ?? '–'}.`
      : 'No balance seen yet — arrives with the first forwarded SMS.';
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
// ---------- admin: sound watch for new customer messages ----------
// While the admin is logged in (any page), poll the inbox: a new
// customer message plays the ping + flashes the tab title.
let adminChatTimer = null;
let adminChatUnread = -1;
function chatAdminWatch() {
  if (adminChatTimer) return;
  adminChatTimer = setInterval(async () => {
    if (!me || !me.isAdmin || document.hidden) return;
    try {
      const { threads } = await api('GET', '/api/admin/chat/threads');
      const unread = threads.reduce((s, t) => s + (Number(t.unread) || 0), 0);
      if (adminChatUnread >= 0 && unread > adminChatUnread) {
        pingSound();
        flashTitleOnce('💬 New customer message!');
      }
      adminChatUnread = unread;
      // Keep the inbox + open conversation live while he's looking at them
      const panel = $('apanel-chat');
      if (panel && !panel.classList.contains('hidden')) {
        await loadChatAdminThreads();
        if (chatAdminThread) await openChatThread(chatAdminThread);
      }
    } catch (e) {}
  }, 10000);
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
function renderAdminConvo(thread, messages) {
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
}
async function openChatThread(id) {
  chatAdminThread = id;
  try {
    const { thread, messages } = await api('GET', '/api/admin/chat/thread/' + id);
    renderAdminConvo(thread, messages);
    adminChatStreamStart(id, messages.length ? String(messages[messages.length - 1].id) : '');
  } catch (e) { showMsg('chatAdminMsg', e.message, 'err'); }
}
// Instant delivery for the open admin conversation — new customer
// messages appear the moment they arrive, no polling delay.
let adminChatES = null;
function adminChatStreamStop() { if (adminChatES) { try { adminChatES.close(); } catch (e) {} adminChatES = null; } }
function adminChatStreamStart(id, since) {
  adminChatStreamStop();
  if (typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource('/api/admin/chat/stream/' + id + '?since=' + encodeURIComponent(since || ''));
    adminChatES = es;
    es.onmessage = async () => {
      if (chatAdminThread !== id) return;
      try {
        const { thread, messages } = await api('GET', '/api/admin/chat/thread/' + id);
        renderAdminConvo(thread, messages);
      } catch (e) {}
    };
  } catch (e) {}
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
(async function () {
  const items = [
    '📢 Support open daily 9 AM – 12 AM',
    'Numbers in stock for all countries — order now and get your number instantly',
    'OTP not received? Full refund to your balance, automatically',
  ];
  let wb = {};
  try {
    const info = await api('GET', '/api/payinfo');
    wb = info.welcomeBonus || {};
    if (wb.enabled && wb.amount > 0) items.unshift(`🎉 Welcome Bonus: $${wb.amount} FREE credit on your first deposit!`);
  } catch (e) {}
  const half = items.map(t => `<span>${t}</span>`).join('<span class="tick-sep">✦</span>');
  $('tickerTrack').innerHTML = half + '<span class="tick-sep">✦</span>' + half + '<span class="tick-sep">✦</span>';
  // welcome bonus popup: show once per page load when bonus is enabled
  if (wb.enabled && wb.amount > 0) {
    $('bpAmount').textContent = wb.amount;
    setTimeout(showBonusPopup, 1500);
  }
})();

// ---------- welcome bonus popup ----------
function showBonusPopup() { $('bonusPopup').classList.remove('hidden'); }
function closeBonusPopup() { $('bonusPopup').classList.add('hidden'); }
function bonusPopupCta() { closeBonusPopup(); bnavTopup(); }

refreshMe().then(() => { loadServices(); });

// ---------- order alerts: bell rings on new top-up ----------
const orderAlerts = { on: false, known: new Set(), timer: null, wakeLock: null, audio: null, origTitle: document.title };
function alertAudio() {
  if (!orderAlerts.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    orderAlerts.audio = new AC();
  }
  if (orderAlerts.audio.state === 'suspended') orderAlerts.audio.resume();
  return orderAlerts.audio;
}
// "kring" chime: bright two-tone bell, repeated
function bellRing(repeats) {
  const ctx = alertAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (let r = 0; r < (repeats || 3); r++) {
    [880, 1174.66].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t = t0 + r * 0.7 + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.65);
    });
  }
}
function flashTitle(msg) {
  let n = 0;
  const iv = setInterval(() => {
    document.title = (n++ % 2) ? orderAlerts.origTitle : msg;
    if (n > 11 || !orderAlerts.on) { clearInterval(iv); document.title = orderAlerts.origTitle; }
  }, 700);
}
async function pollOrderAlerts() {
  try {
    const { topups } = await api('GET', '/api/admin/topups?status=pending');
    const fresh = [];
    (topups || []).forEach(t => {
      if (!orderAlerts.known.has(t.id)) { orderAlerts.known.add(t.id); fresh.push(t); }
    });
    fresh.forEach(t => {
      bellRing(3);
      if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
      flashTitle('🔔 New order: ৳' + (t.amountBdt || '') + '!');
      const log = $('alertLog');
      if (log) {
        const row = document.createElement('div');
        row.className = 'alert-row';
        row.innerHTML = `<span>🔔 <b>${esc(t.username || '')}</b> · ৳${t.amountBdt || ''} → $${Number(t.amount).toFixed(2)}<br><span class="muted">${new Date().toLocaleTimeString()}</span></span>
          <button class="btn btn-sm" onclick="toggleAdminPanel('review')">Review</button>`;
        log.prepend(row);
      }
    });
  } catch (e) { /* keep polling silently */ }
}
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      orderAlerts.wakeLock = await navigator.wakeLock.request('screen');
      orderAlerts.wakeLock.addEventListener('release', () => { orderAlerts.wakeLock = null; });
    }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (orderAlerts.on && document.visibilityState === 'visible') acquireWakeLock();
});
async function toggleOrderAlerts() {
  const btn = $('alertToggle'), st = $('alertStatus');
  if (!orderAlerts.on) {
    // user gesture: unlock audio now so the bell can ring later
    alertAudio(); bellRing(1);
    try {
      const { topups } = await api('GET', '/api/admin/topups?status=pending');
      (topups || []).forEach(t => orderAlerts.known.add(t.id));
    } catch (e) {}
    orderAlerts.on = true;
    acquireWakeLock();
    orderAlerts.timer = setInterval(pollOrderAlerts, 20000);
    if (btn) { btn.textContent = '🔕 Stop Alerts'; btn.classList.add('ringing'); }
    if (st) { st.textContent = '🟢 Alerts ON — listening for new orders…'; st.className = 'alert-status on'; }
  } else {
    orderAlerts.on = false;
    clearInterval(orderAlerts.timer); orderAlerts.timer = null;
    if (orderAlerts.wakeLock) { try { orderAlerts.wakeLock.release(); } catch (e) {} orderAlerts.wakeLock = null; }
    document.title = orderAlerts.origTitle;
    if (btn) { btn.textContent = '🔔 Start Alerts'; btn.classList.remove('ringing'); }
    if (st) { st.textContent = 'Alerts are OFF'; st.className = 'alert-status off'; }
  }
}

$('cSmsRegen').onclick = async () => {
  if (!confirm('Generate a new webhook secret? Update the forwarder app on your phone too.')) return;
  try {
    const { secret } = await api('POST', '/api/admin/sms-secret', {});
    $('cSmsSecret').value = secret;
    showMsg('cMsg', 'New secret generated ✓ — update your phone app', 'ok');
  } catch (e) { showMsg('cMsg', e.message, 'err'); }
};
