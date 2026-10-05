// =====================================================================
//  JİBER Saha Denetim ve Kalite Portalı — arayüz
//  Tüm veriler sunucudaki (Vercel + Postgres) merkezi veritabanından gelir.
//  Tarayıcıda hiçbir denetim/rapor verisi saklanmaz.
// =====================================================================

// ---------------------------------------------------------------------
//  Yardımcılar
// ---------------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Europe/Istanbul';
const dtf = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tf = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const isoDayTZ = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const toDate = v => v == null ? null : (v instanceof Date ? v : new Date(v));
const fmtDT = v => { const d = toDate(v); return d ? dtf.format(d) : '—'; };
const fmtDay = s => s ? s.split('-').reverse().join('.') : '—';
const reportNo = seq => seq ? 'DNT-' + String(seq).padStart(6, '0') : '—';
const fmtM = m => m == null ? '—' : (m >= 1000 ? (m / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' km' : Math.round(m).toLocaleString('tr-TR') + ' m');
const go = path => { location.hash = '#/' + path; };
const trLower = s => String(s || '').toLocaleLowerCase('tr-TR');
const photoUrl = id => '/api?a=photo&id=' + encodeURIComponent(id);

const DEFAULT_SETTINGS = { photoRequiredOnNo: true, actionOnNo: true, maxDistanceM: 300, blockOutside: false, maxAccuracyM: 100 };

const S = {
  user: null, mail: false, settings: { ...DEFAULT_SETTINGS },
  stores: new Map(), categories: [], questions: [], users: [], audits: new Map(),
  offset: 0, timeOk: false, loaded: false,
  filters: { q: '', store: '', status: '', auditor: '', from: '', to: '' },
  draft: null, saveTimer: null, saving: false, savePending: false, saveError: false, lastSaved: null,
  gps: { state: 'idle' }, ready: false, modalOnClose: null, renderQueued: false, dataSig: ''
};
const isAdmin = () => S.user?.role === 'admin';
const nowServer = () => new Date(Date.now() + S.offset);
const todayISO = () => isoDayTZ.format(nowServer());
const allAudits = () => [...S.audits.values()];
const getAudit = id => S.audits.get(id);

// ---------------------------------------------------------------------
//  Sunucu ile konuşma
// ---------------------------------------------------------------------
async function api(a, body = null, { get = null } = {}) {
  let url = '/api?a=' + encodeURIComponent(a);
  const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: {} };
  if (get) url += '&' + new URLSearchParams(get);
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const t0 = Date.now();
  let r;
  try { r = await fetch(url, opt); }
  catch { throw { status: 0, message: 'İnternet bağlantısı yok veya sunucuya ulaşılamıyor.' }; }
  const t1 = Date.now();
  let j = null;
  try { j = await r.json(); } catch { /* yok */ }
  if (j?.now) { S.offset = j.now - (t0 + t1) / 2; S.timeOk = true; }
  if (!r.ok || !j?.ok) {
    if (r.status === 401 && S.user && a !== 'login' && a !== 'changepw') { loggedOut('Oturumunuz sona erdi. Lütfen tekrar giriş yapın.'); }
    throw { status: r.status, message: j?.error || `Sunucu hatası (${r.status}).` };
  }
  return j;
}
const errMsg = e => e?.message || 'Beklenmeyen bir hata oluştu.';

function toast(msg, type = 'info', ms = 4500) {
  const ico = { success: '✓', error: '✕', warn: '!', info: 'i' }[type] || 'i';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<b>${ico}</b><div>${esc(msg)}</div>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---------------------------------------------------------------------
//  Modal & onay
// ---------------------------------------------------------------------
function openModal(html, { wide = false, onClose = null } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-back" data-act="modal-close"></div><div class="modal-card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  S.modalOnClose = onClose;
  document.body.classList.add('noscroll');
  setTimeout(() => { const card = m.querySelector('.modal-card'); if (card) $('input:not([type=hidden]):not([readonly]),select,textarea', card)?.focus(); }, 40);
}
function closeModal(silent = false) {
  const m = $('#modal');
  if (m.hidden) return;
  m.hidden = true; m.innerHTML = '';
  document.body.classList.remove('noscroll');
  const cb = S.modalOnClose; S.modalOnClose = null;
  if (cb && !silent) cb();
}
function confirmDlg({ title, message = '', ok = 'Onayla', cancel = 'Vazgeç', danger = false }) {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(message)}</p>
      <div class="modal-actions"><button class="btn ghost" id="cfNo">${esc(cancel)}</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="cfYes">${esc(ok)}</button></div>`, { onClose: () => res(false) });
    $('#cfNo').onclick = () => { closeModal(true); res(false); };
    $('#cfYes').onclick = () => { closeModal(true); res(true); };
  });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

async function withBtn(btn, fn, busy = 'Kaydediliyor…') {
  const html = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner sm"></span> ${busy}`; }
  try { return await fn(); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

// ---------------------------------------------------------------------
//  Başlangıç
// ---------------------------------------------------------------------
(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('sifre')) return showResetScreen(params.get('sifre'));
  try {
    const r = await api('me');
    S.mail = r.mail;
    if (r.user) return startApp(r.user);
    showLogin();
  } catch (e) {
    showFatal(errMsg(e));
  }
})();

function showFatal(msg) {
  $('#boot').hidden = true; $('#shell').hidden = true;
  const a = $('#auth'); a.hidden = false;
  a.innerHTML = `<div class="auth-card"><span class="brand-mark">JİBER</span><h1>Portal açılamadı</h1>
    <p class="muted">${esc(msg)}</p><button class="btn primary block" style="margin-top:14px" onclick="location.reload()">Tekrar dene</button></div>`;
}

