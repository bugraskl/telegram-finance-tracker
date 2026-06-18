'use strict';

// ---------------------------------------------------------------------------
// Kategoriler (n8n workflow ile ayni) + Turkce etiket & emoji
// ---------------------------------------------------------------------------
// [lucide-ikon-adi, Turkce etiket]
const EXPENSE_CATEGORIES = {
  yemek: ['utensils-crossed', 'Yemek'], market: ['shopping-cart', 'Market'], ulasim: ['bus', 'Ulaşım'], fatura: ['receipt', 'Fatura'],
  eglence: ['party-popper', 'Eğlence'], saglik: ['heart-pulse', 'Sağlık'], giyim: ['shirt', 'Giyim'], ev_mobilya: ['sofa', 'Ev/Mobilya'],
  egitim: ['graduation-cap', 'Eğitim'], tatil: ['plane', 'Tatil'], kisisel_bakim: ['scissors', 'Kişisel Bakım'], abonelik: ['repeat', 'Abonelik'],
  hediye: ['gift', 'Hediye'], yakit: ['fuel', 'Yakıt'], evcil_hayvan: ['paw-print', 'Evcil Hayvan'], kira_odeme: ['home', 'Kira'],
  vergi: ['landmark', 'Vergi'], diger: ['package', 'Diğer'],
};
const INCOME_CATEGORIES = {
  maas: ['briefcase', 'Maaş'], freelance: ['laptop', 'Freelance'], kira_geliri: ['home', 'Kira Geliri'],
  yatirim_getirisi: ['trending-up', 'Yatırım'], bonus: ['award', 'Bonus'], satis: ['tag', 'Satış'],
  hediye_gelir: ['gift', 'Hediye'], iade: ['rotate-ccw', 'İade'], faiz: ['piggy-bank', 'Faiz'], diger_gelir: ['coins', 'Diğer'],
};
const catInfo = (type, key) =>
  (type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES)[key] || ['package', key];
const catIconName = (t, k) => catInfo(t, k)[0];
const catName = (t, k) => catInfo(t, k)[1];
const catIcon = (t, k, cls) => icon(catIconName(t, k), cls);

// ---------------------------------------------------------------------------
// Durum
// ---------------------------------------------------------------------------
let RATES = { TL: 1, EUR: 47, USD: 41, GBP: 53 };
let ALL = [];
let trendChart = null;
let pieChart = null;
let pieType = 'expense'; // Dağılım panelinde seçili tür
let range = { from: null, to: null, label: 'Bu Ay' };

const PIE_PALETTE = ['#5eead4', '#ff7a85', '#3ddc97', '#fbbf63', '#a78bfa', '#38bdf8', '#f472b6', '#fb923c', '#4ade80', '#60a5fa', '#e879f9', '#facc15'];

const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(Math.round(n));
const fmtTL = (n) => fmt(n) + ' ₺';
const CUR_SYMBOL = { TL: '₺', EUR: '€', USD: '$', GBP: '£' };
const toTL = (a, c) => a * (RATES[c] || 1);
const dateOf = (r) => (r.ts || '').split(' ')[0];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (res.status === 401) { showLogin(); throw new Error('Oturum gerekli'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız');
  return data;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function showLogin() { $('app').classList.add('hidden'); $('login-screen').classList.remove('hidden'); }
function showApp() { $('login-screen').classList.add('hidden'); $('app').classList.remove('hidden'); }

async function boot() {
  try {
    await api('GET', '/api/me');
    showApp();
    await loadConfig();
    await refresh();
  } catch (e) { showLogin(); }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('POST', '/api/login', { username: $('login-user').value, password: $('login-pass').value });
    $('login-pass').value = '';
    await boot();
  } catch (err) { $('login-error').textContent = err.message; }
});

$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

async function loadConfig() {
  try { const cfg = await api('GET', '/api/config'); if (cfg.rates) RATES = cfg.rates; } catch (e) {}
}

// ---------------------------------------------------------------------------
// View switching (bottom nav)
// ---------------------------------------------------------------------------
let catFilter = null; // İşlemler'de aktif kategori filtresi

