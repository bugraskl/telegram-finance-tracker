'use strict';

/*
 * Finans Dashboard - Telegram Harcama Kaydedici icin web arayuzu.
 * Botun yazdigi expenses.jsonl dosyasini okur, gorsellestirir ve CRUD saglar.
 *
 * Veri formati (her satir bir JSON kaydi):
 *   { type, ts, user, amount, currency, category, description, raw, confidence,
 *     [installment_total, installment_index, installment_count] }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Konfigurasyon (ortam degiskenleri)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const EXPENSES_FILE = process.env.EXPENSES_FILE || '/data/downloads/expenses.jsonl';
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_DAYS = parseInt(process.env.TOKEN_TTL_DAYS || '7', 10);

// TL'ye cevrim kurlari (botla ayni varsayilanlar). JSON olarak override edilebilir.
let CURRENCY_RATES = { TL: 1, EUR: 47, USD: 41, GBP: 53 };
if (process.env.CURRENCY_RATES) {
  try {
    CURRENCY_RATES = { ...CURRENCY_RATES, ...JSON.parse(process.env.CURRENCY_RATES) };
  } catch (e) {
    console.warn('CURRENCY_RATES parse edilemedi, varsayilan kullaniliyor:', e.message);
  }
}

if (!APP_PASSWORD) {
  console.error('\n[HATA] APP_PASSWORD tanimlanmamis. Guvenlik icin bir sifre belirleyin.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dosya erisimi yardimcilari
// ---------------------------------------------------------------------------

// Es zamanli yazimlari sirali tutmak icin basit promise tabanli mutex.
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  // hata da olsa zinciri devam ettir
  writeChain = run.then(() => {}, () => {});
  return run;
}

// Bir kaydin icerik tabanli kararli kimligini uretir (dosyada id alani yok).
function recordId(rec) {
  const { _id, ...clean } = rec;
  const keys = Object.keys(clean).sort();
  const canonical = JSON.stringify(clean, keys);
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

function readRecords() {
  if (!fs.existsSync(EXPENSES_FILE)) return [];
  const content = fs.readFileSync(EXPENSES_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const out = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (!rec.type) rec.type = 'expense'; // geriye donuk uyum
      rec._id = recordId(rec);
      out.push(rec);
    } catch (e) {
      // bozuk satiri atla
    }
  }
  return out;
}

// Tum kayitlari atomik olarak yazar (temp + rename).
function writeRecords(records) {
  const dir = path.dirname(EXPENSES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => {
    const { _id, ...clean } = r;
    return JSON.stringify(clean);
  });
  const tmp = EXPENSES_FILE + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
  fs.renameSync(tmp, EXPENSES_FILE);
}

function appendRecord(rec) {
  const dir = path.dirname(EXPENSES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const { _id, ...clean } = rec;
  fs.appendFileSync(EXPENSES_FILE, JSON.stringify(clean) + '\n');
}

// Botun taksit mantigi: TZ kaymasi olmadan ay ekler ("YYYY-MM-DD HH:mm:ss").
function addMonths(dateStr, months) {
  const [datePart, timePart] = dateStr.split(' ');
  const [y, m, day] = datePart.split('-').map(Number);
  const totalMonths = m - 1 + months;
  const newYear = y + Math.floor(totalMonths / 12);
  const newMonth = ((totalMonths % 12) + 12) % 12; // 0-indeksli, negatif guvenli
  const maxDay = new Date(newYear, newMonth + 1, 0).getDate();
  const newDay = Math.min(day, maxDay);
  const t = timePart || '00:00:00';
  return `${newYear}-${String(newMonth + 1).padStart(2, '0')}-${String(newDay).padStart(2, '0')} ${t}`;
}

// "YYYY-MM-DD HH:mm:ss" formatli Istanbul zaman damgasi.
function nowIstanbul() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' });
}

// Gelen kayit verisini temizle / dogrula.
function sanitizeInput(body) {
  const type = body.type === 'income' ? 'income' : 'expense';
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error('Gecersiz tutar');
  const currency = ['TL', 'EUR', 'USD', 'GBP'].includes(body.currency)
    ? body.currency
    : 'TL';
  const category = String(body.category || 'diger').trim() || 'diger';
  const description = String(body.description || '').trim() || category;
  const user = String(body.user || 'Manuel').trim() || 'Manuel';
  // ts: "YYYY-MM-DD" veya "YYYY-MM-DD HH:mm:ss" kabul et
  let ts = String(body.ts || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) {
    const t = nowIstanbul().split(' ')[1] || '00:00:00';
    ts = `${ts} ${t}`;
  } else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) {
    ts = nowIstanbul();
  }
  return { type, amount, currency, category, description, user, ts };
}

// ---------------------------------------------------------------------------
// Express uygulamasi
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

const COOKIE_NAME = 'fa_token';

function signToken(username) {
  return jwt.sign({ u: username }, SESSION_SECRET, {
    expiresIn: `${TOKEN_TTL_DAYS}d`,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Yetkisiz' });
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Oturum gecersiz' });
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- Auth ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const okUser = safeEqual(username || '', APP_USERNAME);
  const okPass = safeEqual(password || '', APP_PASSWORD);
  if (!okUser || !okPass) {
    return res.status(401).json({ error: 'Kullanici adi veya sifre hatali' });
  }
  const token = signToken(APP_USERNAME);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https',
    maxAge: TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, username: APP_USERNAME });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.u });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({ rates: CURRENCY_RATES });
});

// --- Veri okuma ---
app.get('/api/transactions', requireAuth, (req, res) => {
  try {
    res.json({ transactions: readRecords() });
  } catch (e) {
    res.status(500).json({ error: 'Dosya okunamadi: ' + e.message });
  }
});

// --- Olusturma (taksitli destegi ile) ---
app.post('/api/transactions', requireAuth, async (req, res) => {
  try {
    const data = sanitizeInput(req.body || {});
    let installments = parseInt(req.body.installments, 10);
    if (!isFinite(installments) || installments < 1) installments = 1;
    if (data.type === 'income') installments = 1; // gelir taksitlenmez

    await withLock(async () => {
      if (installments > 1) {
        const perInst = Math.round((data.amount / installments) * 100) / 100;
        for (let i = 0; i < installments; i++) {
          const ts = addMonths(data.ts, i);
          const desc = `${data.description} (${i + 1}/${installments}. taksit)`;
          appendRecord({
            type: data.type,
            ts,
            user: data.user,
            amount: perInst,
            currency: data.currency,
            category: data.category,
            description: desc,
            raw: data.description,
            confidence: 1,
            installment_total: data.amount,
            installment_index: i + 1,
            installment_count: installments,
          });
        }
      } else {
        appendRecord({
          type: data.type,
          ts: data.ts,
          user: data.user,
          amount: data.amount,
          currency: data.currency,
          category: data.category,
          description: data.description,
          raw: data.description,
          confidence: 1,
        });
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Guncelleme (tek satir) ---
app.put('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const data = sanitizeInput(req.body || {});
    const id = req.params.id;
    let found = false;
    await withLock(async () => {
      const records = readRecords();
      const idx = records.findIndex((r) => r._id === id);
      if (idx === -1) return;
      found = true;
      const old = records[idx];
      // Tek satir guncelleme: taksit alanlarini koru, temel alanlari degistir.
      const updated = {
        ...old,
        type: data.type,
        ts: data.ts,
        user: data.user,
        amount: data.amount,
        currency: data.currency,
        category: data.category,
        description: data.description,
      };
      delete updated._id;
      records[idx] = updated;
      writeRecords(records);
    });
    if (!found) return res.status(404).json({ error: 'Kayit bulunamadi (dosya degismis olabilir)' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Silme (tek satir veya tum taksit serisi) ---
app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const deleteSeries = req.query.series === 'true';
    let deleted = 0;
    await withLock(async () => {
      const records = readRecords();
      const target = records.find((r) => r._id === id);
      if (!target) return;

      let toRemove;
      if (deleteSeries && target.installment_total) {
        const baseDesc = (target.description || '').split(' (')[0];
        toRemove = (r) =>
          r.installment_total === target.installment_total &&
          r.user === target.user &&
          (r.description || '').split(' (')[0] === baseDesc;
      } else {
        toRemove = (r) => r._id === id;
      }
      const kept = records.filter((r) => !toRemove(r));
      deleted = records.length - kept.length;
      writeRecords(kept);
    });
    if (deleted === 0) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Statik dosyalar / SPA ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Finans Dashboard calisiyor: http://localhost:${PORT}`);
  console.log(`Veri dosyasi: ${EXPENSES_FILE}`);
});