// ---------------------------------------------------------------------
//  Giriş, şifremi unuttum, şifre sıfırlama
// ---------------------------------------------------------------------
function showLogin(msg = '') {
  $('#boot').hidden = true; $('#shell').hidden = true;
  const a = $('#auth'); a.hidden = false;
  a.innerHTML = `<div class="auth-card">
    <span class="brand-mark">JİBER</span>
    <h1>Saha Denetim ve Kalite Portalı</h1>
    <p class="muted small">Devam etmek için giriş yapın.</p>
    ${msg ? `<p class="badge amber" style="white-space:normal;margin-top:10px">${esc(msg)}</p>` : ''}
    <form id="loginForm" novalidate>
      <label class="field">E-posta<input type="email" name="email" autocomplete="username" required></label>
      <label class="field">Şifre<span class="pw-wrap"><input type="password" name="pw" autocomplete="current-password" required>
        <button type="button" data-act="pw-toggle">Göster</button></span></label>
      <button class="btn primary block" type="submit">Giriş Yap</button>
      <div style="text-align:center"><button type="button" class="link-btn" data-act="forgot">Şifremi Unuttum</button></div>
    </form></div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button[type=submit]', f);
    const email = f.email.value.trim(), pw = f.pw.value;
    if (!email || !pw) return toast('E-posta ve şifre girin.', 'warn');
    try {
      const r = await withBtn(btn, () => api('login', { email, password: pw }), 'Giriş yapılıyor…');
      startApp(r.user);
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

function forgotDialog(prefill = '') {
  openModal(`<h3>Şifremi Unuttum</h3>
    <p class="muted">E-posta adresinizi girin. Hesabınız varsa şifre sıfırlama bağlantısı gönderilir.</p>
    <form id="fgForm" style="display:grid;gap:12px;margin-top:12px">
      <label class="field">E-posta<input type="email" name="email" value="${esc(prefill)}" required autocomplete="email"></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button>
      <button class="btn primary" type="submit">Bağlantı Gönder</button></div></form>`);
  $('#fgForm').onsubmit = async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Geçerli bir e-posta adresi girin.', 'warn');
    try {
      await withBtn($('button[type=submit]', e.target), () => api('forgot', { email }), 'Gönderiliyor…');
      closeModal(true);
      toast('Bu e-posta adresi kayıtlıysa şifre sıfırlama bağlantısı gönderildi. Gelen kutunuzu (ve gereksiz klasörünü) kontrol edin.', 'success', 8000);
    } catch (err) { toast(errMsg(err), 'error', 7000); }
  };
}

async function showResetScreen(token) {
  $('#boot').hidden = true;
  const a = $('#auth'); a.hidden = false;
  a.innerHTML = `<div class="auth-card"><span class="brand-mark">JİBER</span><h1>Yeni şifre belirle</h1><p class="muted">Bağlantı kontrol ediliyor…</p></div>`;
  const back = () => { history.replaceState(null, '', location.pathname); showLogin(); };
  let email;
  try { email = (await api('resetcheck', null, { get: { token } })).email; }
  catch (err) {
    a.innerHTML = `<div class="auth-card"><span class="brand-mark">JİBER</span><h1>Bağlantı geçersiz</h1>
      <p class="muted">${esc(errMsg(err))}</p><button class="btn primary block" id="toLogin" style="margin-top:14px">Giriş ekranına dön</button></div>`;
    $('#toLogin').onclick = back; return;
  }
  a.innerHTML = `<div class="auth-card"><span class="brand-mark">JİBER</span><h1>Yeni şifre belirle</h1>
    <p class="muted small">${esc(email)}</p>
    <form id="rsForm" novalidate>
      <label class="field">Yeni şifre<input type="password" name="p1" autocomplete="new-password" required>
        <span class="hint">En az 6 karakter. Tahmin edilmesi zor bir şifre seçin.</span></label>
      <label class="field">Yeni şifre (tekrar)<input type="password" name="p2" autocomplete="new-password" required></label>
      <button class="btn primary block" type="submit">Şifreyi Kaydet</button></form></div>`;
  $('#rsForm').onsubmit = async e => {
    e.preventDefault();
    const p1 = e.target.p1.value, p2 = e.target.p2.value;
    if (p1.length < 6) return toast('Şifre en az 6 karakter olmalı.', 'warn');
    if (p1 !== p2) return toast('Şifreler aynı değil.', 'warn');
    try {
      await withBtn($('button[type=submit]', e.target), () => api('reset', { token, password: p1 }));
      toast('Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.', 'success', 7000);
      back();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// ---------------------------------------------------------------------
//  Oturum ve veri
// ---------------------------------------------------------------------
async function startApp(user) {
  S.user = user;
  $('#auth').hidden = true; $('#boot').hidden = false;
  try { await loadData(); }
  catch (err) { return showFatal(errMsg(err)); }
  $('#boot').hidden = true; $('#shell').hidden = false;
  S.ready = true;
  paintUser();
  render();
}

function loggedOut(msg) {
  S.user = null; S.ready = false; S.draft = null; S.audits.clear(); S.stores.clear();
  clearTimeout(S.saveTimer); S.savePending = false;
  closeModal(true);
  showLogin(msg);
}

async function loadData() {
  const d = await api('data');
  const prevRole = S.user?.role;
  S.user = d.user; S.mail = d.mail;
  S.settings = { ...DEFAULT_SETTINGS, ...d.settings };
  S.categories = d.categories; S.questions = d.questions; S.users = d.users;
  S.stores = new Map(d.stores.map(s => [s.id, s]));
  S.audits = new Map(d.audits.map(a => [a.id, a]));
  S.loaded = true;
  const sig = JSON.stringify([d.user, d.settings, d.categories, d.questions, d.stores, d.users, d.audits]);
  const changed = sig !== S.dataSig;
  S.dataSig = sig;
  if (prevRole && prevRole !== d.user.role) { paintUser(); go('ana'); }
  return changed;
}

// Diğer cihazlardaki değişiklikleri almak için düzenli yenileme
async function refresh() {
  if (!S.ready || document.visibilityState !== 'visible') return;
  try { if (await loadData()) { paintUser(); queueRender(); } } catch { /* sessiz */ }
}
setInterval(refresh, 20000);
document.addEventListener('visibilitychange', refresh);
window.addEventListener('focus', refresh);
async function reload() { try { await loadData(); paintUser(); queueRender(); } catch (err) { toast(errMsg(err), 'error'); } }

function tickClock() {
  const t = dtf.format(nowServer());
  $$('[data-clock]').forEach(el => { el.textContent = t; });
  $$('[data-clock-src]').forEach(el => { el.textContent = S.timeOk ? 'sunucu saati' : 'cihaz saati!'; });
}
setInterval(tickClock, 1000);

function paintUser() {
  const p = S.user; if (!p) return;
  $('#userName').textContent = p.name;
  $('#userRole').textContent = p.role === 'admin' ? 'Yönetici' : 'Denetçi';
  $('#avatar').textContent = (p.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toLocaleUpperCase('tr-TR');
  $$('[data-admin-only]').forEach(el => { el.hidden = p.role !== 'admin'; });
}

// ---------------------------------------------------------------------
//  Yönlendirme
// ---------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = h.split('/');
  return { a: a || 'ana', b, c };
}
window.addEventListener('hashchange', () => render());
window.addEventListener('beforeunload', e => { if (S.savePending || S.saving) { e.preventDefault(); e.returnValue = ''; } });

function queueRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; render({ fromData: true }); });
}

function render({ fromData = false } = {}) {
  if (!S.ready) return;
  const r = route();
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === (r.a === 'rapor' ? 'raporlar' : r.a)));
  const v = $('#view');
  if (r.a === 'denetim' && r.b) {
    if (fromData && S.draft?.id === r.b) { refreshAuditBits(); return; }
    return openAuditForm(r.b);
  }
  if (fromData && $('#modal').hidden === false) return; // açık form varken ekranı değiştirme
  if (fromData && document.activeElement && v.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) {
    if (r.a === 'raporlar') { const l = $('#repList'); if (l) l.innerHTML = reportListHtml(); }
    return;
  }
  switch (r.a) {
    case 'ana': v.innerHTML = viewHome(); break;
    case 'denetim': v.innerHTML = viewAuditStart(); break;
    case 'raporlar': v.innerHTML = viewReports(); break;
    case 'rapor': return openReport(r.b, fromData);
    case 'yonetim':
      if (!isAdmin()) { v.innerHTML = `<div class="card empty">Bu bölüm yalnızca yöneticilere açıktır.</div>`; return; }
      v.innerHTML = viewAdmin(r.b || 'kullanicilar'); break;
    default: go('ana');
  }
  tickClock();
}

// ---------------------------------------------------------------------
//  Durum yardımcıları
// ---------------------------------------------------------------------
function statusOf(a) {
  if (a.status !== 'completed') return { k: 'draft', t: 'Taslak', c: 'gray' };
  if (a.result === 'uygun') return { k: 'uygun', t: 'Uygun', c: 'green' };
  if (a.actionStatus === 'kapandi') return { k: 'kapandi', t: 'Aksiyon kapandı', c: 'blue' };
  return { k: 'acik', t: 'Aksiyon bekliyor', c: 'amber' };
}
const gpsBadge = a => a.gpsVerified ? `<span class="badge green">✓ GPS Onaylı</span>` : `<span class="badge red">GPS onaysız</span>`;
const completedAudits = () => allAudits().filter(a => a.status === 'completed').sort((x, y) => (y.completedAt || 0) - (x.completedAt || 0));
const myDrafts = () => allAudits().filter(a => a.status === 'draft' && a.auditorId === S.user.id).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
const sortedStores = (onlyActive = false) => [...S.stores.values()].filter(s => !onlyActive || s.active !== false)
  .sort((a, b) => (a.region || '').localeCompare(b.region || '', 'tr') || a.name.localeCompare(b.name, 'tr'));
const sortedCats = () => [...S.categories].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
const hasCoord = s => typeof s?.lat === 'number' && typeof s?.lng === 'number';

// ---------------------------------------------------------------------
//  Ana sayfa
// ---------------------------------------------------------------------
function viewHome() {
  const done = completedAudits();
  const ym = todayISO().slice(0, 7);
  const thisMonth = done.filter(a => isoDayTZ.format(toDate(a.completedAt)).slice(0, 7) === ym);
  const open = done.filter(a => statusOf(a).k === 'acik');
  const okRate = thisMonth.length ? Math.round(100 * thisMonth.filter(a => a.result === 'uygun').length / thisMonth.length) : null;
  const drafts = myDrafts();
  const storesCount = [...S.stores.values()].filter(s => s.active !== false).length;
  return `
  <div class="page-head"><div><h1>Merhaba, ${esc(S.user.name)}</h1>
    <p class="muted"><span data-clock></span> · ${isAdmin() ? 'Yönetici' : 'Denetçi'}</p></div>
    <a class="btn primary" href="#/denetim">+ Yeni Denetim</a></div>
  <div class="stats">
    <div class="stat"><b>${thisMonth.length}</b><span>Bu ay tamamlanan denetim</span></div>
    <div class="stat"><b>${open.length}</b><span>Aksiyon bekleyen rapor</span></div>
    <div class="stat"><b>${okRate == null ? '—' : '%' + okRate}</b><span>Bu ay uygun oranı</span></div>
    <div class="stat"><b>${storesCount}</b><span>${isAdmin() ? 'Aktif mağaza' : 'Yetkili mağazanız'}</span></div>
  </div>
  ${drafts.length ? `<div class="card"><div class="card-head"><h3>Devam eden denetimleriniz</h3></div><div class="list">
    ${drafts.map(draftItem).join('')}</div></div>` : ''}
  ${!isAdmin() && !storesCount ? `<div class="card empty">Size henüz mağaza yetkisi verilmemiş. Yöneticinize başvurun.</div>` : ''}
  <div class="card"><div class="card-head"><h3>Son raporlar</h3><a href="#/raporlar" class="small">Tümü →</a></div>
    <div class="list">${done.slice(0, 6).map(reportItem).join('') || `<div class="empty">Henüz tamamlanmış denetim yok.</div>`}</div></div>`;
}

function draftItem(a) {
  return `<div class="item"><div class="item-main"><div class="item-title">${esc(a.storeName)}</div>
    <div class="item-sub">Başlangıç: ${fmtDT(a.startedAt)} · ${a.answeredCount}/${a.questionCount} soru</div></div>
    <a class="btn dark sm" href="#/denetim/${a.id}">Devam et</a>
    <button class="btn danger-ghost sm" data-act="draft-del" data-id="${a.id}">Sil</button></div>`;
}

function reportItem(a) {
  const st = statusOf(a);
  return `<a class="item" href="#/rapor/${a.id}"><div class="item-main">
    <div class="item-title">${esc(a.storeName)} <span class="muted small mono">· ${reportNo(a.reportSeq)}</span></div>
    <div class="item-sub">${esc(a.storeRegion || '')}${a.storeRegion ? ' · ' : ''}${esc(a.auditorName)} · ${fmtDT(a.completedAt)}</div></div>
    <div class="row">${gpsBadge(a)}<span class="badge ${st.c}">${st.t}</span>${a.noCount ? `<span class="badge gray">${a.noCount} hayır</span>` : ''}</div></a>`;
}

// ---------------------------------------------------------------------
//  Denetim başlatma
// ---------------------------------------------------------------------
function viewAuditStart() {
  const stores = sortedStores(true);
  const drafts = myDrafts();
  const regions = [...new Set(stores.map(s => s.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  const qCount = S.questions.filter(q => q.active !== false).length;
  return `
  <div class="page-head"><div><h1>Denetim</h1><p class="muted">Mağaza seçerek denetim başlatın. Saat: <b data-clock></b></p></div></div>
  ${!qCount ? `<div class="gps warn" style="margin-bottom:14px"><span class="gps-ico">!</span><div><b>Aktif denetim sorusu yok</b>${isAdmin() ? 'Yönetim › Sorular bölümünden soru ekleyin.' : 'Yöneticinizin soru eklemesi gerekiyor.'}</div></div>` : ''}
  ${drafts.length ? `<div class="card"><div class="card-head"><h3>Devam eden denetimleriniz</h3></div><div class="list">${drafts.map(draftItem).join('')}</div></div>` : ''}
  <div class="card">
    <div class="filters">
      <input type="search" id="stSearch" placeholder="Mağaza ara…" aria-label="Mağaza ara">
      <select id="stRegion" aria-label="Bölge"><option value="">Tüm bölgeler</option>${regions.map(r => `<option>${esc(r)}</option>`).join('')}</select>
    </div>
    <div class="list" id="stList">${stores.map(s => `
      <div class="item" data-store-row data-name="${esc(trLower(s.name + ' ' + (s.code || '')))}" data-region="${esc(s.region || '')}">
        <div class="item-main"><div class="item-title">${esc(s.name)} ${s.code ? `<span class="muted small">(${esc(s.code)})</span>` : ''}</div>
        <div class="item-sub">${esc(s.region || 'Bölge yok')} · ${hasCoord(s) ? 'Koordinat kayıtlı' : '<span class="overdue">Koordinat yok</span>'}</div></div>
        <button class="btn primary sm" data-act="audit-start" data-id="${s.id}" ${qCount ? '' : 'disabled'}>Denetim Başlat</button></div>`).join('')
      || `<div class="empty">${isAdmin() ? 'Henüz mağaza eklenmemiş. Yönetim › Mağazalar bölümünden ekleyin.' : 'Size yetkilendirilmiş mağaza yok.'}</div>`}</div>
  </div>`;
}
function filterStoreList() {
  const q = trLower($('#stSearch')?.value), rg = $('#stRegion')?.value || '';
  $$('[data-store-row]').forEach(el => { el.hidden = !(el.dataset.name.includes(q) && (!rg || el.dataset.region === rg)); });
}

async function startAudit(storeId, btn) {
  const st = S.stores.get(storeId);
  if (!st) return toast('Mağaza bulunamadı.', 'error');
  const existing = myDrafts().find(d => d.storeId === storeId);
  if (existing) {
    const cont = await confirmDlg({ title: 'Devam eden denetim var', message: `${st.name} için ${fmtDT(existing.startedAt)} tarihinde başlattığınız bir taslak var. Ona devam etmek ister misiniz?`, ok: 'Taslağa devam et', cancel: 'Yeni başlat' });
    if (cont) return go('denetim/' + existing.id);
  }
  const ok = await confirmDlg({ title: 'Denetim başlat', message: `${st.name} mağazasında denetim başlatılacak.\nBaşlangıç saati sunucu tarafından kaydedilir ve konumunuz kontrol edilir.`, ok: 'Başlat' });
  if (!ok) return;
  try {
    const r = await withBtn(btn, () => api('audit_start', { storeId }), 'Başlatılıyor…');
    toast('Denetim başlatıldı.', 'success');
    reload();
    go('denetim/' + r.id);
  } catch (err) { toast(errMsg(err), 'error'); }
}

// ---------------------------------------------------------------------
//  Denetim formu
// ---------------------------------------------------------------------
async function openAuditForm(id) {
  const v = $('#view');
  if (S.draft?.id !== id) {
    v.innerHTML = `<div class="card empty"><span class="spinner"></span><p>Denetim yükleniyor…</p></div>`;
    if (S.draft && (S.savePending || S.saving)) await flushSave();
    try {
      const a = (await api('audit', null, { get: { id } })).audit;
      if (a.status === 'completed') return go('rapor/' + id);
      if (a.auditorId !== S.user.id) { v.innerHTML = `<div class="card empty">Bu taslak başka bir denetçiye ait.</div>`; return; }
      S.draft = a; S.gps = { state: 'idle' }; S.saveError = false; S.lastSaved = null;
    } catch (err) { v.innerHTML = `<div class="card empty">${esc(errMsg(err))}</div>`; return; }
  }
  if (route().b !== id) return;
  v.innerHTML = viewAuditForm();
  S.renderedSettingsKey = JSON.stringify(S.settings);
  tickClock();
  if (S.gps.state === 'idle') checkGps();
}

function viewAuditForm() {
  const d = S.draft;
  let lastCat = null, n = 0;
  const body = d.questions.map(q => {
    let head = '';
    if (q.categoryName !== lastCat) { lastCat = q.categoryName; head = `<div class="cat-title">${esc(q.categoryName)}</div>`; }
    n++;
    const av = d.answers[q.id]?.a;
    return head + `<div class="q${av === 'yes' ? ' ans-yes' : av === 'no' ? ' ans-no' : ''}" id="q-${q.id}">${questionInner(q, n)}</div>`;
  }).join('');
  return `
  <div class="card audit-head">
    <div class="row between"><div><h2 style="margin:0">${esc(d.storeName)}</h2>
      <div class="muted small">${esc(d.storeRegion || '')}</div></div>
      <a class="btn ghost sm" href="#/denetim">← Mağazalar</a></div>
    <dl class="kv">
      <div><dt>Denetçi</dt><dd>${esc(d.auditorName)}</dd></div>
      <div><dt>Başlangıç (sunucu)</dt><dd class="mono">${fmtDT(d.startedAt)}</dd></div>
      <div><dt>Şu an</dt><dd class="mono"><span data-clock></span></dd></div>
    </dl>
    <div id="gpsBox">${gpsBoxHtml()}</div>
  </div>
  ${body}
  <div class="row" style="justify-content:center;margin-top:16px"><button class="btn danger-ghost sm" data-act="draft-del" data-id="${d.id}">Taslağı sil</button></div>
  <div class="bottombar" id="auditBar">${auditBarHtml()}</div>`;
}

function questionInner(q, n) {
  const d = S.draft, a = d.answers[q.id] || {};
  if (n == null) n = d.questions.findIndex(x => x.id === q.id) + 1;
  const cfg = S.settings;
  const photos = a.photos || [];
  return `
    <div class="q-text"><span class="q-num">${n}.</span>${esc(q.text)}</div>
    <div class="yn">
      <button type="button" class="yes ${a.a === 'yes' ? 'on' : ''}" data-act="ans" data-q="${q.id}" data-v="yes" aria-pressed="${a.a === 'yes'}">Evet</button>
      <button type="button" class="no ${a.a === 'no' ? 'on' : ''}" data-act="ans" data-q="${q.id}" data-v="no" aria-pressed="${a.a === 'no'}">Hayır</button>
    </div>
    ${a.a === 'no' ? `<div class="no-detail">
      <label class="field">Açıklama / not<textarea data-field="note" data-q="${q.id}" placeholder="Tespit edilen durumu yazın…">${esc(a.note || '')}</textarea></label>
      <div><div class="field" style="margin-bottom:6px">Fotoğraflar ${cfg.photoRequiredOnNo ? '<span class="req">* zorunlu</span>' : '<span class="hint">(isteğe bağlı)</span>'}</div>
        <div class="thumbs">${photos.map(pid => `<div class="thumb"><img src="${photoUrl(pid)}" alt="Fotoğraf" data-act="zoom" loading="lazy">
          <button class="del" data-act="photo-del" data-q="${q.id}" data-pid="${pid}" aria-label="Fotoğrafı sil">×</button></div>`).join('')}
          <span id="up-${q.id}"></span>
          ${photos.length < 10 ? `<label class="add-photo">＋<br>Fotoğraf<input type="file" accept="image/*" multiple data-photo-q="${q.id}"></label>` : ''}
        </div></div>
      ${cfg.actionOnNo ? `<div class="form-grid">
        <label class="field">Aksiyon (yapılacak iş)<input type="text" data-field="action" data-q="${q.id}" value="${esc(a.action || '')}" placeholder="Örn. Vitrin düzeni yenilenecek"></label>
        <label class="field">Termin <span class="req">*</span><input type="date" data-field="due" data-q="${q.id}" value="${esc(a.due || '')}" min="${todayISO()}"></label>
      </div>` : ''}
    </div>` : ''}`;
}

function rerenderQuestion(qid) {
  const el = $('#q-' + qid); if (!el) return;
  const q = S.draft.questions.find(x => x.id === qid);
  el.innerHTML = questionInner(q);
  const a = S.draft.answers[qid];
  el.className = 'q' + (a?.a === 'yes' ? ' ans-yes' : a?.a === 'no' ? ' ans-no' : '');
  const bar = $('#auditBar'); if (bar) bar.innerHTML = auditBarHtml();
}

function refreshAuditBits() {
  if (!S.draft) return;
  const key = JSON.stringify(S.settings);
  if (key !== S.renderedSettingsKey) {
    S.renderedSettingsKey = key;
    S.draft.questions.forEach(q => {
      if (S.draft.answers[q.id]?.a === 'no' && !$('#q-' + q.id)?.contains(document.activeElement)) rerenderQuestion(q.id);
    });
  }
  if (S.gps.state === 'done') {
    S.gps = { ...S.gps, ...evalGps(S.gps.raw, S.stores.get(S.draft.storeId)) };
    const box = $('#gpsBox'); if (box) box.innerHTML = gpsBoxHtml();
  }
  const bar = $('#auditBar'); if (bar) bar.innerHTML = auditBarHtml();
}

function auditBarHtml() {
  const d = S.draft; if (!d) return '';
  const total = d.questions.length, answered = d.questions.filter(q => d.answers[q.id]?.a).length;
  const pct = total ? Math.round(100 * answered / total) : 0;
  const ss = S.saveError ? `<span class="save-state err">Kaydedilemedi — tekrar denenecek</span>`
    : S.saving || S.savePending ? `<span class="save-state">Kaydediliyor…</span>`
    : S.lastSaved ? `<span class="save-state">✓ Buluta kaydedildi ${tf.format(S.lastSaved)}</span>` : `<span class="save-state">Cevaplar otomatik olarak buluta kaydedilir</span>`;
  const blocked = S.settings.blockOutside && S.gps.state === 'done' && !S.gps.within;
  return `<div class="prog"><div class="small"><b>${answered}/${total}</b> soru · ${ss}</div><div class="progress"><i style="width:${pct}%"></i></div></div>
    <button class="btn primary" data-act="audit-complete" ${blocked ? 'disabled title="Mağaza dışında tamamlama engelli"' : ''}>Denetimi Tamamla</button>`;
}

function setAnswerField(qid, field, value) {
  const a = S.draft.answers[qid] || (S.draft.answers[qid] = {});
  a[field] = value;
  scheduleSave();
}
function scheduleSave() {
  S.savePending = true;
  const bar = $('#auditBar'); if (bar) bar.innerHTML = auditBarHtml();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveDraft, 800);
}
async function saveDraft() {
  if (!S.draft) return;
  if (S.saving) { S.saveTimer = setTimeout(saveDraft, 400); return; }
  S.saving = true; S.savePending = false;
  const id = S.draft.id;
  try {
    const r = await api('audit_save', { id, answers: S.draft.answers });
    S.lastSaved = new Date(r.savedAt); S.saveError = false;
  } catch (err) {
    S.saveError = true; S.savePending = true;
    toast('Cevaplar kaydedilemedi: ' + errMsg(err), 'error');
    clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveDraft, 5000);
  } finally {
    S.saving = false;
    if (S.draft?.id === id) { const bar = $('#auditBar'); if (bar) bar.innerHTML = auditBarHtml(); }
  }
}
async function flushSave() {
  clearTimeout(S.saveTimer);
  while (S.saving) await new Promise(r => setTimeout(r, 150));
  if (S.savePending) await saveDraft();
  return !S.saveError;
}

async function setAnswer(qid, v) {
  const a = S.draft.answers[qid] || {};
  if (a.a === v) return;
  if (v === 'yes' && ((a.photos || []).length || a.note || a.action)) {
    const ok = await confirmDlg({ title: 'Cevabı "Evet" yap', message: 'Bu soruya eklenen not, aksiyon ve fotoğraflar silinecek. Devam edilsin mi?', ok: 'Evet olarak değiştir', danger: true });
    if (!ok) return;
    for (const pid of (a.photos || [])) await api('photo_del', { id: pid }).catch(() => {});
  }
  S.draft.answers[qid] = v === 'yes' ? { a: 'yes' } : { ...a, a: 'no' };
  $('#q-' + qid)?.classList.remove('invalid');
  rerenderQuestion(qid);
  scheduleSave();
}

// ---------- Fotoğraflar ----------
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Görsel okunamadı')); };
    img.src = url;
  });
}
async function compressImage(file, maxChars = 900_000) {
  const img = await loadImage(file);
  let dim = 1600, q = 0.78, out;
  for (let i = 0; i < 8; i++) {
    const scale = Math.min(1, dim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/jpeg', q);
    if (out.length < maxChars) return out;
    if (q > 0.5) q -= 0.1; else dim = Math.round(dim * 0.8);
  }
  if (out.length < maxChars) return out;
  throw new Error('Fotoğraf çok büyük, sıkıştırılamadı.');
}
async function addPhotos(qid, files) {
  const d = S.draft, aid = d.id;
  const a = d.answers[qid] || (d.answers[qid] = { a: 'no' });
  a.photos = a.photos || [];
  const list = [...files].slice(0, Math.max(0, 10 - a.photos.length));
  if (files.length > list.length) toast('Bir soruya en fazla 10 fotoğraf eklenebilir.', 'warn');
  let okCount = 0;
  for (const f of list) {
    const slot = $('#up-' + qid);
    if (slot) slot.innerHTML = `<div class="thumb"><span class="spinner sm"></span></div>`;
    try {
      const data = await compressImage(f);
      const r = await api('photo_add', { auditId: aid, qid, data });
      a.photos.push(r.id);
      okCount++;
    } catch (err) { toast('Fotoğraf yüklenemedi: ' + errMsg(err), 'error'); }
  }
  if (S.draft?.id === aid) {
    rerenderQuestion(qid);
    if (okCount) { scheduleSave(); toast(`${okCount} fotoğraf buluta yüklendi.`, 'success', 2500); }
  }
}

// ---------- GPS ----------
function getPosition() {
  return new Promise((res, rej) => {
    if (!window.isSecureContext) return rej({ code: 'insecure' });
    if (!navigator.geolocation) return rej({ code: 'nosupport' });
    navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
  });
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function evalGps(raw, st) {
  const { lat, lng, accuracy, timestamp } = raw;
  const hc = hasCoord(st);
  const dist = hc ? haversine(lat, lng, st.lat, st.lng) : null;
  const within = hc && dist <= S.settings.maxDistanceM;
  const accOk = accuracy <= S.settings.maxAccuracyM;
  return { lat, lng, accuracy, capturedAt: timestamp, hasCoord: hc, dist, within, accOk, verified: hc && within && accOk };
}
async function checkGps() {
  if (!S.draft) return S.gps;
  const aid = S.draft.id;
  S.gps = { state: 'loading' };
  const box = $('#gpsBox'); if (box) box.innerHTML = gpsBoxHtml();
  try {
    const p = await getPosition();
    const raw = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: Math.round(p.timestamp || Date.now()) };
    if (S.draft?.id !== aid) return S.gps;
    S.gps = { state: 'done', raw, ...evalGps(raw, S.stores.get(S.draft.storeId)) };
  } catch (e) {
    S.gps = { state: 'error', code: e.code };
  }
  const b2 = $('#gpsBox'); if (b2) b2.innerHTML = gpsBoxHtml();
  const bar = $('#auditBar'); if (bar) bar.innerHTML = auditBarHtml();
  return S.gps;
}
function gpsBoxHtml() {
  const g = S.gps, cfg = S.settings;
  const retry = `<button class="btn ghost sm" data-act="gps-retry" style="margin-top:8px">Konumu yenile</button>`;
  if (g.state === 'idle' || g.state === 'loading')
    return `<div class="gps wait"><span class="spinner sm"></span><div><b>Konum alınıyor…</b>Cihazın GPS konumu isteniyor. İzin sorulursa "İzin ver"e dokunun.</div></div>`;
  if (g.state === 'error') {
    const m = {
      1: ['Konum izni verilmedi', 'GPS doğrulaması yapılamaz ve denetim tamamlanamaz. Tarayıcı / telefon ayarlarından bu site için konum iznini açın, ardından "Konumu yenile"ye basın.'],
      2: ['Konum alınamadı', 'GPS sinyali bulunamadı. Telefonun konum servisinin açık olduğundan emin olun.'],
      3: ['Konum zaman aşımı', 'Konum belirlenemedi. Açık bir alana yaklaşıp tekrar deneyin.'],
      insecure: ['Güvenli bağlantı gerekli', 'Konum yalnızca https:// ile açılan sayfalarda çalışır.'],
      nosupport: ['Cihaz konum desteklemiyor', 'Bu tarayıcı konum bilgisini desteklemiyor.']
    }[g.code] || ['Konum alınamadı', 'Bilinmeyen bir hata oluştu.'];
    return `<div class="gps err"><span class="gps-ico">⚠</span><div><b>${m[0]}</b>${m[1]}<br>${retry}</div></div>`;
  }
  const coords = `<div class="small mono" style="opacity:.8">${g.lat.toFixed(6)}, ${g.lng.toFixed(6)} · ±${Math.round(g.accuracy)} m · ${tf.format(new Date(g.capturedAt))}</div>`;
  if (g.verified)
    return `<div class="gps ok"><span class="gps-ico">✓</span><div><b>GPS Onaylı</b>Mağazaya uzaklık ${fmtM(g.dist)} (sınır ${fmtM(cfg.maxDistanceM)}).${coords}${retry}</div></div>`;
  if (!g.hasCoord)
    return `<div class="gps warn"><span class="gps-ico">!</span><div><b>Mağazanın kayıtlı koordinatı yok</b>Konumunuz alındı ancak karşılaştırılacak mağaza koordinatı olmadığı için GPS onayı verilemez.${cfg.blockOutside ? ' Mesafe sınırı zorunlu olduğundan denetim tamamlanamaz; yöneticiye bildirin.' : ''}${coords}${retry}</div></div>`;
  if (!g.within)
    return `<div class="gps ${cfg.blockOutside ? 'err' : 'warn'}"><span class="gps-ico">⚠</span><div><b>Mağaza dışındasınız</b>Mağazaya uzaklık ${fmtM(g.dist)}, izin verilen ${fmtM(cfg.maxDistanceM)}.${cfg.blockOutside ? ' Bu konumdan denetim tamamlanamaz.' : ' Denetim GPS onaysız olarak kaydedilir.'}${coords}${retry}</div></div>`;
  return `<div class="gps warn"><span class="gps-ico">!</span><div><b>Konum hassasiyeti düşük</b>Mağaza mesafesi uygun (${fmtM(g.dist)}) ancak hassasiyet ±${Math.round(g.accuracy)} m (gereken ≤ ${cfg.maxAccuracyM} m). Açık alana yaklaşıp konumu yenileyin.${coords}${retry}</div></div>`;
}

// ---------- Tamamlama ----------
async function completeAudit(btn) {
  const d = S.draft; if (!d) return;
  const cfg = S.settings;
  const problems = [];
  $$('.q.invalid').forEach(el => el.classList.remove('invalid'));
  for (const q of d.questions) {
    const a = d.answers[q.id];
    let badMsg = null;
    if (!a?.a) badMsg = 'cevaplanmadı';
    else if (a.a === 'no') {
      if (cfg.photoRequiredOnNo && !(a.photos || []).length) badMsg = 'fotoğraf eksik';
      else if (cfg.actionOnNo && !a.due) badMsg = 'termin eksik';
    }
    if (badMsg) { problems.push({ q, badMsg }); $('#q-' + q.id)?.classList.add('invalid'); }
  }
  if (problems.length) {
    const first = problems[0];
    $('#q-' + first.q.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast(`${problems.length} soruda eksik var (ilk: "${first.q.text.slice(0, 40)}…" ${first.badMsg}).`, 'warn', 6000);
  }
  btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span> Konum doğrulanıyor…';
  const reset = () => { if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Denetimi Tamamla'; } };
  const g = await checkGps();
  if (g.state !== 'done') { reset(); return toast('Denetim konum alınmadan tamamlanamaz. Konum iznini açıp tekrar deneyin.', 'error', 7000); }
  if (cfg.blockOutside && !g.within) { reset(); return toast(`Mağaza dışında (${g.hasCoord ? fmtM(g.dist) : 'koordinat yok'}) denetim tamamlanamaz.`, 'error', 7000); }
  if (!g.verified) {
    const why = !g.hasCoord ? 'mağazanın kayıtlı koordinatı yok' : !g.within ? `mağazaya uzaklık ${fmtM(g.dist)}` : `konum hassasiyeti ±${Math.round(g.accuracy)} m`;
    const go2 = await confirmDlg({ title: 'GPS onayı yok', message: `Denetim "GPS onaysız" olarak kaydedilecek (${why}). Raporda bu durum görünecek.\nYine de tamamlansın mı?`, ok: 'GPS onaysız tamamla', danger: true });
    if (!go2) return reset();
  }
  const noCount = d.questions.filter(q => d.answers[q.id].a === 'no').length;
  const sure = await confirmDlg({ title: 'Denetimi tamamla', message: `${d.storeName} · ${d.questions.length - noCount} Evet, ${noCount} Hayır.\nTamamlanan denetim değiştirilemez ve rapor numarası verilir.`, ok: 'Tamamla' });
  if (!sure) return reset();
  if (btn.isConnected) btn.innerHTML = '<span class="spinner sm"></span> Kaydediliyor…';
  clearTimeout(S.saveTimer);
  while (S.saving) await new Promise(r => setTimeout(r, 150));
  try {
    const r = await api('audit_complete', { id: d.id, answers: d.answers, location: { lat: g.lat, lng: g.lng, accuracy: g.accuracy, capturedAt: g.capturedAt } });
    S.savePending = false; S.draft = null; S.gps = { state: 'idle' };
    toast(`Denetim tamamlandı. Rapor No: ${reportNo(r.reportSeq)}${r.gpsVerified ? ' · GPS Onaylı' : ''}`, 'success', 6000);
    await reload();
    go('rapor/' + d.id);
  } catch (err) {
    reset();
    toast(errMsg(err), 'error', 8000);
  }
}

async function deleteDraft(id) {
  const a = getAudit(id) || (S.draft?.id === id ? S.draft : null);
  const ok = await confirmDlg({ title: 'Taslağı sil', message: `${a?.storeName || 'Bu'} denetim taslağı ve eklenen fotoğraflar kalıcı olarak silinecek.`, ok: 'Sil', danger: true });
  if (!ok) return;
  try {
    await api('audit_delete', { id });
    if (S.draft?.id === id) { clearTimeout(S.saveTimer); S.savePending = false; S.draft = null; }
    toast('Taslak silindi.', 'success');
    await reload();
    if (route().a === 'denetim' && route().b === id) go('denetim'); else render();
  } catch (err) { toast(errMsg(err), 'error'); }
}

// ---------------------------------------------------------------------
//  Raporlar
// ---------------------------------------------------------------------
function filteredReports() {
  const f = S.filters, q = trLower(f.q);
  return completedAudits().filter(a => {
    if (f.store && a.storeId !== f.store) return false;
    if (f.auditor && a.auditorId !== f.auditor) return false;
    if (f.status && statusOf(a).k !== f.status) return false;
    const day = isoDayTZ.format(toDate(a.completedAt));
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (q && !trLower(`${a.storeName} ${a.storeRegion} ${a.auditorName} ${reportNo(a.reportSeq)}`).includes(q)) return false;
    return true;
  });
}
function reportListHtml() {
  const list = filteredReports();
  return `<div class="small muted" style="margin-bottom:8px">${list.length} rapor</div>` +
    (list.map(reportItem).join('') || `<div class="empty">Filtreye uygun rapor yok.</div>`);
}
function viewReports() {
  const f = S.filters, done = completedAudits();
  const stores = [...new Map(done.map(a => [a.storeId, a.storeName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'tr'));
  const auditors = [...new Map(done.map(a => [a.auditorId, a.auditorName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'tr'));
  return `
  <div class="page-head"><div><h1>Raporlar</h1><p class="muted">${isAdmin() ? 'Tüm tamamlanan denetimler' : 'Tamamladığınız denetimler'}</p></div></div>
  <div class="card">
    <div class="filters">
      <input type="search" data-filter="q" value="${esc(f.q)}" placeholder="Ara: mağaza, denetçi, rapor no…" aria-label="Ara">
      <select data-filter="store" aria-label="Mağaza"><option value="">Tüm mağazalar</option>${stores.map(([id, n]) => `<option value="${esc(id)}" ${f.store === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      ${isAdmin() ? `<select data-filter="auditor" aria-label="Denetçi"><option value="">Tüm denetçiler</option>${auditors.map(([id, n]) => `<option value="${esc(id)}" ${f.auditor === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
      <select data-filter="status" aria-label="Durum"><option value="">Tüm durumlar</option>
        ${[['uygun', 'Uygun'], ['acik', 'Aksiyon bekliyor'], ['kapandi', 'Aksiyon kapandı']].map(([k, t]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label class="field">Başlangıç<input type="date" data-filter="from" value="${esc(f.from)}"></label>
      <label class="field">Bitiş<input type="date" data-filter="to" value="${esc(f.to)}"></label>
    </div>
    <div class="list" id="repList">${reportListHtml()}</div>
  </div>`;
}

const reportCache = new Map();
async function openReport(id, fromData = false) {
  const v = $('#view');
  const summary = getAudit(id);
  let a = reportCache.get(id);
  const stale = !a || (summary && (summary.actionStatus !== a.actionStatus || summary.status !== a.status));
  if (stale) {
    if (!fromData || !a) v.innerHTML = `<div class="card empty"><span class="spinner"></span><p>Rapor yükleniyor…</p></div>`;
    try { a = (await api('audit', null, { get: { id } })).audit; reportCache.set(id, a); }
    catch (err) {
      if (route().a === 'rapor' && route().b === id)
        v.innerHTML = `<div class="card empty"><h3>${err.status === 403 ? 'Erişim engellendi' : 'Rapor açılamadı'}</h3><p>${esc(errMsg(err))}</p></div>`;
      return;
    }
  } else if (fromData) return;
  if (route().a !== 'rapor' || route().b !== id) return;
  if (a.status !== 'completed') { if (a.auditorId === S.user.id) return go('denetim/' + id); v.innerHTML = `<div class="card empty">Bu denetim henüz tamamlanmamış.</div>`; return; }
  const y = window.scrollY;
  v.innerHTML = viewReport(a);
  if (fromData) window.scrollTo(0, y);
}

function viewReport(a) {
  const st = statusOf(a);
  const total = a.questions.length;
  const score = total ? Math.round(100 * (a.yesCount || 0) / total) : 0;
  const today = todayISO();
  let lastCat = null, n = 0;
  const qs = a.questions.map(q => {
    const ans = a.answers?.[q.id] || {};
    let head = '';
    if (q.categoryName !== lastCat) { lastCat = q.categoryName; head = `${n ? '</div>' : ''}<div class="card"><h3>${esc(q.categoryName)}</h3>`; }
    n++;
    const late = ans.due && ans.due < today && a.actionStatus === 'acik';
    return head + `<div class="rep-q"><div class="row between"><div style="flex:1;min-width:200px"><span class="q-num">${n}.</span>${esc(q.text)}</div>
      <span class="badge ${ans.a === 'yes' ? 'green' : ans.a === 'no' ? 'red' : 'gray'}">${ans.a === 'yes' ? 'Evet' : ans.a === 'no' ? 'Hayır' : '—'}</span></div>
      ${ans.a === 'no' ? `
        ${ans.note ? `<div class="rep-note">${esc(ans.note)}</div>` : ''}
        ${(ans.action || ans.due) ? `<div class="rep-action"><b>Aksiyon:</b> ${esc(ans.action || '—')} · <b>Termin:</b> <span class="${late ? 'overdue' : ''}">${fmtDay(ans.due)}${late ? ' (gecikmiş)' : ''}</span></div>` : ''}
        ${(ans.photos || []).length ? `<div class="thumbs" style="margin-top:8px">${ans.photos.map(pid => `<div class="thumb"><img src="${photoUrl(pid)}" alt="Fotoğraf" data-act="zoom"></div>`).join('')}</div>` : ''}` : ''}
    </div>`;
  }).join('') + (n ? '</div>' : '');
  const loc = a.location;
  return `
  <div class="row between no-print" style="margin-bottom:12px">
    <a class="btn ghost sm" href="#/raporlar">← Raporlar</a>
    <div class="row"><button class="btn ghost sm" data-act="print">Yazdır / PDF</button>
    <button class="btn dark sm" data-act="share" data-id="${a.id}">Paylaş</button></div></div>
  <div class="print-only" style="margin-bottom:10px"><span class="brand-mark">JİBER</span> <b>Saha Denetim ve Kalite Raporu</b></div>
  <div class="card">
    <div class="row between"><div><div class="muted small mono">${reportNo(a.reportSeq)}</div><h1 style="margin:2px 0">${esc(a.storeName)}</h1>
      <div class="muted">${esc(a.storeRegion || '')}</div></div>
      <div style="text-align:right"><div class="score">%${score}</div><div class="row" style="justify-content:flex-end"><span class="badge ${st.c}">${st.t}</span>${gpsBadge(a)}</div></div></div>
    <div class="divider"></div>
    <dl class="kv">
      <div><dt>Denetçi</dt><dd>${esc(a.auditorName)}</dd></div>
      <div><dt>Başlangıç</dt><dd class="mono">${fmtDT(a.startedAt)}</dd></div>
      <div><dt>Tamamlanma</dt><dd class="mono">${fmtDT(a.completedAt)}</dd></div>
      <div><dt>Sonuç</dt><dd>${a.yesCount} Evet · ${a.noCount} Hayır</dd></div>
      <div><dt>Konum</dt><dd class="mono">${loc ? `<a href="https://www.google.com/maps?q=${loc.lat},${loc.lng}" target="_blank" rel="noopener">${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}</a>` : '—'}</dd></div>
      <div><dt>Konum doğruluğu</dt><dd>${loc ? '±' + Math.round(loc.accuracy) + ' m' : '—'}</dd></div>
      <div><dt>Konum alınma zamanı</dt><dd class="mono">${loc ? fmtDT(loc.capturedAt) : '—'}</dd></div>
      <div><dt>Mağazaya uzaklık</dt><dd>${a.distanceM == null ? 'Mağaza koordinatı yok' : fmtM(a.distanceM)}</dd></div>
    </dl>
    <p class="hint" style="margin-top:8px">Tarih-saat bilgileri sunucu tarafından kaydedilmiştir (Türkiye saati). GPS onayı ve mesafe sunucuda hesaplanmıştır. Konum alınma zamanı cihazın GPS kaydından gelir.</p>
  </div>
  ${a.result === 'aksiyon' ? actionPanel(a) : ''}
  ${qs}`;
}

function actionPanel(a) {
  const closed = a.actionStatus === 'kapandi';
  return `<div class="card"><div class="card-head"><h3>Aksiyon durumu</h3><span class="badge ${closed ? 'blue' : 'amber'}">${closed ? 'Aksiyon kapandı' : 'Aksiyon bekliyor'}</span></div>
    ${a.actionAt ? `<p class="small muted">Son güncelleme: ${esc(a.actionBy || '')} · ${fmtDT(a.actionAt)}</p>` : ''}
    ${a.actionNote ? `<div class="rep-note">${esc(a.actionNote)}</div>` : ''}
    ${isAdmin() ? `<div class="row no-print" style="margin-top:10px">
      ${closed ? `<button class="btn ghost sm" data-act="action-set" data-id="${a.id}" data-v="acik">Aksiyonu yeniden aç</button>`
               : `<button class="btn primary sm" data-act="action-set" data-id="${a.id}" data-v="kapandi">Aksiyonu kapat</button>`}</div>` : ''}</div>`;
}

function setActionStatus(id, v) {
  const a = reportCache.get(id);
  openModal(`<h3>${v === 'kapandi' ? 'Aksiyonu kapat' : 'Aksiyonu yeniden aç'}</h3>
    <form id="acForm" style="display:grid;gap:12px;margin-top:10px">
      <label class="field">Not<textarea name="note" placeholder="Yapılan işlem / açıklama">${esc(a?.actionNote || '')}</textarea></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary">Kaydet</button></div></form>`);
  $('#acForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await withBtn($('#acForm .btn.primary'), () => api('action_set', { id, status: v, note: e.target.note.value.trim() }));
      closeModal(true); reportCache.delete(id); toast('Aksiyon durumu güncellendi.', 'success');
      await reload(); render();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

async function shareReport(id) {
  const a = reportCache.get(id) || getAudit(id);
  const url = location.origin + location.pathname + '#/rapor/' + id;
  const title = `Denetim Raporu ${reportNo(a?.reportSeq)} – ${a?.storeName || ''}`;
  if (navigator.share) {
    try { await navigator.share({ title, text: title, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Rapora özel bağlantı kopyalandı. Bağlantı yalnızca yetkili kullanıcılar giriş yaptığında açılır.', 'success', 6000);
  } catch {
    openModal(`<h3>Rapor bağlantısı</h3><p class="muted">Bağlantıyı kopyalayın. Yalnızca yetkili kullanıcılar giriş yaparak açabilir.</p>
      <input type="text" readonly value="${esc(url)}" onclick="this.select()" style="margin-top:10px">
      <div class="modal-actions"><button class="btn primary" data-act="modal-close">Tamam</button></div>`);
  }
}

async function printReport(btn) {
  btn.disabled = true;
  const imgs = $$('#view img').filter(i => !i.complete);
  await Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; })));
  btn.disabled = false;
  window.print();
}

// ---------------------------------------------------------------------
//  Yönetim
// ---------------------------------------------------------------------
function viewAdmin(tab) {
  const tabs = [['kullanicilar', 'Kullanıcılar'], ['magazalar', 'Mağazalar'], ['sorular', 'Sorular'], ['ayarlar', 'Ayarlar']];
  const body = { kullanicilar: adminUsers, magazalar: adminStores, sorular: adminQuestions, ayarlar: adminSettings }[tab] || adminUsers;
  return `<div class="page-head"><h1>Yönetim</h1></div>
    <nav class="tabs">${tabs.map(([k, t]) => `<a href="#/yonetim/${k}" class="${k === tab ? 'active' : ''}">${t}</a>`).join('')}</nav>${body()}`;
}

async function adminCall(a, body, okMsg, btn) {
  try {
    const r = await withBtn(btn, () => api(a, body));
    if (okMsg) toast(okMsg, 'success');
    await reload();
    return r || true;
  } catch (err) { toast(errMsg(err), 'error', 6000); return null; }
}

// ---------- Kullanıcılar ----------
function adminUsers() {
  const users = [...S.users].sort((a, b) => (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) || a.name.localeCompare(b.name, 'tr'));
  return `<div class="card"><div class="card-head"><h3>Kullanıcılar (${users.length})</h3><button class="btn primary sm" data-act="user-new">+ Kullanıcı ekle</button></div>
    <div class="list">${users.map(u => `
      <div class="item"><div class="item-main"><div class="item-title">${esc(u.name)} ${u.id === S.user.id ? '<span class="badge gray">siz</span>' : ''}</div>
        <div class="item-sub">${esc(u.email)} · ${u.role === 'admin' ? 'Tüm mağazalar' : `${u.storeIds.length} mağaza`}</div></div>
        <div class="row"><span class="badge ${u.role === 'admin' ? 'navy' : 'blue'}">${u.role === 'admin' ? 'Yönetici' : 'Denetçi'}</span>
        ${u.active ? '' : '<span class="badge red">Pasif</span>'}
        <button class="btn ghost sm" data-act="user-edit" data-id="${u.id}">Düzenle</button>
        ${u.id !== S.user.id ? `<button class="btn danger-ghost sm" data-act="user-del" data-id="${u.id}">Sil</button>` : ''}</div></div>`).join('')}</div></div>`;
}

function userForm(u) {
  const isNew = !u;
  u = u || { name: '', email: '', role: 'auditor', storeIds: [], active: true };
  const self = u.id === S.user.id;
  const stores = sortedStores();
  openModal(`<h3>${isNew ? 'Yeni kullanıcı' : 'Kullanıcıyı düzenle'}</h3>
    <form id="uForm" style="display:grid;gap:12px;margin-top:10px" novalidate>
      <label class="field">Ad Soyad<input type="text" name="name" value="${esc(u.name)}" required></label>
      <label class="field">E-posta<input type="email" name="email" value="${esc(u.email)}" required></label>
      <label class="field">${isNew ? 'İlk şifre' : 'Yeni şifre (değiştirmek istemiyorsanız boş bırakın)'}<input type="text" name="pw" autocomplete="new-password">
        <span class="hint">En az 6 karakter.${isNew ? ' Kullanıcı daha sonra kendi şifresini değiştirebilir.' : ' Kullanıcı şifresini unuttuysa buradan yeni şifre verebilirsiniz.'}</span></label>
      <label class="field">Rol<select name="role" ${self ? 'disabled' : ''}>
        <option value="auditor" ${u.role === 'auditor' ? 'selected' : ''}>Denetçi</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Yönetici</option></select></label>
      <div id="storeBox" ${u.role === 'admin' ? 'hidden' : ''}>
        <div class="row between"><div class="field">Yetkili mağazalar</div>
          <div class="row"><button type="button" class="link-btn small" data-act="stores-all">Tümünü seç</button><button type="button" class="link-btn small" data-act="stores-none">Temizle</button></div></div>
        <div class="store-pick">${stores.map(s => `<label class="check"><input type="checkbox" name="store" value="${s.id}" ${u.storeIds.includes(s.id) ? 'checked' : ''}>
          <span>${esc(s.name)} <span class="muted small">${esc(s.region || '')}</span></span></label>`).join('') || '<span class="muted small">Önce mağaza ekleyin.</span>'}</div></div>
      <label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${self ? 'disabled' : ''}><span>Aktif (giriş yapabilir)</span></label>
      ${!isNew && S.mail ? `<button type="button" class="btn ghost sm" data-act="user-reset" data-id="${u.id}">Şifre sıfırlama e-postası gönder</button>` : ''}
      <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary" type="submit">Kaydet</button></div>
    </form>`);
  const f = $('#uForm');
  f.role.onchange = () => { $('#storeBox').hidden = f.role.value === 'admin'; };
  f.onsubmit = async e => {
    e.preventDefault();
    const role = self ? 'admin' : f.role.value;
    const body = {
      id: u.id, name: f.name.value.trim(), email: f.email.value.trim(), password: f.pw.value,
      role, active: self ? true : f.active.checked,
      storeIds: role === 'admin' ? [] : $$('input[name=store]:checked', f).map(i => i.value)
    };
    if (!body.name) return toast('Ad soyad girin.', 'warn');
    if (isNew && body.password.length < 6) return toast('İlk şifre en az 6 karakter olmalı.', 'warn');
    const r = await adminCall('user_save', body, isNew ? `${body.name} eklendi. Giriş bilgilerini kullanıcıya iletin.` : 'Kullanıcı güncellendi.', $('button[type=submit]', f));
    if (r) { closeModal(true); render(); }
  };
}

async function deleteUser(id) {
  const u = S.users.find(x => x.id === id); if (!u) return;
  const ok = await confirmDlg({ title: 'Kullanıcıyı sil', message: `${u.name} (${u.email}) silinecek ve portala giremeyecek.\nYaptığı denetim kayıtları raporlarda korunur.`, ok: 'Sil', danger: true });
  if (ok && await adminCall('user_delete', { id }, 'Kullanıcı silindi.')) render();
}

// ---------- Mağazalar ----------
function adminStores() {
  const stores = sortedStores();
  const regions = [...new Set(stores.map(s => s.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  let last = null;
  const rows = stores.map(s => {
    const head = s.region !== last ? (last = s.region, `<div class="cat-title">${esc(s.region || 'Bölge yok')}</div>`) : '';
    return head + `<div class="item"><div class="item-main"><div class="item-title">${esc(s.name)} ${s.code ? `<span class="muted small">(${esc(s.code)})</span>` : ''}</div>
      <div class="item-sub">${hasCoord(s) ? `<a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</a>` : '<span class="overdue">Koordinat yok — GPS onayı verilemez</span>'}${s.address ? ' · ' + esc(s.address) : ''}</div></div>
      <div class="row">${s.active === false ? '<span class="badge red">Pasif</span>' : ''}
      <button class="btn ghost sm" data-act="store-edit" data-id="${s.id}">Düzenle</button>
      <button class="btn danger-ghost sm" data-act="store-del" data-id="${s.id}">Sil</button></div></div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><h3>Mağazalar (${stores.length})</h3><button class="btn primary sm" data-act="store-new">+ Mağaza ekle</button></div>
    <div class="list">${rows || '<div class="empty">Henüz mağaza yok.</div>'}</div></div>
    <div class="card"><div class="card-head"><h3>Bölgeler</h3></div>
    <div class="list">${regions.map(r => `<div class="item"><div class="item-main"><div class="item-title">${esc(r)}</div><div class="item-sub">${stores.filter(s => s.region === r).length} mağaza</div></div>
      <button class="btn ghost sm" data-act="region-rename" data-region="${esc(r)}">Yeniden adlandır</button></div>`).join('') || '<div class="empty">Bölgeler mağaza eklerken tanımlanır.</div>'}</div></div>`;
}

function parseNum(v) { v = String(v ?? '').trim().replace(',', '.'); if (!v) return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; }

function storeForm(s) {
  const isNew = !s;
  s = s || { name: '', code: '', region: '', address: '', lat: null, lng: null, active: true };
  const regions = [...new Set([...S.stores.values()].map(x => x.region).filter(Boolean))];
  openModal(`<h3>${isNew ? 'Yeni mağaza' : 'Mağazayı düzenle'}</h3>
    <form id="sForm" style="display:grid;gap:12px;margin-top:10px" novalidate>
      <div class="form-grid">
        <label class="field">Mağaza adı<input type="text" name="name" value="${esc(s.name)}" required></label>
        <label class="field">Mağaza kodu<input type="text" name="code" value="${esc(s.code || '')}"></label>
        <label class="field">Bölge<input type="text" name="region" value="${esc(s.region || '')}" list="regionList" placeholder="Örn. Diyarbakır">
          <datalist id="regionList">${regions.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>
      </div>
      <label class="field">Adres<input type="text" name="address" value="${esc(s.address || '')}"></label>
      <div class="form-grid">
        <label class="field">Enlem (lat)<input type="text" inputmode="decimal" name="lat" value="${s.lat ?? ''}" placeholder="37.91441"></label>
        <label class="field">Boylam (lng)<input type="text" inputmode="decimal" name="lng" value="${s.lng ?? ''}" placeholder="40.23063"></label>
      </div>
      <p class="hint">Google Haritalar'da mağazaya sağ tıklayıp koordinatı kopyalayın ve Enlem alanına yapıştırın (iki değer otomatik ayrılır). Mağazadaysanız "Şu anki konumumu kullan"a basabilirsiniz.</p>
      <div class="row"><button type="button" class="btn ghost sm" data-act="store-here">📍 Şu anki konumumu kullan</button><span id="hereState" class="small muted"></span></div>
      <label class="check"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''}><span>Aktif (denetim yapılabilir)</span></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary" type="submit">Kaydet</button></div>
    </form>`, { wide: true });
  const f = $('#sForm');
  f.lat.addEventListener('input', () => {
    const m = f.lat.value.match(/^\s*(-?\d+[.,]\d+)\s*[,;\s]\s*(-?\d+[.,]\d+)\s*$/);
    if (m) { f.lat.value = m[1].replace(',', '.'); f.lng.value = m[2].replace(',', '.'); }
  });
  f.onsubmit = async e => {
    e.preventDefault();
    const lat = parseNum(f.lat.value), lng = parseNum(f.lng.value);
    if (!f.name.value.trim()) return toast('Mağaza adı girin.', 'warn');
    if ((lat == null) !== (lng == null)) return toast('Enlem ve boylamın ikisini birden girin.', 'warn');
    if (Number.isNaN(lat) || Number.isNaN(lng)) return toast('Koordinat geçersiz.', 'warn');
    const r = await adminCall('store_save', { id: s.id, name: f.name.value.trim(), code: f.code.value.trim(), region: f.region.value.trim(), address: f.address.value.trim(), lat, lng, active: f.active.checked },
      isNew ? 'Mağaza eklendi.' : 'Mağaza güncellendi.', $('button[type=submit]', f));
    if (r) { closeModal(true); render(); }
  };
}

async function deleteStore(id) {
  const s = S.stores.get(id); if (!s) return;
  const used = completedAudits().filter(a => a.storeId === id).length;
  const ok = await confirmDlg({ title: 'Mağazayı sil', message: `${s.name} silinecek.${used ? `\nBu mağazanın ${used} denetim raporu raporlarda korunur.` : ''}\nGeçici olarak kapatmak için silmek yerine "Pasif" yapabilirsiniz.`, ok: 'Sil', danger: true });
  if (ok && await adminCall('store_delete', { id }, 'Mağaza silindi.')) render();
}

function regionRename(oldName) {
  openModal(`<h3>Bölgeyi yeniden adlandır</h3><form id="rgForm" style="display:grid;gap:12px;margin-top:10px">
    <label class="field">Yeni ad<input type="text" name="name" value="${esc(oldName)}" required></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary">Kaydet</button></div></form>`);
  $('#rgForm').onsubmit = async e => {
    e.preventDefault();
    const nn = e.target.name.value.trim(); if (!nn || nn === oldName) return closeModal(true);
    if (await adminCall('region_rename', { from: oldName, to: nn }, 'Bölge adı güncellendi.', $('#rgForm .btn.primary'))) { closeModal(true); render(); }
  };
}

// ---------- Sorular ----------
function adminQuestions() {
  const cats = sortedCats();
  const qsBy = id => S.questions.filter(q => q.categoryId === id).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const qRow = (q, i, arr) => `<div class="item"><div class="item-main"><div class="item-title" style="font-weight:600">${esc(q.text)}</div>
      ${q.active === false ? '<span class="badge gray">Pasif</span>' : ''}</div>
      <div class="row"><button class="icon-btn" data-act="q-move" data-id="${q.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Yukarı">▲</button>
      <button class="icon-btn" data-act="q-move" data-id="${q.id}" data-dir="1" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="Aşağı">▼</button>
      <button class="btn ghost sm" data-act="q-edit" data-id="${q.id}">Düzenle</button>
      <button class="btn danger-ghost sm" data-act="q-del" data-id="${q.id}">Sil</button></div></div>`;
  return `<div class="card"><div class="card-head"><h3>Denetim soruları</h3>
      <div class="row"><button class="btn ghost sm" data-act="cat-new">+ Kategori</button><button class="btn primary sm" data-act="q-new" ${cats.length ? '' : 'disabled'}>+ Soru</button></div></div>
    <p class="hint">Soru değişiklikleri yeni başlatılan denetimlere uygulanır; tamamlanmış raporlar o anki soru metniyle korunur.</p>
    ${!cats.length ? `<div class="empty">Henüz kategori ve soru yok.<br><br><button class="btn dark sm" data-act="seed">Örnek mağaza denetim sorularını yükle</button></div>` : ''}</div>
    ${cats.map((c, ci) => { const qs = qsBy(c.id); return `<div class="card"><div class="card-head"><h3>${esc(c.name)} <span class="muted small">(${qs.length})</span></h3>
      <div class="row"><button class="icon-btn" data-act="cat-move" data-id="${c.id}" data-dir="-1" ${ci === 0 ? 'disabled' : ''} aria-label="Yukarı">▲</button>
      <button class="icon-btn" data-act="cat-move" data-id="${c.id}" data-dir="1" ${ci === cats.length - 1 ? 'disabled' : ''} aria-label="Aşağı">▼</button>
      <button class="btn ghost sm" data-act="cat-edit" data-id="${c.id}">Yeniden adlandır</button>
      <button class="btn danger-ghost sm" data-act="cat-del" data-id="${c.id}">Sil</button></div></div>
      <div class="list">${qs.map(qRow).join('') || '<div class="muted small">Bu kategoride soru yok.</div>'}</div></div>`; }).join('')}`;
}

function catForm(c) {
  openModal(`<h3>${c ? 'Kategoriyi yeniden adlandır' : 'Yeni kategori'}</h3><form id="cForm" style="display:grid;gap:12px;margin-top:10px">
    <label class="field">Kategori adı<input type="text" name="name" value="${esc(c?.name || '')}" required></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary">Kaydet</button></div></form>`);
  $('#cForm').onsubmit = async e => {
    e.preventDefault();
    const name = e.target.name.value.trim(); if (!name) return;
    if (await adminCall('cat_save', { id: c?.id, name }, 'Kategori kaydedildi.', $('#cForm .btn.primary'))) { closeModal(true); render(); }
  };
}

function questionForm(q) {
  const cats = sortedCats();
  openModal(`<h3>${q ? 'Soruyu düzenle' : 'Yeni soru'}</h3><form id="qForm" style="display:grid;gap:12px;margin-top:10px">
    <label class="field">Soru metni<textarea name="text" required>${esc(q?.text || '')}</textarea></label>
    <label class="field">Kategori<select name="cat">${cats.map(c => `<option value="${c.id}" ${q?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="active" ${q?.active === false ? '' : 'checked'}><span>Aktif (denetimlerde sorulur)</span></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary">Kaydet</button></div></form>`);
  $('#qForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, text = f.text.value.trim(); if (!text) return toast('Soru metni girin.', 'warn');
    if (await adminCall('q_save', { id: q?.id, text, categoryId: f.cat.value, active: f.active.checked }, 'Soru kaydedildi.', $('#qForm .btn.primary'))) { closeModal(true); render(); }
  };
}

// ---------- Ayarlar ----------
function adminSettings() {
  const c = S.settings;
  return `<div class="card"><form id="setForm" style="display:grid;gap:16px">
    <h3>"Hayır" cevabı kuralları</h3>
    <label class="check"><input type="checkbox" name="photoRequiredOnNo" ${c.photoRequiredOnNo ? 'checked' : ''}><span><b>Fotoğraf zorunlu</b><br><span class="hint">Açıksa "Hayır" cevabında en az bir fotoğraf eklenmeden denetim tamamlanamaz.</span></span></label>
    <label class="check"><input type="checkbox" name="actionOnNo" ${c.actionOnNo ? 'checked' : ''}><span><b>Aksiyon / termin kullan</b><br><span class="hint">Açıksa "Hayır" cevabında aksiyon ve termin alanları gösterilir; termin zorunludur.</span></span></label>
    <div class="divider"></div>
    <h3>GPS doğrulama</h3>
    <div class="form-grid">
      <label class="field">İzin verilen mesafe (metre)<input type="number" name="maxDistanceM" min="10" max="100000" step="10" value="${c.maxDistanceM}"></label>
      <label class="field">Kabul edilen konum hassasiyeti (± metre)<input type="number" name="maxAccuracyM" min="5" max="5000" step="5" value="${c.maxAccuracyM}"></label>
    </div>
    <label class="check"><input type="checkbox" name="blockOutside" ${c.blockOutside ? 'checked' : ''}><span><b>Mesafe dışında tamamlamayı engelle</b><br><span class="hint">Açıksa denetçi mağazaya belirlenen mesafeden uzaktaysa denetim tamamlanamaz (sunucu da reddeder). Kapalıysa denetim "GPS onaysız" olarak kaydedilir.</span></span></label>
    <div class="divider"></div>
    <h3>E-posta (Şifremi Unuttum)</h3>
    <p class="small">${S.mail ? '<span class="badge green">Kurulu</span> Şifre sıfırlama e-postaları gönderilebiliyor.' : '<span class="badge amber">Kurulmamış</span> "Şifremi Unuttum" e-postası gönderilemez. Kurulum rehberindeki "E-posta" adımını uygulayın. O zamana kadar kullanıcı şifrelerini Kullanıcılar bölümünden siz değiştirebilirsiniz.'}</p>
    <div class="row"><button class="btn primary" type="submit">Ayarları kaydet</button></div>
  </form></div>`;
}

// ---------- Kullanıcı menüsü ----------
function userMenu() {
  openModal(`<h3>${esc(S.user.name)}</h3><p class="muted small">${esc(S.user.email)} · ${isAdmin() ? 'Yönetici' : 'Denetçi'}</p>
    <div class="menu-list" style="margin-top:14px">
      <button class="btn ghost block" data-act="pw-change">Şifremi değiştir</button>
      <button class="btn danger-ghost block" data-act="logout">Çıkış yap</button></div>`);
}
function passwordChange() {
  openModal(`<h3>Şifremi değiştir</h3><form id="pwForm" style="display:grid;gap:12px;margin-top:10px" novalidate>
    <label class="field">Mevcut şifre<input type="password" name="cur" autocomplete="current-password" required></label>
    <label class="field">Yeni şifre<input type="password" name="p1" autocomplete="new-password" required></label>
    <label class="field">Yeni şifre (tekrar)<input type="password" name="p2" autocomplete="new-password" required></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="modal-close">Vazgeç</button><button class="btn primary">Kaydet</button></div></form>`);
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (f.p1.value.length < 6) return toast('Yeni şifre en az 6 karakter olmalı.', 'warn');
    if (f.p1.value !== f.p2.value) return toast('Yeni şifreler aynı değil.', 'warn');
    try {
      await withBtn($('#pwForm .btn.primary'), () => api('changepw', { current: f.cur.value, password: f.p1.value }));
      closeModal(true); toast('Şifreniz değiştirildi.', 'success');
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// ---------------------------------------------------------------------
//  Olay yönetimi
// ---------------------------------------------------------------------
const actions = {
  'modal-close': () => closeModal(),
  'pw-toggle': el => { const i = el.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? 'Göster' : 'Gizle'; },
  'forgot': () => forgotDialog($('#loginForm')?.email.value.trim() || ''),
  'user-menu': userMenu,
  'logout': async () => {
    closeModal(true);
    if (S.savePending || S.saving) await flushSave();
    try { await api('logout', {}); } catch { /* yine de çık */ }
    history.replaceState(null, '', location.pathname);
    loggedOut(); toast('Çıkış yapıldı.', 'success');
  },
  'pw-change': passwordChange,
  'audit-start': el => startAudit(el.dataset.id, el),
  'draft-del': el => deleteDraft(el.dataset.id),
  'ans': el => setAnswer(el.dataset.q, el.dataset.v),
  'photo-del': async el => {
    const ok = await confirmDlg({ title: 'Fotoğrafı sil', message: 'Fotoğraf buluttan silinecek.', ok: 'Sil', danger: true });
    if (!ok) return;
    const { q, pid } = el.dataset, a = S.draft.answers[q];
    try { await api('photo_del', { id: pid }); a.photos = (a.photos || []).filter(x => x !== pid); rerenderQuestion(q); scheduleSave(); }
    catch (err) { toast(errMsg(err), 'error'); }
  },
  'zoom': el => { if (el.src) openModal(`<div class="lightbox"><img src="${el.src}" alt="Fotoğraf"></div><div class="modal-actions"><button class="btn primary" data-act="modal-close">Kapat</button></div>`, { wide: true }); },
  'gps-retry': () => checkGps(),
  'audit-complete': el => completeAudit(el),
  'print': el => printReport(el),
  'share': el => shareReport(el.dataset.id),
  'action-set': el => setActionStatus(el.dataset.id, el.dataset.v),
  'user-new': () => userForm(null),
  'user-edit': el => userForm(S.users.find(u => u.id === el.dataset.id)),
  'user-del': el => deleteUser(el.dataset.id),
  'user-reset': el => adminCall('user_reset', { id: el.dataset.id }, 'Şifre sıfırlama e-postası gönderildi.', el),
  'stores-all': () => $$('#uForm input[name=store]').forEach(i => { i.checked = true; }),
  'stores-none': () => $$('#uForm input[name=store]').forEach(i => { i.checked = false; }),
  'store-new': () => storeForm(null),
  'store-edit': el => storeForm(S.stores.get(el.dataset.id)),
  'store-del': el => deleteStore(el.dataset.id),
  'store-here': async el => {
    const st = $('#hereState'); el.disabled = true; st.textContent = 'Konum alınıyor…';
    try {
      const p = await getPosition();
      const f = $('#sForm'); f.lat.value = p.coords.latitude.toFixed(6); f.lng.value = p.coords.longitude.toFixed(6);
      st.textContent = `Alındı (±${Math.round(p.coords.accuracy)} m)`;
    } catch (e) { st.textContent = e.code === 1 ? 'Konum izni verilmedi.' : 'Konum alınamadı.'; }
    el.disabled = false;
  },
  'region-rename': el => regionRename(el.dataset.region),
  'cat-new': () => catForm(null),
  'cat-edit': el => catForm(S.categories.find(c => c.id === el.dataset.id)),
  'cat-del': async el => {
    const c = S.categories.find(x => x.id === el.dataset.id);
    if (S.questions.some(q => q.categoryId === c.id)) return toast('Bu kategoride soru var. Önce soruları silin veya başka kategoriye taşıyın.', 'warn');
    if (await confirmDlg({ title: 'Kategoriyi sil', message: `"${c.name}" silinecek.`, ok: 'Sil', danger: true }) && await adminCall('cat_delete', { id: c.id }, 'Kategori silindi.')) render();
  },
  'cat-move': async el => { if (await adminCall('cat_move', { id: el.dataset.id, dir: Number(el.dataset.dir) })) render(); },
  'q-new': () => questionForm(null),
  'q-edit': el => questionForm(S.questions.find(q => q.id === el.dataset.id)),
  'q-del': async el => {
    const q = S.questions.find(x => x.id === el.dataset.id);
    if (await confirmDlg({ title: 'Soruyu sil', message: `"${q.text}"\nsilinecek. Geçmiş raporlar etkilenmez. Geçici olarak kaldırmak için "Pasif" yapabilirsiniz.`, ok: 'Sil', danger: true }) && await adminCall('q_delete', { id: q.id }, 'Soru silindi.')) render();
  },
  'q-move': async el => { if (await adminCall('q_move', { id: el.dataset.id, dir: Number(el.dataset.dir) })) render(); },
  'seed': async el => { if (await adminCall('seed_questions', {}, 'Örnek sorular yüklendi. İstediğiniz gibi düzenleyebilirsiniz.', el)) render(); }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' || el.dataset.act === 'zoom' || el.classList.contains('modal-back')) e.preventDefault(); fn(el, e); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.field && t.dataset.q && S.draft) setAnswerField(t.dataset.q, t.dataset.field, t.value);
  else if (t.dataset.filter) { S.filters[t.dataset.filter] = t.value; const l = $('#repList'); if (l) l.innerHTML = reportListHtml(); }
  else if (t.id === 'stSearch') filterStoreList();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.photoQ && t.files?.length) { const files = [...t.files]; t.value = ''; addPhotos(t.dataset.photoQ, files); }
  else if (t.dataset.filter) { S.filters[t.dataset.filter] = t.value; const l = $('#repList'); if (l) l.innerHTML = reportListHtml(); }
  else if (t.id === 'stRegion') filterStoreList();
  else if (t.dataset.field === 'due' && t.dataset.q && S.draft) setAnswerField(t.dataset.q, 'due', t.value);
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'setForm') return;
  e.preventDefault();
  const f = e.target;
  await adminCall('settings_save', {
    photoRequiredOnNo: f.photoRequiredOnNo.checked, actionOnNo: f.actionOnNo.checked, blockOutside: f.blockOutside.checked,
    maxDistanceM: Number(f.maxDistanceM.value), maxAccuracyM: Number(f.maxAccuracyM.value)
  }, 'Ayarlar kaydedildi. Tüm cihazlarda geçerli.', $('button[type=submit]', f));
});