function switchView(v) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
  $('view-overview').classList.toggle('hidden', v !== 'overview');
  $('view-tx').classList.toggle('hidden', v !== 'tx');
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
  // Sekmeye elle geçince kategori filtresini temizle
  if (catFilter) { catFilter = null; renderActiveFilter(); renderTx(); }
  switchView(b.dataset.view);
}));

// Gider dağılımında bir kategoriye tıklayınca o kategorinin işlemlerini göster
window.openCategory = (key) => {
  catFilter = key;
  switchView('tx');
  renderActiveFilter();
  renderTx();
};
window.clearCatFilter = () => { catFilter = null; renderActiveFilter(); renderTx(); };

function renderActiveFilter() {
  const af = $('active-filter');
  if (catFilter) {
    af.classList.remove('hidden');
    af.innerHTML = `<button class="filter-chip" onclick="clearCatFilter()">${catIcon('expense', catFilter)}<span>${esc(catName('expense', catFilter))}</span><b>✕</b></button>`;
  } else {
    af.classList.add('hidden');
    af.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// Tarih araligi
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

function applyPreset(name) {
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
  let from, to, label;
  if (name === 'thisMonth') { from = new Date(y, m, 1); to = new Date(y, m + 1, 0); label = MONTHS[m] + ' ' + y; }
  else if (name === 'lastMonth') { from = new Date(y, m - 1, 1); to = new Date(y, m, 0); label = MONTHS[(m + 11) % 12] + (m === 0 ? ' ' + (y - 1) : ' ' + y); }
  else if (name === 'last3') { from = new Date(y, m - 2, 1); to = new Date(y, m + 1, 0); label = 'Son 3 Ay'; }
  else if (name === 'thisYear') { from = new Date(y, 0, 1); to = new Date(y, 11, 31); label = y + ' Yılı'; }
  else { from = null; to = null; label = 'Tüm Zamanlar'; }
  range = { from: from ? ymd(from) : null, to: to ? ymd(to) : null, label };
  $('custom-range').classList.add('hidden');
  render();
}

$('range-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  document.querySelectorAll('#range-presets .chip').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  if (btn.dataset.range === 'custom') {
    $('custom-range').classList.remove('hidden');
    if (!$('date-from').value) $('date-from').value = range.from || ymd(new Date());
    if (!$('date-to').value) $('date-to').value = range.to || ymd(new Date());
    applyCustom();
  } else {
    applyPreset(btn.dataset.range);
  }
});
function applyCustom() {
  range = { from: $('date-from').value || null, to: $('date-to').value || null, label: 'Özel Aralık' };
  render();
}
$('date-from').addEventListener('change', applyCustom);
$('date-to').addEventListener('change', applyCustom);
$('user-filter').addEventListener('change', renderTx);
$('type-filter').addEventListener('change', renderTx);
$('search').addEventListener('input', renderTx);

// ---------------------------------------------------------------------------
// Veri yukleme
// ---------------------------------------------------------------------------
async function refresh() {
  const data = await api('GET', '/api/transactions');
  ALL = data.transactions || [];
  const users = [...new Set(ALL.map((r) => r.user).filter(Boolean))].sort();
  const cur = $('user-filter').value;
  $('user-filter').innerHTML = '<option value="">Herkes</option>' +
    users.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('user-filter').value = cur;
  render();
}

const inRange = (r) => {
  const d = dateOf(r);
  if (range.from && d < range.from) return false;
  if (range.to && d > range.to) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() { renderHero(); renderTrend(); renderPie(); renderCategories(); renderInstallments(); renderTx(); }

function periodRows() { return ALL.filter(inRange); }

function renderHero() {
  const rows = periodRows();
  let inc = 0, exp = 0;
  for (const r of rows) { const tl = toTL(r.amount, r.currency); if (r.type === 'income') inc += tl; else exp += tl; }
  const net = inc - exp;
  const save = inc > 0 ? Math.round((net / inc) * 100) : null;
  $('hero-period').textContent = range.label;
  $('hero-net').textContent = (net >= 0 ? '' : '−') + fmtTL(Math.abs(net));
  $('hero-net').className = 'hero-net ' + (net >= 0 ? 'pos' : 'neg');
  $('hero-netlabel').textContent = net >= 0 ? 'net bakiye · artıda' : 'net bakiye · açık';
  $('hero-income').textContent = fmtTL(inc);
  $('hero-expense').textContent = fmtTL(exp);
  $('hero-save').textContent = save === null ? '—' : '%' + save;
}

function renderTrend() {
  const months = {};
  for (const r of ALL) {
    const mk = (r.ts || '').slice(0, 7); if (!mk) continue;
    if (!months[mk]) months[mk] = { inc: 0, exp: 0 };
    const tl = toTL(r.amount, r.currency);
    if (r.type === 'income') months[mk].inc += tl; else months[mk].exp += tl;
  }
  const keys = Object.keys(months).sort().slice(-6);
  const labels = keys.map((k) => { const [y, m] = k.split('-'); return MONTHS[+m - 1].slice(0, 3) + ' ' + y.slice(2); });
  const inc = keys.map((k) => Math.round(months[k].inc));
  const exp = keys.map((k) => Math.round(months[k].exp));
  const ctx = $('chart-trend');
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Gelir', data: inc, backgroundColor: '#3ddc97', borderRadius: 6, maxBarThickness: 22 },
      { label: 'Gider', data: exp, backgroundColor: '#ff7a85', borderRadius: 6, maxBarThickness: 22 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b94a5', boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtTL(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#8b94a5', font: { size: 11 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: '#5b6373', font: { size: 11 }, maxTicksLimit: 5, callback: (v) => v >= 1000 ? (v / 1000) + 'b' : v }, grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false } },
      },
    },
  });
}

function renderPie() {
  const rows = periodRows().filter((r) => r.type === pieType);
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + toTL(r.amount, r.currency);
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([k]) => catName(pieType, k));
  const data = entries.map(([, v]) => Math.round(v));

  const empty = $('pie-empty');
  const canvas = $('chart-pie');
  if (pieChart) { pieChart.destroy(); pieChart = null; }
  if (!entries.length) {
    empty.classList.remove('hidden');
    canvas.style.display = 'none';
    return;
  }
  empty.classList.add('hidden');
  canvas.style.display = '';

  pieChart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: PIE_PALETTE, borderColor: '#161a22', borderWidth: 3, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%', animation: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8b94a5', boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 12, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((s, x) => s + x, 0);
              const pct = total ? Math.round((c.parsed / total) * 100) : 0;
              return ` ${c.label}: ${fmtTL(c.parsed)} (%${pct})`;
            },
          },
        },
      },
    },
  });
}

document.getElementById('pie-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  pieType = btn.dataset.pt;
  document.querySelectorAll('#pie-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
  renderPie();
});

function renderCategories() {
  const rows = periodRows().filter((r) => r.type === 'expense');
  const byCat = {};
  let total = 0;
  for (const r of rows) { const tl = toTL(r.amount, r.currency); byCat[r.category] = (byCat[r.category] || 0) + tl; total += tl; }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $('cat-total').textContent = total > 0 ? fmtTL(total) : '';
  $('cat-empty').classList.toggle('hidden', entries.length > 0);
  const palette = ['#5eead4', '#ff7a85', '#3ddc97', '#fbbf63', '#a78bfa', '#38bdf8', '#f472b6', '#fb923c'];
  const max = entries.length ? entries[0][1] : 1;
  $('cat-list').innerHTML = entries.map(([k, v], i) => {
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    const w = Math.max(4, Math.round((v / max) * 100));
    const color = palette[i % palette.length];
    return `<div class="cat-item" onclick="openCategory('${k}')">
      <div class="cat-top">
        <div class="cat-name"><span class="cat-ic" style="color:${color}">${catIcon('expense', k)}</span>${esc(catName('expense', k))}<span class="cat-pct">%${pct}</span></div>
        <div class="cat-amt">${fmtTL(v)}</div>
      </div>
      <div class="cat-bar"><i style="width:${w}%;background:${color}"></i></div>
    </div>`;
  }).join('');
}

function renderInstallments() {
  const today = ymd(new Date());
  const up = ALL.filter((r) => r.installment_count > 1 && dateOf(r) >= today)
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b))).slice(0, 6);
  const sec = $('installments-section');
  if (!up.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  $('installments-list').innerHTML = up.map((r) => {
    const base = (r.description || '').split(' (')[0];
    return `<div class="inst-row">
      <div class="inst-left">
        <div class="tx-ava">${catIcon('expense', r.category)}</div>
        <div><div class="inst-name">${esc(base)}</div>
          <div class="inst-meta">${r.installment_index}/${r.installment_count}. taksit · ${esc(r.user || '')}</div></div>
      </div>
      <div class="inst-right">
        <div class="inst-amt">${fmt(r.amount)} ${CUR_SYMBOL[r.currency] || r.currency}</div>
        <div class="inst-date">${fmtDateShort(dateOf(r))}</div>
      </div>
    </div>`;
  }).join('');
}

function fmtDateShort(d) {
  const [y, m, day] = d.split('-'); if (!day) return d;
  return `${+day} ${MONTHS[+m - 1].slice(0, 3)}`;
}
function dayHeading(d) {
  const today = ymd(new Date());
  const yest = ymd(new Date(Date.now() - 864e5));
  if (d === today) return 'Bugün';
  if (d === yest) return 'Dün';
  const [y, m, day] = d.split('-');
  return `${+day} ${MONTHS[+m - 1]}${y != new Date().getFullYear() ? ' ' + y : ''}`;
}

function txFiltered() {
  const uf = $('user-filter').value, tf = $('type-filter').value, q = $('search').value.trim().toLowerCase();
  return periodRows().filter((r) => {
    if (catFilter && r.category !== catFilter) return false;
    if (uf && r.user !== uf) return false;
    if (tf && r.type !== tf) return false;
    if (q) {
      const hay = `${r.description || ''} ${catName(r.type, r.category)} ${r.user || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTx() {
  renderActiveFilter();
  const rows = txFiltered().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  $('tx-empty').classList.toggle('hidden', rows.length > 0);
  // group by day
  const groups = {};
  for (const r of rows) { const d = dateOf(r); (groups[d] = groups[d] || []).push(r); }
  const days = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  $('tx-list').innerHTML = days.map((d) => {
    let net = 0;
    const items = groups[d].map((r) => {
      const isInc = r.type === 'income';
      net += isInc ? toTL(r.amount, r.currency) : -toTL(r.amount, r.currency);
      const inst = r.installment_count > 1 ? `<span class="inst-pill">${r.installment_index}/${r.installment_count}</span>` : '';
      const sym = CUR_SYMBOL[r.currency] || r.currency;
      return `<div class="tx-row" onclick="editTx('${r._id}')">
        <div class="tx-ava ${isInc ? 'ava-income' : ''}">${catIcon(r.type, r.category)}</div>
        <div class="tx-body">
          <div class="tx-desc">${esc(r.description || catName(r.type, r.category))}${inst}</div>
          <div class="tx-sub">${esc(catName(r.type, r.category))} · ${esc(r.user || '')}</div>
        </div>
        <div class="tx-amt ${isInc ? 'income' : 'expense'}">${isInc ? '+' : '−'}${fmt(r.amount)} ${sym}</div>
      </div>`;
    }).join('');
    const sign = net >= 0 ? '+' : '−';
    return `<div class="tx-daygroup">
      <div class="tx-dayhead"><span class="tx-daydate">${dayHeading(d)}</span><span class="tx-daysum">${sign}${fmtTL(Math.abs(net))}</span></div>
      ${items}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Bottom sheet / CRUD
// ---------------------------------------------------------------------------
let modalType = 'expense';

function fillCategorySelect(type) {
  const cats = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  $('f-category').innerHTML = Object.entries(cats).map(([k, [ic, n]]) => `<option value="${k}">${n}</option>`).join('');
}
function setModalType(type) {
  modalType = type;
  document.querySelectorAll('#f-type-seg button').forEach((b) => {
    const on = b.dataset.type === type;
    b.classList.toggle('active', on);
    b.classList.toggle('exp-active', on && type === 'expense');
    b.classList.toggle('inc-active', on && type === 'income');
  });
  fillCategorySelect(type);
  $('f-inst-wrap').style.display = type === 'income' ? 'none' : 'flex';
}
document.querySelectorAll('#f-type-seg button').forEach((b) =>
  b.addEventListener('click', () => setModalType(b.dataset.type)));

function openSheet(rec) {
  $('sheet-error').textContent = '';
  const del = $('sheet-delete');
  if (rec) {
    $('sheet-title').textContent = 'Kaydı Düzenle';
    $('f-id').value = rec._id;
    setModalType(rec.type);
    $('f-amount').value = rec.installment_count > 1 ? rec.installment_total : rec.amount;
    $('f-currency').value = rec.currency || 'TL';
    $('f-category').value = rec.category;
    $('f-date').value = dateOf(rec);
    $('f-description').value = (rec.description || '').split(' (')[0];
    $('f-user').value = rec.user || '';
    $('f-installments').value = rec.installment_count > 1 ? rec.installment_count : 1;
    $('f-installments').disabled = true;
    del.classList.remove('hidden');
    del.dataset.id = rec._id;
    del.dataset.series = rec.installment_count > 1 ? '1' : '0';
    del.dataset.count = rec.installment_count || 1;
  } else {
    $('sheet-title').textContent = 'Kayıt Ekle';
    $('f-id').value = '';
    setModalType('expense');
    $('f-amount').value = '';
    $('f-currency').value = 'TL';
    $('f-date').value = ymd(new Date());
    $('f-description').value = '';
    $('f-user').value = '';
    $('f-installments').value = 1;
    $('f-installments').disabled = false;
    del.classList.add('hidden');
  }
  $('sheet').classList.remove('hidden');
  setTimeout(() => { if (!rec) $('f-amount').focus(); }, 60);
}
function closeSheet() { $('sheet').classList.add('hidden'); }

$('add-btn').addEventListener('click', () => openSheet(null));
$('sheet-cancel').addEventListener('click', closeSheet);
// arka plana (backdrop) tiklayinca kapat; forma tiklayinca kapatma
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

window.editTx = (id) => { const rec = ALL.find((r) => r._id === id); if (rec) openSheet(rec); };

$('sheet-delete').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  const id = b.dataset.id;
  let url = `/api/transactions/${id}`;
  if (b.dataset.series === '1') {
    const all = confirm(`Bu, ${b.dataset.count} taksitli bir işlemin parçası.\n\nTAMAM = tüm taksitleri sil\nİPTAL = sadece bu taksiti sil`);
    if (all) url += '?series=true';
  } else {
    if (!confirm('Bu kayıt silinsin mi?')) return;
  }
  try {
    const r = await api('DELETE', url);
    closeSheet();
    toast(`🗑️ ${r.deleted} kayıt silindi`, 'success');
    await refresh();
  } catch (err) { $('sheet-error').textContent = err.message; }
});

$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('sheet-error').textContent = '';
  const id = $('f-id').value;
  const payload = {
    type: modalType,
    amount: parseFloat($('f-amount').value),
    currency: $('f-currency').value,
    category: $('f-category').value,
    description: $('f-description').value.trim(),
    user: $('f-user').value.trim() || 'Manuel',
    ts: $('f-date').value,
    installments: parseInt($('f-installments').value, 10) || 1,
  };
  try {
    if (id) await api('PUT', `/api/transactions/${id}`, payload);
    else await api('POST', '/api/transactions', payload);
    closeSheet();
    toast(id ? '✏️ Güncellendi' : '✅ Eklendi', 'success');
    await refresh();
  } catch (err) { $('sheet-error').textContent = err.message; }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

// Statik UI ikonlarini (data-icon) doldur
function initIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}

// Baslat
initIcons();
applyPreset('thisMonth');
boot();
