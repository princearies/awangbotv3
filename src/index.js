import { Hono } from 'hono';
import { AWANGBOT_PROMPT } from './prompts/awangbot.js';
import { CIKGU_PROMPT } from './prompts/cikgu.js';
import { BANK_PROMPT } from './prompts/bank.js';
import { INFLUENCER_PROMPT } from './prompts/influencer.js';
import { RESTOCATERING_PROMPT } from './prompts/restocatering.js';
import { PROPERTY_PROMPT } from './prompts/property.js';
import { PBT_PROMPT } from './prompts/pbt.js';
import { KLINIK_PROMPT } from './prompts/klinik.js';
import { BURGER_PROMPT } from './prompts/burger.js';
import { NASIKUNING_PROMPT } from './prompts/nasikuning.js';
import { PROMPT_017 } from './prompts/017.js';
import { PROMPT_DROPSHIP } from './prompts/dropship.js';
import { PROMPT_DROPSHIP_EN } from './prompts/dropship-en.js';

// Import Semua Konfigurasi Tab
import { CHAT_TAB } from './tabs/chat.js';
import { CIKGU_TAB } from './tabs/cikgu.js';
import { BANK_TAB } from './tabs/bank.js';
import { INFLUENCER_TAB } from './tabs/influencer.js';
import { RESTOCATERING_TAB } from './tabs/restocatering.js';
import { PROPERTY_TAB } from './tabs/property.js';
import { PBT_TAB } from './tabs/pbt.js';
import { FORM_TAB } from './tabs/form.js';
import { KLINIK_TAB } from './tabs/klinik.js';
import { BURGER_TAB } from './tabs/burger.js';
import { NASIKUNING_TAB } from './tabs/nasikuning.js';

const app = new Hono();

// Senarai Tab Aktif Portal
const TABS = [
  CHAT_TAB, PBT_TAB, RESTOCATERING_TAB, PROPERTY_TAB, CIKGU_TAB, BANK_TAB, INFLUENCER_TAB,
  KLINIK_TAB, BURGER_TAB, NASIKUNING_TAB, FORM_TAB
];

// ----------------- WEBHOOK 017 (HQ JUALAN) -----------------
const VERIFY_017 = 'awang017';

// Verifikasi webhook 017 (Challenge)
app.get('/webhook-017', (c) => {
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (token === VERIFY_017) {
    return c.text(challenge || 'OK', 200);
  }
  return c.text('Forbidden', 403);
});

// Penerimaan event 017: simpan lead, balas AI, hantar balik WhatsApp
app.post('/webhook-017', async (c) => {
  try {
    const body = await c.req.json();
    const entry = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body || '';
    const name = entry?.contacts?.[0]?.profile?.name || 'boss';

    if (!from || !text) return c.text('EVENT_RECEIVED', 200);

    // 1. Simpan lead ke D1
    await saveLead(c.env, `017-Jualan (${name} / ${from})`, text);

    // 1b. Routing: dropship (order/tracking/refund) vs jualan pakej bot
    const t = text.toLowerCase();
    const isDropship = /(order|beli|belanja|nak beli|mau beli|barang|tracking|trek|parcel|pos laju|j&t|ninja|refund|return|tukar|rosak|salah barang|lambat|sampai bila|bayar|transfer|resit|qr|katalog|cod|stok|ready stock)/.test(t);
    const history017 = isDropship ? await getHistory(c.env, from) : [];
    const lang017 = isDropship ? detectLang(text, history017) : 'ms';
    const systemPrompt = !isDropship ? PROMPT_017 : (lang017 === 'ms' ? PROMPT_DROPSHIP : PROMPT_DROPSHIP_EN);

    // 2. Balasan AI (Claude -> Cloudflare Workers AI)
    const replyText = await askAi(c.env, text, systemPrompt, history017);
    if (isDropship) {
      await saveMsg(c.env, from, 'user', text);
      await saveMsg(c.env, from, 'assistant', replyText);
    }

    // 3. Hantar balik melalui WhatsApp Cloud API
    const token = c.env?.WHATSAPP_TOKEN_017;
    const phoneId = c.env?.PHONE_NUMBER_ID_017;

    if (token && phoneId) {
      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: replyText },
        }),
      });
      if (!res.ok) {
        console.warn('017 hantar balasan gagal HTTP ' + res.status + ': ' + (await res.text().catch(() => '')));
      }
    } else {
      console.warn('017: WHATSAPP_TOKEN_017 / PHONE_NUMBER_ID_017 belum ditetapkan, balasan tidak dihantar.');
    }
  } catch (err) {
    console.error('017 error:', err);
  }
  return c.text('EVENT_RECEIVED', 200);
});

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
    });
    // Jika parse_mode HTML gagal (cth: unescaped characters dari AI), cuba hantar sebagai teks biasa
    if (!res.ok) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text }),
      });
    }
  } catch (err) {
    console.error('Telegram send error:', err);
  }
}

// Pembela AI: Claude (prepaid) -> Cloudflare Workers AI (free)
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';
const CLAUDE_MAX_TOKENS = 1024;

// Bila prepaid habis, flip suis ini supaya tak cuba Claude lagi
// dalam isolate yang sama. Jimat latency setiap request.
let claudeDisabled = false;
let geminiDisabled = false; // 404 berulang -> jangan buang masa lagi
let claudeDisabledReason = '';

// Model Workers AI yang gagal, lumpuhkan supaya tak dicuba berulang
const cfDisabledModels = new Set();

// Anak tangga fallback Cloudflare, dari paling=kuat ke paling=murah.
// Semua dalam free tier 10k neuron/hari. Qwen3 30B kos sama seperti Llama 3B
// tetapi 10x saiz parameter, jadi ia letak pertama.
const CF_DEFAULT_CHAIN = '@cf/qwen/qwen3-30b-a3b-fp8,@cf/openai/gpt-oss-20b,@cf/meta/llama-3.2-3b-instruct';

function isCreditExhausted(status, bodyText) {
  if (status === 402) return true;
  if (status !== 400 && status !== 429) return false;
  const t = String(bodyText || '').toLowerCase();
  const markers = [
    'credit balance is too low',
    'insufficient credit',
    'credit balance too low',
    'insufficient funds',
    'payment required',
    'quota exceeded',
    'billing'
  ];
  return markers.some((m) => t.includes(m));
}

async function askClaude(env, message, systemPrompt, history = []) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = env?.CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL;
  const past = (history || []).map((h) => ({
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: String(h.content || '').slice(0, 500),
  }));

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [...past, { role: 'user', content: message }]
    })
  });

  if (res.ok) {
    const data = await res.json().catch(() => null);
    const text = (data?.content || [])
      .filter((b) => b?.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
    console.warn('Claude returned empty content, falling back.');
    return null;
  }

  const errText = await res.text().catch(() => '');

  if (isCreditExhausted(res.status, errText)) {
    claudeDisabled = true;
    claudeDisabledReason = 'prepaid credit habis';
    console.warn('Claude credit habis. Auto fallback ke Workers AI untuk isolate ini.');
  } else if (res.status === 401 || res.status === 403) {
    claudeDisabled = true;
    claudeDisabledReason = 'API key tidak sah';
    console.error('Claude auth gagal (HTTP ' + res.status + '). Auto fallback ke Workers AI.');
  } else {
    console.warn('Claude HTTP ' + res.status + ', guna fallback buat masa ini.');
  }

  return null;
}

async function askWorkersAi(env, message, systemPrompt, history = []) {
  if (!env?.AI) return null;

  const chain = (env?.CF_MODEL_CHAIN || CF_DEFAULT_CHAIN)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const past = (history || []).map((h) => ({
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: String(h.content || '').slice(0, 500),
  }));

  for (const model of chain) {
    if (cfDisabledModels.has(model)) continue;
    try {
      const ai = await env.AI.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          ...past,
          { role: 'user', content: message }
        ]
      });
      const out = workersText(ai);
      if (out) return out;
      console.warn('CF model ' + model + ' kosong, Cuba yang seterusnya.');
    } catch (err) {
      cfDisabledModels.add(model);
      console.warn('CF model ' + model + ' gagal, lumpuhkan untuk isolate ini:', err?.message || err);
    }
  }
  return null;
}

// Gemini free tier (AI Studio) — pilihan utama, jimat prepaid Claude
// GEMINI_MODEL boleh set "auto" atau nama spesifik. Cuba ikut turutan, skip yang 404/429.
const GEMINI_DEFAULT_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.0-flash'];
let geminiResolvedModel = null;

async function geminiPickLatest(apiKey) {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const names = (data?.models || [])
      .map((m) => String(m?.name || '').replace(/^models\//, ''))
      .filter((n) => /^(gemini-)?[0-9]+\.[0-9]+-flash/i.test(n) && !/exp|preview|thinking|image|audio|tts|omni/i.test(n));
    names.sort().reverse();
    return names[0] || null;
  } catch (e) {
    console.warn('Gemini list models gagal:', e?.message || e);
    return null;
  }
}

// Workers AI kadang pulang response bukan string (objek/array) — normalkan dulu.
// Format lama: {response:"..."}. Format baru OpenAI-style: {choices:[{message:{content:"..."}}]}.
function workersText(ai) {
  const r = ai?.response;
  if (typeof r === 'string' && r.trim()) return r.trim();
  const ch = ai?.choices?.[0];
  const c = ch?.message?.content ?? ch?.text ?? ch?.delta?.content;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    const t = c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('').trim();
    if (t) return t;
  }
  if (Array.isArray(r)) {
    const t = r.map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('').trim();
    if (t) return t;
  }
  if (r && typeof r === 'object') {
    const t = String(r.text || r.content || r.answer || '').trim();
    if (t) return t;
  }
  return '';
}

async function askGemini(env, message, systemPrompt, history = [], opts = {}) {
  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey) return null;
  const maxTokens = opts.maxTokens || 512;
  let model = env?.GEMINI_MODEL || geminiResolvedModel || 'auto';
  const candidates = [];
  if (model !== 'auto') candidates.push(model);
  candidates.push(...GEMINI_DEFAULT_CANDIDATES);
  const latest = await geminiPickLatest(apiKey);
  if (latest && !candidates.includes(latest)) candidates.push(latest);
  const contents = [
    ...(history || []).map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(h.content || '').slice(0, 1000) }],
    })),
    { role: 'user', parts: [{ text: String(message).slice(0, 2000) }] },
  ];
  const geminiCall = async (m) => {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
        }),
      }
    );
    return res;
  };
  try {
    for (const m of candidates) {
      let res = await geminiCall(m);
      if ((res.status === 404 || res.status === 429 || res.status === 400) && m !== candidates[candidates.length - 1]) {
        console.warn('Gemini model ' + m + ' HTTP ' + res.status + ', cuba seterusnya');
        continue;
      }
      if (!res.ok) {
        console.warn('Gemini HTTP ' + res.status);
        return null;
      }
      geminiResolvedModel = m;
      const data = await res.json().catch(() => null);
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || '')
        .join('')
        .trim();
      return text || null;
    }
    return null;
  } catch (err) {
    console.warn('Gemini request gagal:', err?.message || err);
    return null;
  }
}

async function askAi(env, message, customPrompt = null, history = []) {
  const systemPrompt = customPrompt || AWANGBOT_PROMPT;

  // Had masa setiap penyedia — elak permintaan tergantung sampai pelanggan give up.
  const hadMasa = (janji, ms, label) => Promise.race([
    janji,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' tamat masa ' + ms + 'ms')), ms)),
  ]);

  // 1. Workers AI (percuma, ~1s) — UTAMA sekarang
  try {
    const out = await hadMasa(askWorkersAi(env, message, systemPrompt, history), 9000, 'CF');
    if (out) return out;
  } catch (err) {
    console.warn('Workers AI gagal:', err?.message || err);
  }

  // 2. Gemini — sandaran (auto-lumpuh kalau 404 berulang)
  if (env?.GEMINI_API_KEY && !geminiDisabled) {
    try {
      const out = await hadMasa(askGemini(env, message, systemPrompt, history), 8000, 'Gemini');
      if (out) return out;
      geminiDisabled = true;
      console.warn('Gemini tiada model sah — dilumpuhkan untuk sesi ini');
    } catch (err) {
      geminiDisabled = true;
      console.warn('Gemini gagal:', err?.message || err);
    }
  }

  // 3. Claude prepaid — last resort saja ($5 trial cepat habis)
  if (!claudeDisabled && env?.ANTHROPIC_API_KEY) {
    try {
      const out = await hadMasa(askClaude(env, message, systemPrompt, history), 9000, 'Claude');
      if (out) return out;
    } catch (err) {
      console.warn('Claude request gagal:', err?.message || err);
    }
  }

  return 'Maaf, sistem AI sedang sibuk. Sila cuba sebentar lagi.';
}

async function saveLead(env, nama, notes) {
  try {
    if (!env?.DB) return;
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, nama_pelanggan TEXT, soalan TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
    ).run();
    await env.DB.prepare(
      'INSERT INTO leads (nama_pelanggan, soalan) VALUES (?, ?)'
    ).bind(nama, notes).run();
  } catch (err) {
    console.warn('DB insert failed:', err);
  }
}

// ----------------- DROPSHIP MVP (017 bisnes) -----------------
// Table: baru -> order_supplier -> pos -> sampai / refund
async function ensureDropshipTables(env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS dropship_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT, phone TEXT, barang TEXT, qty INTEGER DEFAULT 1, alamat TEXT, status TEXT DEFAULT "baru", tracking TEXT DEFAULT "", created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
  ).run();
  // Jumlah autoritatif yang dihantar oleh MyKiraShop (sudah termasuk kos pos).
  // ALTER akan gagal kalau kolum sudah ada — itu normal, jadi abaikan.
  try {
    await env.DB.prepare('ALTER TABLE dropship_orders ADD COLUMN harga REAL DEFAULT NULL').run();
  } catch (e) { /* kolum sudah ada */ }
}

async function saveDropshipOrder(env, o) {
  await ensureDropshipTables(env);
  if (!env?.DB) return null;
  const harga = Number(o?.harga) > 0 ? Number(o.harga) : null;
  try {
    const r = await env.DB.prepare(
      'INSERT INTO dropship_orders (nama, phone, barang, qty, alamat, status, harga) VALUES (?, ?, ?, ?, ?, "baru", ?)'
    ).bind(o.nama || '-', o.phone || '-', o.barang || '-', o.qty || 1, o.alamat || '-', harga).run();
    return r?.meta?.last_row_id || null;
  } catch (e) {
    // Kalau kolum `harga` belum wujud, order tetap mesti disimpan.
    console.warn('insert dengan harga gagal, cuba tanpa harga:', e?.message);
  }
  const r = await env.DB.prepare(
    'INSERT INTO dropship_orders (nama, phone, barang, qty, alamat, status) VALUES (?, ?, ?, ?, ?, "baru")'
  ).bind(o.nama || '-', o.phone || '-', o.barang || '-', o.qty || 1, o.alamat || '-').run();
  return r?.meta?.last_row_id || null;
}

async function getLatestTracking(env, phone) {
  await ensureDropshipTables(env);
  if (!env?.DB) return null;
  const row = await env.DB.prepare(
    'SELECT id, barang, status, tracking FROM dropship_orders WHERE phone = ? ORDER BY id DESC LIMIT 1'
  ).bind(phone).run();
  return row?.results?.[0] || null;
}

// ----------------- ANALITIK KEDAI (first-party, percuma) -----------------
// Satu baris per paparan halaman MyKiraShop. Tiada cookie, tiada pihak ketiga.
async function ensureHitsTable(env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS shop_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT DEFAULT "/", ref TEXT DEFAULT "", country TEXT DEFAULT "", ua TEXT DEFAULT "", created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_shop_hits_created ON shop_hits(created_at)'
  ).run();
}

/** Bot/pralihat link tak dikira sebagai pelawat. */
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python-requests|headless|lighthouse/i;

app.post('/api/hit', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const path = String(body?.path || '/').slice(0, 120);
    const ref = String(body?.ref || '').slice(0, 120);
    const ua = String(c.req.header('user-agent') || '').slice(0, 200);
    const country = String(body?.country || c.req.header('cf-ipcountry') || '').slice(0, 8);
    // Jangan kira bot, dan jangan kira halaman analitik/API sendiri.
    if (BOT_RE.test(ua) || path.startsWith('/api') || path.startsWith('/stats')) {
      return new Response(null, { status: 204 });
    }
    await ensureHitsTable(c.env);
    await c.env.DB.prepare(
      'INSERT INTO shop_hits (path, ref, country, ua) VALUES (?, ?, ?, ?)'
    ).bind(path, ref, country, ua).run();
  } catch (e) { /* analitik tak boleh pecahkan kedai */ }
  return new Response(null, { status: 204 });
});

app.get('/api/shop-stats', async (c) => {
  try {
    await ensureHitsTable(c.env);
    // Rekod lama (>180 hari) dibuang bila owner buka stats — bukan setiap hit.
    await c.env.DB.prepare("DELETE FROM shop_hits WHERE created_at < datetime('now', '-180 days')").run();

    const q = async (sql) => (await c.env.DB.prepare(sql).run())?.results || [];
    const [total] = await q('SELECT COUNT(*) AS n FROM shop_hits');
    const [hari] = await q("SELECT COUNT(*) AS n FROM shop_hits WHERE created_at >= date('now')");
    const [minggu] = await q("SELECT COUNT(*) AS n FROM shop_hits WHERE created_at >= datetime('now','-7 days')");

    return c.json({
      ok: true,
      jumlah: total?.n || 0,
      hari_ini: hari?.n || 0,
      minggu_ini: minggu?.n || 0,
      harian: await q("SELECT date(created_at) AS tarikh, COUNT(*) AS n FROM shop_hits WHERE created_at >= datetime('now','-14 days') GROUP BY tarikh ORDER BY tarikh"),
      top_path: await q("SELECT path, COUNT(*) AS n FROM shop_hits WHERE created_at >= datetime('now','-30 days') GROUP BY path ORDER BY n DESC LIMIT 12"),
      top_ref: await q("SELECT CASE WHEN ref = '' THEN '(terus)' ELSE ref END AS ref, COUNT(*) AS n FROM shop_hits WHERE created_at >= datetime('now','-30 days') GROUP BY ref ORDER BY n DESC LIMIT 10"),
      top_negara: await q("SELECT country, COUNT(*) AS n FROM shop_hits WHERE created_at >= datetime('now','-30 days') GROUP BY country ORDER BY n DESC LIMIT 10"),
      terkini: await q("SELECT path, country, created_at FROM shop_hits ORDER BY id DESC LIMIT 20"),
    });
  } catch (e) { return c.json({ ok: false, error: 'DB ralat' }, 500); }
});

// ----------------- KATALOG PRODUK (source of truth) -----------------
async function ensureProductsTable(env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, harga REAL NOT NULL DEFAULT 0, modal REAL NOT NULL DEFAULT 0, supplier TEXT DEFAULT "", gambar TEXT DEFAULT "", penerangan TEXT DEFAULT "", aktif INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
  ).run();
  // Kolum tambahan untuk kedai MyKiraShop. ALTER gagal = kolum sudah wujud.
  for (const sql of [
    "ALTER TABLE products ADD COLUMN slug TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN kategori TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN sizes TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN colors TEXT DEFAULT ''",
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* kolum sudah ada */ }
  }
}

/** "Hoodie Pullover — Kira" -> "hoodie-pullover-kira" */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Slug unik (tambah -2, -3 ... kalau dah dipakai). */
async function uniqueSlug(env, base, skipId = 0) {
  const slug0 = base || 'produk';
  for (let i = 0; i < 50; i++) {
    const cand = i ? `${slug0}-${i + 1}` : slug0;
    const r = await env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id != ? LIMIT 1')
      .bind(cand, skipId).run().catch(() => null);
    if (!(r?.results || []).length) return cand;
  }
  return `${slug0}-${Date.now().toString(36)}`;
}

async function listActiveProducts(env) {
  try {
    await ensureProductsTable(env);
    if (!env?.DB) return [];
    const r = await env.DB.prepare(
      'SELECT id, nama, harga, gambar, penerangan FROM products WHERE aktif = 1 ORDER BY id'
    ).run();
    return r?.results || [];
  } catch (e) { console.warn('products load gagal:', e?.message); return []; }
}

// Padankan nama barang order dengan katalog (fuzzy, dua hala)
function matchProduct(products, barangText) {
  const b = String(barangText || '').toLowerCase().trim();
  if (!b) return null;
  const words = b.split(/\s+/).filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  for (const p of products || []) {
    const n = String(p.nama || '').toLowerCase().trim();
    if (!n) continue;
    if (b.includes(n) || n.includes(b)) return p;
    let score = 0;
    for (const w of n.split(/\s+/)) { if (w.length > 2 && b.includes(w)) score += w.length; }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 4 ? best : null;
}

// ----------------- INGATAN PERBUALAN (v2) -----------------
async function ensureMemoryTable(env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS chat_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, content TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
  ).run();
}

async function saveMsg(env, phone, role, content) {
  try {
    await ensureMemoryTable(env);
    if (!env?.DB || !phone) return;
    await env.DB.prepare(
      'INSERT INTO chat_memory (phone, role, content) VALUES (?, ?, ?)'
    ).bind(phone, role, String(content).slice(0, 500)).run();
    await env.DB.prepare(
      'DELETE FROM chat_memory WHERE phone = ? AND id NOT IN (SELECT id FROM chat_memory WHERE phone = ? ORDER BY id DESC LIMIT 24)'
    ).bind(phone, phone).run();
  } catch (e) { console.warn('memory save gagal:', e?.message); }
}

async function getHistory(env, phone, limit = 10) {
  try {
    await ensureMemoryTable(env);
    if (!env?.DB || !phone) return [];
    const r = await env.DB.prepare(
      'SELECT role, content FROM chat_memory WHERE phone = ? ORDER BY id DESC LIMIT ?'
    ).bind(phone, limit).run();
    return (r?.results || []).reverse().map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
  } catch (e) { console.warn('memory load gagal:', e?.message); return []; }
}

// Pengekstrak order: jalan bila ada no telefon / SETUJU / CONFIRM, guna Workers AI free saja

// Bahasa: Melayu jika ada penanda Melayu dalam mesej semasa atau sejarah user; selain itu English
const MS_MARKERS = /(nak|tak|tidak|tiada|barang|berapa|bila|mana|siapa|saya|kami|kita|dia|mereka|punya|dengan|untuk|dari|pada|yang|dan|atau|tapi|sebab|kalau|jika|boleh|sudah|belum|pernah|sangat|juga|lagi|sahaja|banyak|sikit|murah|mahal|hantar|bayar|resit|telefon|nombor|alamat|nama|diskaun|promosi|bah\b|ngam|jua|kitani|bisai|mahal|murah)/i;
function detectLang(text, history = []) {
  if (MS_MARKERS.test(text)) return 'ms';
  for (const m of history) {
    if (m.role === 'user' && MS_MARKERS.test(m.content || '')) return 'ms';
  }
  return 'en';
}

const EXTRACT_PROMPT = `Anda pengekstrak order untuk kedai online. Baca perbualan dan jawab JSON SAHAJA, tiada teks lain.
Format: {"order":true/false,"nama":"","phone":"","barang":"","qty":1,"alamat":""}
order=true HANYA jika nama, no telefon, nama barang DAN alamat semuanya jelas dalam perbualan. Jika mana-mana tiada atau tidak jelas, jawab {"order":false}. qty nombor 1-99.`;

async function tryExtractOrder(env, history) {
  try {
    const convo = history.map((m) => (m.role === 'assistant' ? 'MyKira: ' : 'Customer: ') + m.content).join('\n').slice(-3000);
    const raw = await askWorkersAi(env, 'Perbualan:\n' + convo, EXTRACT_PROMPT);
    if (!raw) return null;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o?.order || !o.nama || !o.phone || !o.barang || !o.alamat) return null;
    return {
      nama: String(o.nama).slice(0, 100),
      phone: String(o.phone).slice(0, 30),
      barang: String(o.barang).slice(0, 200),
      qty: Math.max(1, Math.min(99, Number(o.qty) || 1)),
      alamat: String(o.alamat).slice(0, 500),
    };
  } catch (e) { console.warn('extract gagal:', e?.message); return null; }
}

// ----------------- WEB PORTAL UI -----------------
app.get('/', (c) => {
  const navButtons = TABS.map((t, idx) => `
    <button type="button" data-tab="${t.id}" class="tab-btn tab-pill shrink-0 px-3.5 py-2 text-xs font-semibold transition-all duration-200 ${idx === 0 ? (t.activeColor || 'bg-blue-600') + ' text-white shadow-lg shadow-black/30' : 'text-slate-400 hover:text-white hover:bg-white/5'}">
      ${t.label}
    </button>
  `).join('');

  const chatPanels = TABS.filter(t => t.id !== 'form').map((t, idx) => `
    <section id="tab-${t.id}" class="tab-panel ${idx === 0 ? '' : 'hidden'} flex flex-col flex-1 min-h-0">
      <div class="panel-head px-4 py-3 border-b border-white/5 flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl ${t.activeColor || 'bg-blue-600'} grid place-items-center text-base shrink-0 shadow-lg shadow-black/20">
          ${t.icon || ''}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-bold text-white truncate">${t.badge || t.label}</h2>
            <span class="badge-live shrink-0 text-[9px] font-bold uppercase tracking-wide text-emerald-300 bg-emerald-500/15 border border-emerald-500/25 px-1.5 py-0.5 rounded-full">Online</span>
          </div>
          <p class="text-[11px] text-slate-400 truncate">${t.headerBanner || t.subtitle || ''}</p>
        </div>
      </div>

      <div id="${t.id}-chat-box" class="chat-box flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        <div class="flex items-start gap-2">
          <div class="w-7 h-7 rounded-lg ${t.activeColor || 'bg-blue-600'} grid place-items-center text-xs shrink-0 mt-0.5">${t.icon || ''}</div>
          <div class="max-w-[82%] bubble-bot border ${t.borderStyle || 'border-slate-600/50'} px-3.5 py-2.5 text-sm leading-relaxed">
            ${t.welcomeMsg}
          </div>
        </div>

        ${(t.chips && t.chips.length) ? `
        <div class="flex flex-wrap gap-1.5 pl-9">
          ${t.chips.map((c, ci) => `
            <button type="button" class="chip-btn text-[11px] font-medium px-2.5 py-1.5 rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition" data-chip-tab="${t.id}" data-chip-text="${escapeHtml(c)}">${escapeHtml(c)}</button>
          `).join('')}
        </div>` : ''}
      </div>

      <div id="${t.id}-loading" class="hidden px-4 pb-1.5 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay:0ms"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay:150ms"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay:300ms"></span>
        <span class="text-[11px] text-slate-500 ml-1">Sedang menaip...</span>
      </div>

      <div class="px-3 py-2.5 border-t border-white/5 bg-slate-900/60 backdrop-blur pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <form id="${t.id}-form" class="flex gap-2 items-end">
          <input id="${t.id}-input" type="text" required placeholder="${t.placeholder || 'Tulis mesej...'}" autocomplete="off" class="flex-1 min-w-0 bg-slate-800/80 border border-white/10 rounded-2xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:bg-slate-800 transition" />
          <button type="submit" aria-label="Hantar" class="shrink-0 w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 grid place-items-center shadow-lg shadow-blue-600/25 transition active:scale-95">
            <svg viewBox="0 0 24 24" class="w-4 h-4 text-white" fill="currentColor"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>
          </button>
        </form>
      </div>
    </section>
  `).join('');

  // String.raw: JANGAN tukar ke template literal biasa. Tanpa ia, \x60 \* \s \n
  // di dalam <script> akan dimakan sebagai escape JS semasa render — regex jadi
  // rosak, <script> gagal parse, dan SELURUH frontend mati (chat tak berfungsi).
  return c.html(String.raw`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
      <meta name="theme-color" content="#0b1120" />
      <title>AwangBot78 - Multi-Bot Portal</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        :root { color-scheme: dark; }
        html, body { height: 100%; }
        body {
          background: #050a16;
          background-image:
            radial-gradient(80rem 50rem at 15% -10%, rgba(37,99,235,.16), transparent 60%),
            radial-gradient(70rem 45rem at 100% 0%, rgba(168,85,247,.13), transparent 55%),
            radial-gradient(60rem 40rem at 50% 110%, rgba(16,185,129,.10), transparent 60%);
          background-attachment: fixed;
          -webkit-tap-highlight-color: transparent;
        }
        .tab-pill { border-radius: 9999px; white-space: nowrap; }
        .tab-strip {
          scrollbar-width: none;
          -ms-overflow-style: none;
          scroll-snap-type: x proximity;
          -webkit-overflow-scrolling: touch;
          scroll-padding-inline: 1rem;
          overscroll-behavior-x: contain;
        }
        .tab-strip::-webkit-scrollbar { display: none; }
        select#tab-select option { background: #1e293b; color: #f1f5f9; }
        .bubble-bot { background: rgba(30,41,59,.72); border-radius: 1rem 1rem 1rem .25rem; color: #e2e8f0; backdrop-filter: blur(4px); }
        .bubble-me { background: linear-gradient(135deg,#3b82f6,#2563eb); border-radius: 1rem 1rem .25rem 1rem; color:#fff; box-shadow:0 8px 20px -8px rgba(37,99,235,.6); }
        .bubble-err { background: rgba(127,29,29,.22); border:1px solid rgba(248,113,113,.3); border-radius:1rem 1rem 1rem .25rem; }
        .panel-head { background: linear-gradient(180deg, rgba(15,23,42,.92), rgba(15,23,42,.72)); backdrop-filter: blur(10px); }
        .chat-box::-webkit-scrollbar, .tab-strip::-webkit-scrollbar { width: 5px; height: 5px; }
        .chat-box::-webkit-scrollbar-thumb { background: rgba(148,163,184,.28); border-radius: 9999px; }
        .fade-in { animation: fadeIn .28s cubic-bezier(.22,1,.36,1) both; }
        @keyframes fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }
        @media (prefers-reduced-motion: reduce) { * { animation-duration:.01ms !important; transition-duration:.01ms !important; } }
      </style>
    </head>
    <body class="text-white flex items-center justify-center sm:p-4 p-0">
      <div class="w-full sm:max-w-2xl sm:h-[92dvh] sm:rounded-3xl h-[100dvh] bg-slate-900/70 border-white/10 sm:border backdrop-blur-xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden">
        <header class="shrink-0 border-b border-white/5 bg-slate-900/70 backdrop-blur pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div class="px-4 pb-2.5 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <div class="min-w-0">
                <h1 class="font-bold text-sm md:text-base bg-gradient-to-r from-blue-400 via-sky-300 to-purple-400 bg-clip-text text-transparent truncate">AwangBot78 Portal</h1>
                <p class="text-[10px] text-slate-500 truncate">${TABS.length} demo bot sedia digunakan</p>
              </div>
            </div>
            <span class="shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-300 bg-white/5 border border-white/10 px-2.5 py-1 rounded-full">Live</span>
          </div>

          <div class="px-4 pb-2">
            <div class="relative">
              <select id="tab-select" aria-label="Pilih bot" class="w-full appearance-none bg-slate-800/80 border border-white/10 rounded-xl pl-9 pr-9 py-2.5 text-sm font-semibold text-white focus:outline-none focus:border-blue-500/60 transition">
                ${TABS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}
              </select>
              <span id="tab-select-icon" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm">${TABS[0].icon || ''}</span>
              <svg class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </div>

          <div class="tab-strip flex gap-1.5 overflow-x-auto px-4 pb-3">
            ${navButtons}
          </div>
        </header>

        <main class="relative flex-1 min-h-0 flex flex-col">
        ${chatPanels}

        <!-- TAB BORANG PERMOHONAN -->
        <section id="tab-form" class="tab-panel hidden flex-1 min-h-0 overflow-y-auto px-4 py-5">
          <div class="flex items-center gap-2.5 mb-1">
            <div class="w-9 h-9 rounded-xl bg-emerald-500 grid place-items-center text-base shadow-lg shadow-black/20">📝</div>
            <div>
              <h2 class="text-base font-bold text-white">Borang Permohonan</h2>
              <p class="text-[11px] text-slate-400">Tempahan bot custom untuk perniagaan anda</p>
            </div>
          </div>
          <p class="text-[11px] text-slate-500 mb-4 pl-[2.75rem]">Data disimpan terus ke pangkalan data D1 kami.</p>
          <form id="lead-form" action="/register" method="POST" class="space-y-3">
            <div>
              <label class="block text-xs font-medium mb-1.5 text-slate-300">Nama Anda / Syarikat / Agensi</label>
              <input name="nama" type="text" required placeholder="Contoh: Ahmad / Pejabat Daerah / Syarikat" class="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 transition" />
            </div>
            <div>
              <label class="block text-xs font-medium mb-1.5 text-slate-300">Nombor WhatsApp / Telegram / Emel</label>
              <input name="kontak" type="text" required placeholder="Contoh: 0123456789 atau e-mel" class="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 transition" />
            </div>
            <div>
              <label class="block text-xs font-medium mb-1.5 text-slate-300">Pilihan Pakej</label>
              <select name="pakej" class="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/60 transition">
                <option value="Pakej A (RM30/bln)">Pakej A (RM30/bln) — Bot Asas FAQ (PKS)</option>
                <option value="Pakej B (RM50/bln)">Pakej B (RM50/bln) — Pakej Standard (PKS)</option>
                <option value="Pakej C (RM90/bln)">Pakej C (RM90/bln) — Full Custom (PKS)</option>
                <option value="Pakej Enterprise / Kerajaan">Pakej Enterprise / Kerajaan (Sebut Harga Khas / Custom Quote)</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1.5 text-slate-300">Fungsi Bot Yang Diingini</label>
              <textarea name="soalan" rows="3" required placeholder="Terangkan keperluan bot anda..." class="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 transition"></textarea>
            </div>
            <button type="submit" class="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 font-bold py-3 rounded-xl transition active:scale-[.98] text-sm shadow-lg shadow-emerald-600/20">Hantar Permohonan</button>
          </form>
        </section>
        </main>
      </div>
    </body>

    <script>
      var tabsConfig = ${JSON.stringify(TABS)};

      function escapeHtml(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
      }

      function renderMarkdown(raw) {
        var s = escapeHtml(raw);
        s = s.replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, function(m, code) {
          return '<pre class="my-2 p-2.5 rounded-lg bg-black/40 overflow-x-auto text-[12px] leading-relaxed"><code>' + code.trim() + '</code></pre>';
        });
        s = s.replace(/\x60([^\x60\n]+)\x60/g, '<code class="px-1 py-0.5 rounded bg-black/35 text-[12px] font-mono">$1</code>');
        s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
        s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-300 underline">$1</a>');
        s = s.replace(/^(#{1,6})\s+(.+)$/gm, function(m, h, t) {
          return '<b class="block mt-2 mb-1 text-slate-50">' + t + '</b>';
        });
        s = s.split('\n').map(function(line) {
          var m = line.match(/^\s*[-*\u2022]\s+(.*)$/);
          if (m) return '<span class="flex gap-1.5 my-0.5"><span class="text-slate-400 select-none">\u2022</span><span>' + m[1] + '</span></span>';
          var n = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
          if (n) return '<span class="flex gap-1.5 my-0.5"><span class="text-slate-400 select-none">' + n[1] + '.</span><span>' + n[2] + '</span></span>';
          if (!line.trim()) return '<div class="h-1.5"></div>';
          return '<div>' + line + '</div>';
        }).join('');
        return s;
      }

      function switchTab(selectedTab) {
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.add('hidden'); });
        var targetPanel = document.getElementById('tab-' + selectedTab);
        if (targetPanel) {
          targetPanel.classList.remove('hidden');
          targetPanel.classList.remove('fade-in');
          void targetPanel.offsetWidth;
          targetPanel.classList.add('fade-in');
        }

        var activeBtn = null;
        document.querySelectorAll('.tab-btn').forEach(function(btn) {
          var isCurrent = btn.dataset.tab === selectedTab;
          var tabObj = tabsConfig.find(function(t) { return t.id === btn.dataset.tab; });
          var activeClass = (tabObj && tabObj.activeColor) ? tabObj.activeColor : 'bg-blue-600';

          btn.className = 'tab-btn tab-pill shrink-0 px-3.5 py-2 text-xs font-semibold transition-all duration-200 ' + (isCurrent ? activeClass + ' text-white shadow-lg shadow-black/30' : 'text-slate-400 hover:text-white hover:bg-white/5');
          if (isCurrent) activeBtn = btn;
        });

        if (activeBtn && activeBtn.scrollIntoView) {
          activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }

        var sel = document.getElementById('tab-select');
        if (sel && sel.value !== selectedTab) sel.value = selectedTab;

        var selIcon = document.getElementById('tab-select-icon');
        var selObj = tabsConfig.find(function(t) { return t.id === selectedTab; });
        if (selIcon && selObj) selIcon.textContent = selObj.icon || '';
      }

      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
      });

      var tabSelect = document.getElementById('tab-select');
      if (tabSelect) {
        tabSelect.addEventListener('change', function() { switchTab(tabSelect.value); });
      }

      document.querySelectorAll('.chip-btn').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var input = document.getElementById(chip.dataset.chipTab + '-input');
          if (input) { input.value = chip.dataset.chipText; input.focus(); }
        });
      });

      tabsConfig.filter(function(t) { return t.id !== 'form'; }).forEach(function(t) {
        var formElem = document.getElementById(t.id + '-form');
        var inputElem = document.getElementById(t.id + '-input');
        var boxElem = document.getElementById(t.id + '-chat-box');
        var loadingElem = document.getElementById(t.id + '-loading');
        var icon = (t.icon || '') + '';
        var accent = (t.activeColor || 'bg-blue-600') + ' text-white';
        var botBorder = t.borderStyle ? t.borderStyle : 'border-slate-600/50';

        function scrollDown() { boxElem.scrollTop = boxElem.scrollHeight; }

        if (formElem) {
          formElem.addEventListener('submit', async function(e) {
            e.preventDefault();
            var text = inputElem.value.trim();
            if (!text) return;

            var userBubble = '<div class="flex justify-end fade-in"><div class="bubble-me px-3.5 py-2.5 max-w-[82%] text-sm leading-relaxed break-words">' + escapeHtml(text) + '</div></div>';
            boxElem.insertAdjacentHTML('beforeend', userBubble);
            inputElem.value = '';
            scrollDown();
            loadingElem.classList.remove('hidden');
            loadingElem.classList.add('flex');
            scrollDown();

            try {
              var response = await fetch(t.apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
              });
              var data = await response.json();
              if (!response.ok) throw new Error(data?.error || 'Ralat API.');

              var botBubble = '<div class="flex items-start gap-2 fade-in">' +
                '<div class="w-7 h-7 rounded-lg ' + accent + ' grid place-items-center text-xs shrink-0 mt-0.5">' + icon + '</div>' +
                '<div class="bubble-bot border ' + botBorder + ' px-3.5 py-2.5 max-w-[82%] text-sm leading-relaxed break-words">' +
                (t.badge ? '<b class="block text-[11px] mb-1 opacity-70">' + escapeHtml(t.badge) + '</b>' : '') +
                renderMarkdown(data.reply || 'Tiada jawapan.') + '</div></div>';
              boxElem.insertAdjacentHTML('beforeend', botBubble);
            } catch (err) {
              var errorBubble = '<div class="flex items-start gap-2 fade-in">' +
                '<div class="w-7 h-7 rounded-lg bg-red-500/30 text-xs grid place-items-center shrink-0 mt-0.5">!</div>' +
                '<div class="bubble-err px-3.5 py-2.5 max-w-[82%] text-sm break-words">Ralat: ' + escapeHtml(err.message) + '</div></div>';
              boxElem.insertAdjacentHTML('beforeend', errorBubble);
            } finally {
              loadingElem.classList.add('hidden');
              loadingElem.classList.remove('flex');
              scrollDown();
            }
          });
        }
      });
    </script>
    </html>
  `);
});

// Ambil senarai produk aktif dari D1 untuk disuntik ke prompt AI.
// Tujuan: bot WhatsApp tahu harga/nama barang sebenar (jangan reka harga).
async function katalogPrompt(env) {
  try {
    if (!env?.DB) return '';
    const r = await env.DB.prepare(
      'SELECT nama, harga, penerangan FROM products WHERE aktif = 1 ORDER BY id DESC LIMIT 30'
    ).all();
    const rows = r?.results || [];
    if (!rows.length) return '';
    const senarai = rows.map((p) => {
      const harga = Number(p.harga || 0).toFixed(2);
      const nota = String(p.penerangan || '').replace(/\s+/g, ' ').slice(0, 110);
      return `• ${p.nama} — RM${harga}${nota ? ' — ' + nota : ''}`;
    }).join('\n');
    return `\n\nKATALOG SEMASA (harga ini SAH — jangan reka harga/stok lain):\n${senarai}\n\nBila customer tanya barang/harga, jawab terus dari senarai di atas dan tanya qty. Kalau barang tiada dalam senarai, kata "barang tu tak masuk stok lagi boss". Semua harga sudah termasuk pos (15-30 hari), opsyen laju +RM5 boleh disebut.`;
  } catch (e) {
    console.warn('katalogPrompt gagal:', e?.message);
    return '';
  }
}

// ----------------- API ROUTINGS (WEB PORTAL) -----------------
app.post('/api/chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), AWANGBOT_PROMPT);
  await saveLead(c.env, 'Web Chat User', body.message || '-');
  return c.json({ reply });
});

// Dropship 017 bisnes: untuk bot-wa-017 (Baileys QR) + MyGate
app.post('/api/dropship-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.message || '').trim();
  const from = String(body.from || 'web').trim();
  if (!text) return c.json({ reply: 'Ya boss, mau order apa? Bagi nama barang + qty.' });
  const useMemory = from && from !== 'web';
  const history = useMemory ? await getHistory(c.env, from) : [];
  // Auto tracking: kalau tanya tracking, jawab dari DB dulu tanpa AI
  if (/barang kat mana|tracking|sampai bila|dah pos|trek|where.*parcel|where.*order|track.*order/i.test(text) && useMemory) {
    try {
      const phoneDigits = from.replace(/\D/g, '').slice(-10);
      const hit = await getLatestTracking(c.env, from).catch(() => null)
        || await getLatestTracking(c.env, phoneDigits).catch(() => null);
      const en = detectLang(text, history) === 'en';
      if (hit?.tracking) return c.json({ reply: en ? `Order #${hit.id} (${hit.barang}) status: ${hit.status}. Tracking: ${hit.tracking}` : `Order #${hit.id} (${hit.barang}) status: ${hit.status}. Tracking: ${hit.tracking} boss.` });
      if (hit) return c.json({ reply: en ? `Order #${hit.id} (${hit.barang}) status: ${hit.status}. Tracking not out yet, will update tomorrow.` : `Order #${hit.id} (${hit.barang}) status: ${hit.status}. Tracking belum keluar, aku update esok boss.` });
    } catch (e) { console.warn('tracking lookup gagal:', e?.message); }
  }
  const lang = detectLang(text, history);
  // Tanya pasal BOT (pakej/setup/sewa) -> jawab jualan bot, bukan dropship (kecuali jelas pasal order/tracking/bayar)
  const isBotSales = /(bot|pakej|package|awangbot|setup bot|sewa bot|buat bot|nak bot|beli bot|bot whatsapp|bot telegram)/i.test(text)
    && !/(order|tracking|trek|sampai bila|dah pos|refund|return|resit|transfer|bayar|payment|confirm|setuju)/i.test(text);
  const basePrompt = isBotSales ? PROMPT_017 : (lang === 'ms' ? PROMPT_DROPSHIP : PROMPT_DROPSHIP_EN);
  const salesPrompt = isBotSales ? basePrompt : basePrompt + await katalogPrompt(c.env);
  let reply = await askAi(c.env, text, salesPrompt, history);
  // Auto-save order: jalan bila ada no telefon / SETUJU / CONFIRM, dan belum pernah simpan (bukan chat jualan bot)
  if (useMemory && !isBotSales) {
    const alreadySaved = history.some((m) => m.role === 'assistant' && /Order #\d+ noted/.test(m.content || ''));
    const looksComplete = /01\d{8,9}/.test(text)
      || /^(setuju|sah|jadi|confirm|confirmed|ok jadi|baik jadi)/i.test(text.trim())
      || /^(yes|yeah|yup|ya)[\s!.]*$/i.test(text.trim());
    if (!alreadySaved && looksComplete) {
      const ord = await tryExtractOrder(c.env, [...history, { role: 'user', content: text }]);
      if (ord) {
        const id = await saveDropshipOrder(c.env, ord).catch(() => null);
        const payUrl = 'https://awangbotv3.mykira.workers.dev/pay?order=' + id;
        const trackUrl = 'https://awangbotv3.mykira.workers.dev/track?id=' + id;
        if (id && lang === 'en') reply += `\n\n✅ Order #${id} noted — ${ord.barang} x${ord.qty}. Pay here: ${payUrl} then send the receipt here.\n📦 Track anytime: ${trackUrl}`;
        else if (id) reply += `\n\n✅ Order #${id} noted boss — ${ord.barang} x${ord.qty}. Bayar sini: ${payUrl} lepas tu bagi resit kat sini ya.\n📦 Semak status sendiri: ${trackUrl}`;
        // Bisik owner (muka public bot tak berubah)
        if (id && c.env.BOT_TOKEN && c.env.ADMIN_ID) {
          await sendTelegramMessage(c.env.BOT_TOKEN, c.env.ADMIN_ID,
            `🔔 <b>Order baru #${id} (MyKira)</b>\n📦 ${escapeHtml(ord.barang)} x${ord.qty}\n👤 ${escapeHtml(ord.nama)} / ${escapeHtml(ord.phone)}\n📍 ${escapeHtml(ord.alamat)}`);
        }
      }
    }
    await saveMsg(c.env, from, 'user', text);
    await saveMsg(c.env, from, 'assistant', reply);
  }
  await saveLead(c.env, `Dropship017 (${from})`, text);
  return c.json({ reply });
});

// MyGate / borang order -> simpan D1
app.post('/api/dropship-order', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = await saveDropshipOrder(c.env, {
    nama: String(body.nama || '').slice(0, 100),
    phone: String(body.phone || '').slice(0, 30),
    barang: String(body.barang || '').slice(0, 200),
    qty: Math.max(1, Math.min(99, Number(body.qty) || 1)),
    alamat: String(body.alamat || '').slice(0, 500),
    // Jumlah autoritatif (pilihan) — MyKiraShop hantar jumlah penuh termasuk pos.
    harga: Number(body.harga) > 0 ? Number(body.harga) : null,
  }).catch(() => null);
  if (!id) return c.json({ ok: false, error: 'DB tidak sedia' }, 500);
  await saveLead(c.env, `DropshipOrder #${id}`, `${body.nama} / ${body.phone} / ${body.barang} x${body.qty}`);
  if (c.env.BOT_TOKEN && c.env.ADMIN_ID) {
    await sendTelegramMessage(c.env.BOT_TOKEN, c.env.ADMIN_ID,
      `🔔 <b>Order baru #${id} (MyKira, borang)</b>\n📦 ${escapeHtml(String(body.barang || ''))} x${body.qty}\n👤 ${escapeHtml(String(body.nama || ''))} / ${escapeHtml(String(body.phone || ''))}`);
  }
  return c.json({ ok: true, orderId: id });
});

// ----------------- SOLANA PAY (MyKira Niaga) -----------------
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function salesWallet(env) {
  return env?.SALES_WALLET || '3mqWxEAEC2HtEqWwofeeNwmov9XqE4v5d83ZdSsstk4E';
}

// Butiran order awam (tanpa nama/phone/alamat) untuk halaman bayaran
app.get('/api/order', async (c) => {
  const id = Number(c.req.query('order') || c.req.query('id') || 0);
  if (!id) return c.json({ ok: false, error: 'id diperlukan' }, 400);
  try {
    await ensureDropshipTables(c.env);
    // Kalau kolum `harga` tiada (contoh ALTER gagal), jangan biarkan halaman
    // bayaran rosak — cuba lagi tanpa kolum itu.
    let row;
    try {
      row = await c.env.DB.prepare(
        'SELECT id, barang, qty, status, harga FROM dropship_orders WHERE id = ?'
      ).bind(id).run();
    } catch (e) {
      row = await c.env.DB.prepare(
        'SELECT id, barang, qty, status FROM dropship_orders WHERE id = ?'
      ).bind(id).run();
    }
    const hit = row?.results?.[0];
    if (!hit) return c.json({ ok: false, error: 'tiada order' }, 404);
    // Jumlah: utamakan nilai autoritatif yang disimpan oleh shop (sudah termasuk
    // kos pos). Kalau tiada, baru cuba padan dari katalog.
    let harga = null, product_id = null;
    const tersimpan = Number(hit.harga);
    if (Number.isFinite(tersimpan) && tersimpan > 0) {
      harga = tersimpan;
    } else {
      try {
        const mp = matchProduct(await listActiveProducts(c.env), hit.barang);
        if (mp) { harga = Number(mp.harga) * Number(hit.qty || 1); product_id = mp.id; }
      } catch (e) { /* abaikan */ }
    }
    return c.json({ ok: true, ...hit, harga, product_id });
  } catch (e) { return c.json({ ok: false, error: 'DB ralat' }, 500); }
});

// Katalog awam (tanpa modal/supplier)
app.get('/api/products', async (c) => {
  const list = await listActiveProducts(c.env);
  return c.json({ ok: true, products: list });
});

// Katalog penuh untuk kedai MyKiraShop (tanpa modal). Dipanggil melalui
// service binding dari worker kedai. Hanya produk berkategori kedai.
app.get('/api/catalog-shop', async (c) => {
  try {
    await ensureProductsTable(c.env);
    if (!c.env?.DB) return c.json({ ok: true, products: [] });
    const r = await c.env.DB.prepare(
      "SELECT slug, nama, harga, gambar, penerangan, kategori, sizes, colors FROM products WHERE aktif = 1 AND kategori IN ('baju', 'accessory') ORDER BY id"
    ).run();
    return c.json({ ok: true, products: r?.results || [] });
  } catch (e) {
    console.warn('catalog-shop gagal:', e?.message);
    return c.json({ ok: false, products: [] }, 500);
  }
});

// Halaman bayaran: DuitNow (MY) / SOL / USDC / PayPal (global)
app.get('/pay', async (c) => {
  const orderId = String(c.req.query('order') || '').slice(0, 12);
  const isDonate = String(c.req.query('donate') || '') === '1';
  const wallet = salesWallet(c.env);
  const duitnowQR = String(c.env?.DUITNOW_QR || '');
  const paypalMe = String(c.env?.PAYPAL_ME || '');
  return c.html(`<!DOCTYPE html>
<html lang="ms"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bayar — MyKira Niaga</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4">
<div class="w-full max-w-md bg-slate-900 border border-white/10 rounded-3xl p-6 space-y-4">
<div class="text-center"><div class="text-2xl">💳</div>
<h1 class="font-bold text-lg">${isDonate ? 'MyKira Niaga — Derma ☕' : 'MyKira Niaga — Bayaran'}</h1>
<p id="orderLine" class="text-xs text-slate-400">${orderId ? 'Order #' + escapeHtml(orderId) : 'Isi butiran order di bawah'}</p></div>
<label class="block text-xs text-slate-400">Order ID (kalau ada)<input id="order" value="${escapeHtml(orderId)}" class="mt-1 w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm" placeholder="cth: 5"></label>
<div class="grid grid-cols-4 gap-2">
<button data-pay="duitnow" class="paytab py-2.5 rounded-xl font-bold text-sm bg-pink-600">DuitNow</button>
<button data-pay="SOL" class="paytab py-2.5 rounded-xl font-bold text-sm bg-white/10 border border-white/10">◎ SOL</button>
<button data-pay="USDC" class="paytab py-2.5 rounded-xl font-bold text-sm bg-white/10 border border-white/10">$ USDC</button>
<button data-pay="paypal" class="paytab py-2.5 rounded-xl font-bold text-sm bg-white/10 border border-white/10">PayPal</button></div>
<div id="panel-duitnow">
<div class="text-center">${duitnowQR ? '<img id="dnqr" class="mx-auto rounded-2xl border border-white/10" width="220" height="220" alt="DuitNow QR">' : '<p class="text-xs text-amber-300">QR DuitNow belum diset — WS admin 017.</p>'}
<p class="text-xs text-slate-300 mt-2">AWANG AZAMAN @ AZMAN BIN<br><span class="text-slate-500">Scan dengan mana-mana bank / e-wallet MY, isi jumlah ikut order</span></p></div>
</div>
<div id="panel-crypto" class="hidden">
<label class="block text-xs text-slate-400">Jumlah<input id="amount" type="number" min="0" step="0.01" class="mt-1 w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm" placeholder="cth: 25 (RM) / 5 (USD)"></label>
<div class="text-center mt-2"><img id="qr" class="mx-auto rounded-2xl border border-white/10" width="220" height="220" alt="Scan untuk bayar">
<a id="openBtn" href="#" class="inline-block mt-3 text-sm text-sky-300 underline">Buka dalam Phantom →</a></div>
<div class="text-xs text-slate-400 break-all mt-2">Penerima:<br><span id="addr" class="text-slate-200 font-mono">${wallet}</span>
<button id="copyBtn" class="ml-2 px-2 py-1 text-[11px] bg-white/10 rounded-lg">Salin</button></div>
</div>
<div id="panel-paypal" class="hidden text-center">
${paypalMe ? '<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(paypalMe) + '" class="mx-auto rounded-2xl border border-white/10" width="220" height="220" alt="PayPal QR"><a id="ppBtn" href="#" class="inline-block w-full bg-sky-500 hover:bg-sky-400 font-bold py-3 rounded-xl text-sm mt-3">Bayar dengan PayPal →</a><p class="text-[11px] text-slate-500 mt-2">Fee PayPal ~4-5% ditanggung pembeli. Tulis Order ID dalam nota PayPal.</p>' : '<p class="text-xs text-amber-300">PayPal belum diset — WS admin 017.</p>'}
</div>
<p class="text-[11px] text-slate-500">Lepas bayar hantar <b>resit / tx signature</b> ke WhatsApp 017. Order diproses selepas bayaran disahkan.</p>
<a href="https://wa.me/60173735431" class="block text-center w-full bg-emerald-500 hover:bg-emerald-400 font-bold py-3 rounded-xl text-sm">Sahkan via WhatsApp 017</a>
</div>
<script>
var wallet="${wallet}", usdcMint="${USDC_MINT}", token="duitnow", isDonate=${isDonate ? '1' : '0'};
var duitnowQR=${JSON.stringify(duitnowQR)}, paypalMe=${JSON.stringify(paypalMe)};
function solUrl(){
  var amt=parseFloat((document.getElementById('amount')||{}).value||'0');
  var ord=(document.getElementById('order')||{}).value||'';
  var memo=isDonate==='1'?'MKIRA-DONATE':'MKIRA-'+(ord||'NA');
  var u='solana:'+wallet+'?amount='+amt+'&label='+encodeURIComponent('MyKira Niaga')+'&message='+encodeURIComponent('Order '+memo)+'&memo='+encodeURIComponent(memo);
  if(token==='USDC') u+='&spl-token='+usdcMint;
  return u;
}
function refresh(){
  if(token==='duitnow'&&duitnowQR){document.getElementById('dnqr').src='https://api.qrserver.com/v1/create-qr-code/?size=220x220&data='+encodeURIComponent(duitnowQR);}
  if(token==='SOL'||token==='USDC'){var u=solUrl();document.getElementById('qr').src='https://api.qrserver.com/v1/create-qr-code/?size=220x220&data='+encodeURIComponent(u);document.getElementById('openBtn').href=u;}
  if(token==='paypal'&&paypalMe){var amt=parseFloat((document.getElementById('amountPaypal')||{}).value||'0');var base=paypalMe;document.getElementById('ppBtn').href=amt>0?(base+'/'+amt):base;}
  var o=(document.getElementById('order')||{}).value;
  var line=document.getElementById('orderLine');
  if(o){fetch('/api/order?id='+encodeURIComponent(o)).then(function(r){return r.json()}).then(function(d){if(d.ok){line.textContent='Order #'+d.id+' — '+d.barang+' x'+d.qty+' ('+d.status+')';if(d.harga&&!document.getElementById('amount').value){document.getElementById('amount').value=d.harga;line.textContent+=' — RM'+d.harga;refresh()}}}).catch(function(){})}
}
function showTab(t){
  token=t;
  ['duitnow','crypto','paypal'].forEach(function(p){document.getElementById('panel-'+p).classList.add('hidden')});
  if(t==='duitnow')document.getElementById('panel-duitnow').classList.remove('hidden');
  else if(t==='paypal')document.getElementById('panel-paypal').classList.remove('hidden');
  else document.getElementById('panel-crypto').classList.remove('hidden');
  var btns=document.querySelectorAll('.paytab');
  btns.forEach(function(b){var on=b.getAttribute('data-pay')===t;b.className='paytab py-2.5 rounded-xl font-bold text-sm '+(on?'bg-pink-600':'bg-white/10 border border-white/10')});
  refresh();
}
document.querySelectorAll('.paytab').forEach(function(b){b.onclick=function(){showTab(b.getAttribute('data-pay'))}});
var amtEl=document.getElementById('amount');if(amtEl)amtEl.oninput=refresh;
document.getElementById('order').oninput=refresh;
var cp=document.getElementById('copyBtn');if(cp)cp.onclick=function(){navigator.clipboard.writeText(wallet)};
showTab('duitnow');
</script></body></html>`);
});
app.get('/api/dropship-tracking', async (c) => {
  const phone = String(c.req.query('phone') || '').trim();
  if (!phone) return c.json({ ok: false, error: 'phone diperlukan' }, 400);
  const hit = await getLatestTracking(c.env, phone);
  if (!hit) return c.json({ ok: false, error: 'tiada order' }, 404);
  return c.json({ ok: true, ...hit });
});

// Halaman semak status order (public, tanpa data peribadi)
app.get('/track', async (c) => {
  const orderId = String(c.req.query('id') || '').slice(0, 12);
  return c.html(`<!DOCTYPE html>
<html lang="ms"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semak Order — MyKira Niaga</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4">
<div class="w-full max-w-md bg-slate-900 border border-white/10 rounded-3xl p-6 space-y-4">
<div class="text-center"><div class="text-2xl">📦</div>
<h1 class="font-bold text-lg">Semak Status Order</h1>
<p class="text-xs text-slate-400">MyKira Niaga — masuk Order ID dari bot</p></div>
<div class="flex gap-2">
<input id="order" value="${escapeHtml(orderId)}" inputmode="numeric" class="flex-1 min-w-0 bg-slate-800 border border-white/10 rounded-xl px-4 py-2.5 text-sm" placeholder="cth: 5">
<button id="go" class="shrink-0 px-5 rounded-xl font-bold text-sm bg-gradient-to-r from-blue-500 to-cyan-500">Check</button></div>
<div id="result" class="hidden rounded-2xl border border-white/10 bg-slate-800/60 p-4 text-sm space-y-1"></div>
<p class="text-[11px] text-slate-500">Tak jumpa? Order ID ada dalam mesej bot lepas SETUJU/CONFIRM. Tanya admin: <a class="text-sky-300 underline" href="https://wa.me/60173735431">WS 017</a></p>
</div>
<script>
function lookup(){
  var id=(document.getElementById('order').value||'').trim();
  var box=document.getElementById('result');
  if(!id){box.classList.remove('hidden');box.innerHTML='Masuk Order ID dulu boss.';return}
  fetch('/api/order?id='+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(d){
    box.classList.remove('hidden');
    if(!d.ok){box.innerHTML='Order #'+id+' tak jumpa. Check nombor betul ke.';return}
    var step={'baru':1,'order_supplier':2,'pos':3,'sampai':4,'refund':0}[d.status]||1;
    var bar='●'.repeat(step)+'○'.repeat(Math.max(0,4-step));
    box.innerHTML='<div><b>Order #'+d.id+' — '+d.barang+' x'+d.qty+'</b></div><div>Status: <b>'+String(d.status).replace(/_/g,' ')+'</b></div><div style="letter-spacing:4px;color:#fcd34d">'+bar+'</div><div style="font-size:11px;color:#94a3b8">baru → order supplier → pos → sampai</div>';
  }).catch(function(){box.classList.remove('hidden');box.innerHTML='Line slow, cuba lagi.'});
}
document.getElementById('go').onclick=lookup;
if(document.getElementById('order').value)lookup();
</script></body></html>`);
});

// Content factory: jana content calendar TikTok untuk hero products
app.post('/api/content-plan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let products = (Array.isArray(body.products) ? body.products : [])
    .map((s) => String(s).slice(0, 80))
    .filter(Boolean)
    .slice(0, 5);
  // catalog:true -> baca dari D1 (source of truth)
  if (!products.length && body.catalog) {
    const cat = await listActiveProducts(c.env);
    products = cat.map((p) => `${p.nama} (RM${p.harga})`).slice(0, 5);
  }
  if (!products.length) return c.json({ ok: false, error: 'products diperlukan, cth ["kopi sabah","kuali viral"] atau {"catalog":true}' }, 400);
  const lang = body.lang === 'en' ? 'en' : body.lang === 'both' ? 'both' : 'ms';
  const days = Math.max(1, Math.min(14, Number(body.days) || 7));
  const sysPrompt = `You are a TikTok content strategist for a dropship store (MyKira Niaga, Malaysia + international audience). Output a content calendar as JSON ONLY, no other text. Format: [{"day":1,"product":"...","hook":"first-3-seconds scroll-stopper line","script":"15-30 second spoken demo script","caption":"short caption with WhatsApp order CTA","hashtags":["#niche","#broad"],"postTime":"8pm MYT","cta":"...","discountCode":"TIK1"}]. Rules: one video per day, rotate products; hooks must stop scrollers; scripts simple show-and-tell demo; captions short with order CTA; hashtags mix niche + broad; discountCode unique TIK1..TIKn for tracking which video converts. Language: ${lang === 'both' ? 'alternate Malay and English days, mark with "lang" field per item' : lang === 'en' ? 'English' : 'Bahasa Melayu casual Sabah style'}. Days: ${days}.`;
  const raw = await askGemini(
    c.env,
    `Hero products: ${products.join(', ')}. Generate ${days}-day plan.`,
    sysPrompt,
    [],
    { maxTokens: 3000 }
  );
  if (!raw) return c.json({ ok: false, error: 'AI sibuk, cuba lagi' }, 502);
  let plan = null;
  try {
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (m) plan = JSON.parse(m[0]);
  } catch (e) { /* fallthrough */ }
  if (!Array.isArray(plan)) return c.json({ ok: false, error: 'parse gagal', raw: String(raw).slice(0, 500) }, 502);
  // Hantar ringkasan ke Telegram owner kalau diminta
  if (body.send === 'telegram' && c.env.BOT_TOKEN && c.env.ADMIN_ID) {
    const summary = `📅 <b>Content Plan ${days} hari</b>\n\n` + plan.map((p) =>
      `<b>Hari ${p.day}</b> — ${escapeHtml(p.product || '')}\n🎣 ${escapeHtml(p.hook || '')}\n🏷️ ${escapeHtml(p.discountCode || '')} @ ${escapeHtml(p.postTime || '')}`
    ).join('\n\n');
    await sendTelegramMessage(c.env.BOT_TOKEN, c.env.ADMIN_ID, summary);
  }
  return c.json({ ok: true, plan });
});

app.post('/api/pbt-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), PBT_PROMPT);
  await saveLead(c.env, 'ServisBot PBT Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/cikgu-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), CIKGU_PROMPT);
  await saveLead(c.env, 'CikguBot User', body.message || '-');
  return c.json({ reply });
});

app.post('/api/bank-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), BANK_PROMPT);
  await saveLead(c.env, 'BankBot Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/influencer-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), INFLUENCER_PROMPT);
  await saveLead(c.env, 'InfluencerBot Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/restocatering-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), RESTOCATERING_PROMPT);
  await saveLead(c.env, 'RestoCatering Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/property-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), PROPERTY_PROMPT);
  await saveLead(c.env, 'PropertyBot Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/klinik-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), KLINIK_PROMPT);
  await saveLead(c.env, 'KlinikBot Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/burger-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), BURGER_PROMPT);
  await saveLead(c.env, 'BurgerBot Lead', body.message || '-');
  return c.json({ reply });
});

app.post('/api/nasikuning-chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reply = await askAi(c.env, String(body.message || '').trim(), NASIKUNING_PROMPT);
  await saveLead(c.env, 'NasiKuningBot Lead', body.message || '-');
  return c.json({ reply });
});

// ----------------- PENDAFTARAN BORANG KE CLOUDFLARE D1 -----------------
app.post('/register', async (c) => {
  try {
    const body = await c.req.parseBody();
    const nama = String(body.nama || 'Tanpa Nama').trim();
    const kontak = String(body.kontak || '-').trim();
    const pakej = String(body.pakej || '-').trim();
    const soalan = String(body.soalan || '-').trim();

    const leadDetails = `[Permohonan] Kontak: ${kontak} | Pakej: ${pakej} | Keperluan: ${soalan}`;
    await saveLead(c.env, nama, leadDetails);

    // Notifikasi ke Telegram Admin jika BOT_TOKEN & ADMIN_ID disediakan
    if (c.env.BOT_TOKEN && c.env.ADMIN_ID) {
      const adminMsg = `🔔 <b>Permohonan Bot Baru Diterima!</b>\n\n` +
        `👤 <b>Nama:</b> ${escapeHtml(nama)}\n` +
        `📞 <b>Kontak:</b> ${escapeHtml(kontak)}\n` +
        `📦 <b>Pakej:</b> ${escapeHtml(pakej)}\n` +
        `📝 <b>Keperluan:</b>\n${escapeHtml(soalan)}`;
      await sendTelegramMessage(c.env.BOT_TOKEN, c.env.ADMIN_ID, adminMsg);
    }

    return c.html(`
      <!DOCTYPE html>
      <html lang="ms">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Permohonan Berjaya</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
        <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-6 text-center shadow-xl">
          <div class="w-16 h-16 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl font-bold">✓</div>
          <h2 class="text-xl font-bold text-white mb-2">Permohonan Berjaya Dihantar!</h2>
          <p class="text-sm text-slate-300 mb-6">Terima kasih <b>${escapeHtml(nama)}</b>. Maklumat anda telah berjaya disimpan ke pangkalan data D1. Kami akan menghubungi anda melalui <b>${escapeHtml(kontak)}</b> secepat mungkin.</p>
          <a href="/" class="inline-block bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-2.5 rounded-xl transition text-sm">Kembali ke Portal</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Register error:', err);
    return c.html('<div style="background:#020817;color:white;text-align:center;padding:50px;"><h2>⚠️ Ralat semasa menghantar borang.</h2><p style="color:#94a3b8;">Sila cuba sebentar lagi.</p><br><a href="/" style="color:#3b82f6;">Kembali ke Web</a></div>', 500);
  }
});

// ----------------- WEBHOOK TELEGRAM -----------------
app.post('/webhook', async (c) => {
  const update = await c.req.json().catch(() => null);
  // Balas Telegram serta-merta (elak Read timeout), proses dalam background
  c.executionCtx.waitUntil(handleTelegramUpdate(c.env, update).catch((e) => console.error('tg bg error:', e?.message)));
  return c.text('OK');
});

async function handleTelegramUpdate(env, update) {
  try {
    if (!update?.message?.text) return;
    const chatId = String(update.message.chat.id);
    const text = String(update.message.text).trim();

    if (text === '/start') {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '👋 Hai! Saya AwangBot78. Tanya saya tentang pakej dan perkhidmatan bot kustom untuk perniagaan anda.');
      return;
    }

    // Owner commands (ADMIN_ID sahaja): PAID n | POS n TRACKING | SAMPAI n | STATUS n | REFUND n | katalog
    if (env.ADMIN_ID && chatId === String(env.ADMIN_ID)) {
      const handled = await handleOwnerCommand(env, text);
      if (handled) {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, handled);
        return;
      }
    }

    const aiReply = await askAi(env, text, AWANGBOT_PROMPT);
    await sendTelegramMessage(env.BOT_TOKEN, chatId, aiReply);
    await saveLead(env, `Telegram User (${chatId})`, text);
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
}

// ----------------- OWNER COMMANDS (Telegram, ADMIN_ID sahaja) -----------------
async function setOrderStatus(env, id, status, tracking) {
  await ensureDropshipTables(env);
  if (!env?.DB) return null;
  if (tracking) {
    await env.DB.prepare('UPDATE dropship_orders SET status = ?, tracking = ? WHERE id = ?').bind(status, tracking, id).run();
  } else {
    await env.DB.prepare('UPDATE dropship_orders SET status = ? WHERE id = ?').bind(status, id).run();
  }
  const row = await env.DB.prepare(
    'SELECT id, nama, phone, barang, qty, status, tracking FROM dropship_orders WHERE id = ?'
  ).bind(id).run();
  return row?.results?.[0] || null;
}

function fmtOrder(o) {
  return `Order #${o.id} — ${o.barang} x${o.qty}\n${o.nama} / ${o.phone}\nStatus: ${o.status}` +
    (o.tracking ? `\nTracking: ${o.tracking}` : '') +
    `\nSemak: https://awangbotv3.mykira.workers.dev/track?id=${o.id}`;
}

async function handleOwnerCommand(env, text) {
  const t = String(text || '').trim();
  // --- Katalog produk ---
  const pm = t.match(/^(tambah|senarai|tutup|buka|harga|edit)\b\s*([\s\S]*)$/i);
  if (pm) {
    const pcmd = pm[1].toLowerCase();
    const parg = (pm[2] || '').trim();
    await ensureProductsTable(env);
    if (!env?.DB) return 'DB tidak sedia.';
    if (pcmd === 'senarai') {
      const r = await env.DB.prepare('SELECT id, nama, harga, aktif, kategori, slug FROM products ORDER BY id').run();
      const rows = r?.results || [];
      if (!rows.length) return 'Katalog kosong. Tambah: TAMBAH nama | harga | modal';
      return '📦 KATALOG:\n' + rows.map((p) =>
        `#${p.id} ${p.nama} — RM${p.harga}${p.kategori ? ` [${p.kategori}]` : ''}${p.aktif ? '' : ' (TUTUP)'}${p.slug ? `\n     /product/${p.slug}` : ''}`
      ).join('\n');
    }
    if (pcmd === 'tambah') {
      // nama | harga | modal | kategori | saiz | warna | gambar | penerangan
      const parts = parg.split('|').map((s) => s.trim());
      if (parts.length < 2 || !parts[0]) {
        return 'Format: TAMBAH nama | harga | modal | kategori | saiz | warna | gambar | penerangan' +
          '\nCth: TAMBAH Hoodie Kira | 149 | 70 | baju | S,M,L,XL | Hitam,Navy';
      }
      const nama = parts[0].slice(0, 100);
      const harga = Math.max(0, Number(parts[1]) || 0);
      const modal = parts[2] ? Math.max(0, Number(parts[2]) || 0) : 0;
      const kategori = (parts[3] || '').toLowerCase().slice(0, 20);
      const sizes = (parts[4] || '').slice(0, 100);
      const colors = (parts[5] || '').slice(0, 100);
      const gambar = (parts[6] || '').slice(0, 300);
      const penerangan = (parts[7] || '').slice(0, 500);
      const slug = await uniqueSlug(env, slugify(nama));
      const r = await env.DB.prepare(
        'INSERT INTO products (nama, harga, modal, slug, kategori, sizes, colors, gambar, penerangan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(nama, harga, modal, slug, kategori, sizes, colors, gambar, penerangan).run().catch(() => null);
      const id = r?.meta?.last_row_id;
      if (!id) return 'Gagal simpan.';
      const kedai = kategori === 'baju' || kategori === 'accessory'
        ? `\n🛍️ Muncul di kedai: /product/${slug}`
        : '\n⚠️ Set kategori (baju/accessory) untuk muncul di kedai: EDIT ' + id + ' kategori baju';
      return `✅ Produk #${id} masuk katalog:\n${nama} — RM${harga}${modal ? ` (modal RM${modal})` : ''}${kedai}`;
    }
    if (pcmd === 'edit') {
      const em = parg.match(/^(\d+)\s+([a-zA-Z]+)\s+([\s\S]+)$/);
      if (!em) {
        return 'Format: EDIT <id> <medan> <nilai>\nMedan: nama, harga, modal, kategori, saiz, warna, gambar, penerangan, slug' +
          '\nCth: EDIT 21 harga 89   |   EDIT 21 kategori baju   |   EDIT 21 saiz S,M,L,XL';
      }
      const id = Number(em[1]);
      const medan = em[2].toLowerCase();
      const nilai = em[3].trim();
      const peta = {
        nama: 'nama', harga: 'harga', modal: 'modal', kategori: 'kategori',
        saiz: 'sizes', sizes: 'sizes', warna: 'colors', colors: 'colors',
        gambar: 'gambar', penerangan: 'penerangan', slug: 'slug',
      };
      const col = peta[medan];
      if (!col) return 'Medan tak dikenali: ' + medan;
      let val;
      if (col === 'harga' || col === 'modal') val = Math.max(0, Number(nilai) || 0);
      else if (col === 'slug') val = await uniqueSlug(env, slugify(nilai), id);
      else val = nilai.slice(0, 500);
      await env.DB.prepare(`UPDATE products SET ${col} = ? WHERE id = ?`).bind(val, id).run();
      return `✅ #${id} ${col} -> ${val}`;
    }
    if (pcmd === 'tutup' || pcmd === 'buka') {
      const id = Number(parg);
      if (!id) return 'Format: ' + (pcmd === 'tutup' ? 'TUTUP' : 'BUKA') + ' <id>\nCth: TUTUP 2';
      await env.DB.prepare('UPDATE products SET aktif = ? WHERE id = ?').bind(pcmd === 'buka' ? 1 : 0, id).run();
      return `✅ Produk #${id} ${pcmd === 'buka' ? 'dibuka' : 'ditutup'}.`;
    }
    if (pcmd === 'harga') {
      const hp = parg.match(/^(\d+)\s+([\d.]+)$/);
      if (!hp) return 'Format: HARGA <id> <nilai>\nCth: HARGA 2 24.90';
      await env.DB.prepare('UPDATE products SET harga = ? WHERE id = ?').bind(Number(hp[2]), Number(hp[1])).run();
      return `✅ Harga produk #${hp[1]} -> RM${hp[2]}.`;
    }
    return null;
  }
  const m = t.match(/^(paid|pos|sampai|status|refund)\s+(\d+)\s*([\s\S]*)$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const id = Number(m[2]);
  const extra = (m[3] || '').trim().slice(0, 100);
  if (cmd === 'status') {
    await ensureDropshipTables(env);
    if (!env?.DB) return 'DB tidak sedia.';
    const row = await env.DB.prepare(
      'SELECT id, nama, phone, barang, qty, status, tracking FROM dropship_orders WHERE id = ?'
    ).bind(id).run();
    const hit = row?.results?.[0];
    return hit ? fmtOrder(hit) : `Order #${id} tak jumpa.`;
  }
  const map = { paid: 'paid', pos: 'pos', sampai: 'sampai', refund: 'refund' };
  const hit = await setOrderStatus(env, id, map[cmd], cmd === 'pos' ? extra : null).catch(() => null);
  if (!hit) return `Order #${id} tak jumpa.`;
  return `✅ ${fmtOrder(hit)}`;
}

// ----------------- WEBHOOK WHATSAPP (META / CLOUDFLARE) -----------------
// Fungsi verifikasi webhook Meta WhatsApp (Challenge)
function handleWhatsAppVerify(c) {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  const expectedToken = c.env.WHATSAPP_VERIFY_TOKEN || c.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    return c.text(challenge || '');
  }

  return c.text('Forbidden', 403);
}

// Fungsi penerimaan mesej WhatsApp & balasan AI
async function handleWhatsAppMessage(c) {
  try {
    const body = await c.req.json();
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg || !msg.text) {
      return c.json({ ok: true });
    }

    const from = msg.from;
    const text = String(msg.text.body || '').trim();

    try {
      const aiReply = await askAi(c.env, text, AWANGBOT_PROMPT);
      const token = c.env.WHATSAPP_TOKEN || c.env.ACCESS_TOKEN;
      const phoneId = c.env.WHATSAPP_PHONE_ID || c.env.PHONE_NUMBER_ID;

      if (token && phoneId) {
        await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: aiReply || 'Maaf, saya kurang pasti. Sila cuba soalan lain.' },
          }),
        });
      }
      await saveLead(c.env, `WhatsApp (${from})`, text);
    } catch (err) {
      console.error('WhatsApp AI processing error:', err);
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }

  return c.json({ ok: true });
}

// Sokong kedua-dua laluan endpoint WhatsApp
app.get('/webhook/whatsapp', handleWhatsAppVerify);
app.get('/whatsapp/webhook', handleWhatsAppVerify);
app.post('/webhook/whatsapp', handleWhatsAppMessage);
app.post('/whatsapp/webhook', handleWhatsAppMessage);

// ================= AGENT API (x402) — jual servis AI kepada bot/agen lain =================
// Aliran:
//   POST /api/agent/<servis>  (tanpa bayaran)
//     -> 402 Payment Required + harga (USDC/SOL) + dompet + "reference" unik
//   Bot bayar ke dompet (SOL asli atau USDC SPL); "reference" dimasukkan dlm transaksi
//     -> panggil semula dengan X-Payment-Ref: <reference> (atau X-Payment-Tx: <signature>)
//   Worker sahkan sendiri (self-facilitate):
//     getSignaturesForAddress(reference) -> getTransaction -> kira beza baki dompet kita
//     -> tolak replay (tx_sig UNIQUE) -> jalankan servis -> pulangkan hasil
// Tiada private key diperlukan. Awak cuma TERIMA bayaran.

const AGENT_CAIP2 = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
};
const AGENT_USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const AGENT_CHALLENGE_TTL = 900; // 15 minit sah untuk satu cabaran

// Harga lalai (USD). Boleh ubah tanpa deploy: var AGENT_PRICES = {"ringkas":0.004,...}
const AGENT_DEFAULT_PRICES = { ringkas: 0.004, terjemah: 0.003, tulis: 0.008, json: 0.005 };

const AGENT_SERVICE_META = {
  ringkas: {
    nama: 'Ringkas teks',
    desc: 'Ringkaskan teks panjang jadi poin yang padat. Input: teks (maks 6000 aksara).',
    maxInput: 6000,
    system: 'Anda editor profesional. Ringkaskan teks yang diberi kepada poin utama yang padat dan tepat. Jangan tambah maklumat baharu. Jawab dengan ringkasan sahaja, tiada mukadimah.'
  },
  terjemah: {
    nama: 'Terjemah',
    desc: 'Terjemah teks. Sasaran melalui medan "to" (ms|en|zh|ta). Lalai: auto (Melayu <-> Inggeris).',
    maxInput: 4000,
    system: 'Anda penterjemah profesional. Terjemah dengan tepat dan semula jadi, kekalkan maksud dan nada. Jawab dengan terjemahan sahaja, tiada nota atau mukadimah.'
  },
  tulis: {
    nama: 'Tulis kandungan',
    desc: 'Jana kandungan: kapsyen media sosial, penerangan produk, emel, idea. Arahan dalam "text".',
    maxInput: 2000,
    system: 'Anda copywriter berpengalaman untuk pasaran Malaysia. Hasilkan kandungan yang jelas, menarik dan boleh terus digunakan. Jawab dengan kandungan sahaja.'
  },
  json: {
    nama: 'Ekstrak JSON',
    desc: 'Tukar teks tidak berstruktur jadi JSON sah. Bentuk yang dikehendaki melalui medan "skema".',
    maxInput: 6000,
    system: 'Anda pengekstrak data. Pulangkan JSON SAHAJA — tiada kod fence, tiada penjelasan. Guna null bila maklumat tiada.'
  }
};

function agentPrice(env, servis) {
  const lalai = AGENT_DEFAULT_PRICES[servis] || 0.005;
  try {
    const ubah = env?.AGENT_PRICES ? JSON.parse(env.AGENT_PRICES) : null;
    const v = Number(ubah?.[servis]);
    if (Number.isFinite(v) && v > 0) return v;
  } catch (e) { /* var cacat -> guna lalai */ }
  return lalai;
}

function agentChain(env) {
  const dev = String(env?.SOL_NETWORK || 'mainnet').toLowerCase().includes('devnet');
  return {
    dev,
    caip2: dev ? AGENT_CAIP2.devnet : AGENT_CAIP2.mainnet,
    usdc: dev ? AGENT_USDC_DEVNET : USDC_MINT,
    rpc: env?.SOL_RPC || (dev ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com')
  };
}

function agentWallet(env) {
  return String(env?.AGENT_WALLET || salesWallet(env) || '').trim();
}

/** Senarai RPC — cuba satu demi satu kalau yang pertama gagal/rate-limit. */
function agentRpcUrls(env) {
  const dev = agentIsDevnet(env);
  const senarai = [];
  if (env?.SOL_RPC) senarai.push(String(env.SOL_RPC).trim());
  if (dev) senarai.push('https://api.devnet.solana.com');
  senarai.push('https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com');
  return [...new Set(senarai.filter(Boolean))];
}

// --- base58 (tiada dependency) ---
const AGENT_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function agentB58(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += AGENT_B58[digits[i]];
  return out;
}

function agentRandHex(n = 16) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function agentRandPubkey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return agentB58(b);
}

// btoa() hanya terima Latin1 — JSON kita ada aksara seperti — … jadi encode UTF-8 dahulu.
function agentB64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function agentUnb64(b64) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Kadar SOL/USD untuk harga yang adil (cache 60s, ada nilai simpanan).
let agentSolCache = { usd: 0, at: 0 };
async function agentSolUsd(env) {
  const now = Date.now();
  if (agentSolCache.usd && now - agentSolCache.at < 60000) return agentSolCache.usd;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json().catch(() => null);
    const p = Number(data?.solana?.usd || 0);
    if (p > 1) { agentSolCache = { usd: p, at: now }; return p; }
  } catch (e) { /* guna simpanan */ }
  return Number(env?.SOL_USD_FALLBACK || 150);
}

async function ensureAgentTable(env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS agent_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge TEXT UNIQUE NOT NULL,
      ref TEXT DEFAULT '',
      service TEXT NOT NULL,
      price_usd REAL DEFAULT 0,
      asset TEXT DEFAULT '',
      amount TEXT DEFAULT '',
      network TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      tx_sig TEXT UNIQUE,
      payer TEXT DEFAULT '',
      payload TEXT DEFAULT '',
      result TEXT DEFAULT '',
      error TEXT DEFAULT '',
      ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      paid_at INTEGER DEFAULT 0
    )`
  ).run();
  // Kolum tambahan (table lama). ALTER gagal = kolum sudah wujud.
  for (const sql of ['ALTER TABLE agent_calls ADD COLUMN payload TEXT DEFAULT \'\'']) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* sudah ada */ }
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_created ON agent_calls(created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_ref ON agent_calls(ref)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_agent_calls_status ON agent_calls(status)').run();
}

async function agentRpc(env, method, params) {
  const urls = agentRpcUrls(env);
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      const data = await res.json().catch(() => null);
      if (!data) { lastErr = new Error('jawapan RPC bukan JSON'); continue; }
      if (data.error) throw new Error(data.error.message || 'RPC error');
      return data.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('RPC gagal');
}

/** Kira beza baki dompet kita dalam satu transaksi. Terima SOL asli atau USDC SPL. */
async function agentCheckTx(env, priceUsd, txSig, expectRef) {
  const chain = agentChain(env);
  const wallet = agentWallet(env);
  const solUsd = await agentSolUsd(env);
  const perluUsdc = Math.round(Number(priceUsd) * 1e6);
  const perluLamports = Math.max(Math.round((Number(priceUsd) / solUsd) * 1e9), 50000);

  const tx = await agentRpc(env, 'getTransaction', [txSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!tx) return { ok: false, reason: 'transaksi tak dijumpai' };
  if (tx.meta?.err) return { ok: false, reason: 'transaksi gagal di rantaian' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (tx.blockTime && nowSec - tx.blockTime > 1800) return { ok: false, reason: 'transaksi lebih 30 minit' };

  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  if (!keys.includes(wallet)) return { ok: false, reason: 'dompet kita tiada dalam transaksi' };
  if (expectRef && !keys.includes(expectRef)) return { ok: false, reason: 'reference tidak sepadan' };
  const payer = keys[0] || '';

  // 1. SOL asli — beza baki (lamports)
  const idx = keys.indexOf(wallet);
  const solDelta = Number((tx.meta?.postBalances?.[idx] || 0) - (tx.meta?.preBalances?.[idx] || 0));
  if (solDelta >= perluLamports) {
    return { ok: true, asset: 'sol', amount: String(perluLamports), dibayar: String(solDelta), payer, txSig };
  }

  // 2. USDC (SPL) — beza baki token milik dompet kita, mint mesti sepadan
  let usdcDelta = 0;
  for (const post of tx.meta?.postTokenBalances || []) {
    if (post.mint !== chain.usdc || post.owner !== wallet) continue;
    const before = (tx.meta?.preTokenBalances || []).find((p) => p.accountIndex === post.accountIndex);
    usdcDelta += Number(post.uiTokenAmount?.amount || 0) - Number(before?.uiTokenAmount?.amount || 0);
  }
  if (usdcDelta >= perluUsdc) {
    return { ok: true, asset: 'usdc', amount: String(perluUsdc), dibayar: String(usdcDelta), payer, txSig };
  }

  return { ok: false, reason: 'jumlah tak cukup (SOL ' + solDelta + ' lamports / USDC ' + usdcDelta + ' unit)' };
}

/** Baca bukti bayaran dari header/query. */
function agentProof(c) {
  const out = { tx: '', ref: '', challenge: '' };
  const ps = c.req.header('payment-signature') || c.req.header('x-payment');
  if (ps) {
    try {
      const j = JSON.parse(agentUnb64(ps));
      out.tx = String(j.tx || j.signature || j.transaction || '');
      out.ref = String(j.reference || j.ref || '');
      out.challenge = String(j.challenge || '');
    } catch (e) { out.tx = String(ps).trim(); }
  }
  out.tx = out.tx || c.req.header('x-payment-tx') || c.req.query('tx') || '';
  out.ref = out.ref || c.req.header('x-payment-ref') || c.req.query('ref') || '';
  out.challenge = out.challenge || c.req.header('x-challenge') || c.req.query('challenge') || '';
  return out;
}

function agentPrompt(servis, text, body) {
  if (servis === 'terjemah') {
    const to = String(body?.to || '').trim().toLowerCase().slice(0, 8);
    return 'Terjemah ke ' + (to || 'Bahasa Melayu jika teks bukan Melayu; Inggeris jika teks Melayu') + ':\n\n' + text;
  }
  if (servis === 'json') {
    const skema = String(body?.skema || body?.schema || body?.shape || '').trim().slice(0, 800);
    return (skema ? 'Bentuk JSON yang dikehendaki: ' + skema + '\n\n' : '') + 'Teks:\n' + text;
  }
  return text;
}

/** Balas 402 + cabaran bayaran (reference unik). */
async function agentChallenge(c, servis, opt = {}) {
  const env = c.env;
  const chain = agentChain(env);
  const wallet = agentWallet(env);
  const usd = agentPrice(env, servis);
  const solUsd = await agentSolUsd(env);
  const lamports = Math.max(Math.round((usd / solUsd) * 1e9), 50000);
  const origin = new URL(c.req.url).origin;
  const svc = AGENT_SERVICE_META[servis] || {};

  let challenge = opt.challenge || '';
  let ref = opt.ref || '';
  if (!challenge || !ref) {
    challenge = agentRandHex(16);
    ref = agentRandPubkey();
    await env.DB.prepare(
      'INSERT OR IGNORE INTO agent_calls (challenge, ref, service, price_usd, network, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(challenge, ref, servis, usd, chain.caip2, Date.now()).run();
  }

  const asas = {
    scheme: 'exact',
    network: chain.caip2,
    payTo: wallet,
    resource: origin + '/api/agent/' + servis,
    description: svc.desc || '',
    mimeType: 'application/json',
    maxTimeoutSeconds: 120
  };
  const accepts = [
    { ...asas, asset: chain.usdc, amount: String(Math.round(usd * 1e6)), maxAmountRequired: String(Math.round(usd * 1e6)), extra: { name: 'USDC', decimals: 6 } },
    { ...asas, asset: 'native', amount: String(lamports), maxAmountRequired: String(lamports), extra: { name: 'SOL', decimals: 9, native: true } }
  ];
  const label = encodeURIComponent('MyKira Agent API');
  const mesej = encodeURIComponent('agent:' + servis);
  const usdcUri = `solana:${wallet}?amount=${usd.toFixed(6)}&spl-token=${chain.usdc}&reference=${ref}&label=${label}&message=${mesej}`;
  const solUri = `solana:${wallet}?amount=${(lamports / 1e9).toFixed(9)}&reference=${ref}&label=${label}&message=${mesej}`;

  const payload = {
    x402Version: 2,
    error: opt.error || 'Payment Required',
    resource: { url: origin + '/api/agent/' + servis, description: svc.desc || '', mimeType: 'application/json' },
    accepts
  };

  return c.json({
    ok: false,
    code: 402,
    error: opt.error || 'Bayaran diperlukan',
    servis,
    challenge,
    reference: ref,
    wallet,
    network: chain.caip2,
    harga_usd: usd,
    jumlah_usdc: usd,
    jumlah_sol: Number((lamports / 1e9).toFixed(9)),
    expires_at: Math.floor(Date.now() / 1000) + AGENT_CHALLENGE_TTL,
    accepts,
    cara_bayar: {
      usdc: usdcUri,
      sol: solUri,
      langkah: [
        '1. Bayar jumlah di atas ke dompet (USDC atau SOL). Masukkan "reference" sebagai akaun tambahan dalam transaksi.',
        '2. Panggil semula endpoint sama dengan header "X-Payment-Ref: <reference>" (atau "X-Payment-Tx: <signature>").',
        '3. Worker sahkan on-chain lalu pulangkan hasil. Status: GET /api/agent/status?challenge=<challenge>'
      ]
    }
  }, 402, { 'PAYMENT-REQUIRED': agentB64(JSON.stringify(payload)) });
}

/** Teras: sahkan bayaran + jalankan servis. Dikongsi oleh HTTP (x402) dan Telegram. */
async function agentSettle(env, servis, svc, text, proof) {
  let row = null;
  if (proof.challenge) {
    row = (await env.DB.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(proof.challenge).run())?.results?.[0] || null;
  }
  if (!row && proof.ref) {
    row = (await env.DB.prepare('SELECT * FROM agent_calls WHERE ref = ? ORDER BY id DESC LIMIT 1').bind(proof.ref).run())?.results?.[0] || null;
  }
  if (!row) return { ok: false, reason: 'Cabaran tak dikenali — minta cabaran baharu.' };
  if (row.service !== servis) return { ok: false, reason: 'Cabaran ini untuk servis lain.' };

  if (row.status === 'paid' && row.result) {
    return { ok: true, hasil: row.result, tx: row.tx_sig, asset: row.asset, amount: row.amount, cached: true, row };
  }

  let txSig = String(proof.tx || '');
  if (!txSig && (proof.ref || row.ref)) {
    const refCari = proof.ref || row.ref;
    const sigs = await agentRpc(env, 'getSignaturesForAddress', [refCari, { limit: 5, commitment: 'confirmed' }]).catch(() => null);
    txSig = ((sigs || []).find((s) => s && !s.err) || {}).signature || '';
  }
  if (!txSig) return { ok: false, reason: 'Bayaran belum dikesan pada rantaian. Cuba lagi sebentar.', row };

  const check = await agentCheckTx(env, row.price_usd, txSig, proof.ref || row.ref);
  if (!check.ok) return { ok: false, reason: 'Bayaran tak sah: ' + check.reason, row };

  // Tolak replay — satu transaksi hanya boleh bayar satu panggilan.
  const guna = (await env.DB.prepare('SELECT id FROM agent_calls WHERE tx_sig = ?').bind(txSig).run())?.results?.[0];
  if (guna && guna.id !== row.id) return { ok: false, reason: 'Bayaran ini sudah digunakan.', row };

  const t0 = Date.now();
  let hasil = '';
  try {
    hasil = await askAi(env, agentPrompt(servis, text, {}), svc.system);
  } catch (err) {
    console.error('Agent AI gagal:', err?.message || err);
  }
  const ms = Date.now() - t0;
  if (!hasil) return { ok: false, reason: 'Servis gagal dijalankan (bayaran tidak digunakan). Cuba lagi.', row };

  await env.DB.prepare(
    'UPDATE agent_calls SET status = ?, tx_sig = ?, payer = ?, asset = ?, amount = ?, paid_at = ?, result = ?, ms = ? WHERE id = ?'
  ).bind('paid', txSig, check.payer, check.asset, check.amount, Date.now(), hasil.slice(0, 20000), ms, row.id).run();

  // Notifikasi pemilik — "duit masuk".
  try {
    if (env.BOT_TOKEN && env.ADMIN_ID) {
      const [j] = (await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid'").run())?.results || [];
      await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID,
        '🤖 Agent API — bayaran masuk!\n' +
        '• Servis: ' + servis + '\n' +
        '• Harga: $' + Number(row.price_usd).toFixed(4) + ' (' + String(check.asset).toUpperCase() + ')\n' +
        '• Dari: ' + String(check.payer).slice(0, 12) + '…\n' +
        '• Jumlah terkumpul: ' + (j?.n || 0) + ' panggilan / $' + Number(j?.usd || 0).toFixed(4) + '\n' +
        '• Tx: ' + txSig.slice(0, 20) + '…'
      );
    }
  } catch (e) { /* notifikasi tak boleh gagalkan servis */ }

  return { ok: true, hasil, tx: txSig, asset: check.asset, amount: check.amount, payer: check.payer, ms, row };
}

/** HTTP (x402): semak + jalankan servis. */
async function agentFulfil(c, servis, svc, text, body, proof) {
  const r = await agentSettle(c.env, servis, svc, text, proof);
  if (r.ok) {
    return c.json({
      ok: true, servis, hasil: r.hasil, cache: r.cached || false,
      bayaran: { wallet: agentWallet(c.env), asset: r.asset, jumlah: r.amount, dari: r.payer, tx: r.tx },
      ms: r.ms || 0
    }, 200, { 'PAYMENT-RESPONSE': agentB64(JSON.stringify({ success: true, tx: r.tx, network: agentChain(c.env).caip2 })) });
  }
  return agentChallenge(c, servis, r.row
    ? { challenge: r.row.challenge, ref: r.row.ref, error: r.reason }
    : { error: r.reason });
}

async function agentHandler(c) {
  try {
    const servis = String(c.req.param('servis') || '').toLowerCase().trim();
    const svc = AGENT_SERVICE_META[servis];
    if (!svc) {
      return c.json({ ok: false, error: 'Servis tak dikenali', servis_tersedia: Object.keys(AGENT_SERVICE_META) }, 404);
    }
    await ensureAgentTable(c.env);

    const body = await c.req.json().catch(() => ({}));
    const text = String(body?.text ?? body?.input ?? body?.prompt ?? body?.q ?? c.req.query('text') ?? '').slice(0, svc.maxInput).trim();
    const proof = agentProof(c);

    if (proof.tx || proof.ref || proof.challenge) {
      if (!text) return c.json({ ok: false, error: 'Medan "text" diperlukan' }, 400);
      return await agentFulfil(c, servis, svc, text, body, proof);
    }
    return await agentChallenge(c, servis);
  } catch (err) {
    console.error('Agent API ralat:', err);
    return c.json({ ok: false, error: 'Ralat dalaman' }, 500);
  }
}

// Katalog servis (JSON) — ini yang dibaca agen lain.
app.get('/api/agent', async (c) => {
  const env = c.env;
  const chain = agentChain(env);
  const origin = new URL(c.req.url).origin;
  const wallet = agentWallet(env);
  const solUsd = await agentSolUsd(env);
  const servis = Object.entries(AGENT_SERVICE_META).map(([id, s]) => {
    const usd = agentPrice(env, id);
    return {
      id, nama: s.nama, keterangan: s.desc,
      endpoint: origin + '/api/agent/' + id,
      method: 'POST',
      harga_usd: usd,
      harga_usdc: usd,
      harga_sol: Number(((usd / solUsd)).toFixed(9)),
      medan: { text: 'wajib', to: id === 'terjemah' ? 'pilihan (ms|en|zh|ta)' : undefined, skema: id === 'json' ? 'pilihan' : undefined }
    };
  });
  return c.json({
    ok: true,
    nama: 'MyKira Agent API',
    protokol: 'x402 (lean: bayar dahulu, sahkan on-chain)',
    version: 2,
    network: chain.caip2,
    pay_to: wallet,
    aset: { usdc: chain.usdc, sol: 'native' },
    kadar_sol_usd: solUsd,
    manifest: origin + '/.well-known/x402.json',
    halaman: origin + '/agent',
    stats: origin + '/api/agent/stats?key=…',
    servis
  });
});

// Manifest penemuan — diindeks oleh x402 Bazaar / Agent Bazaar / x402scan.
app.get('/.well-known/x402.json', async (c) => {
  const env = c.env;
  const chain = agentChain(env);
  const origin = new URL(c.req.url).origin;
  const wallet = agentWallet(env);
  const solUsd = await agentSolUsd(env);
  return c.json({
    x402Version: 2,
    name: 'MyKira Agent API',
    description: 'Servis AI berbayar untuk bot/agen: ringkas, terjemah, tulis kandungan, ekstrak JSON. Bayar per panggilan dengan USDC atau SOL pada Solana.',
    network: chain.caip2,
    payTo: wallet,
    provider: { name: 'MyKira', url: origin },
    resources: Object.entries(AGENT_SERVICE_META).map(([id, s]) => {
      const usd = agentPrice(env, id);
      return {
        resource: origin + '/api/agent/' + id,
        method: 'POST',
        description: s.nama + ' — ' + s.desc,
        mimeType: 'application/json',
        accepts: [
          { scheme: 'exact', network: chain.caip2, asset: chain.usdc, payTo: wallet, amount: String(Math.round(usd * 1e6)), maxAmountRequired: String(Math.round(usd * 1e6)) },
          { scheme: 'exact', network: chain.caip2, asset: 'native', payTo: wallet, amount: String(Math.max(Math.round((usd / solUsd) * 1e9), 50000)), maxAmountRequired: String(Math.max(Math.round((usd / solUsd) * 1e9), 50000)) }
        ]
      };
    })
  });
});

// Status cabaran (untuk agen yang poll, bukan retry).
app.get('/api/agent/status', async (c) => {
  try {
    await ensureAgentTable(c.env);
    const challenge = String(c.req.query('challenge') || '');
    const ref = String(c.req.query('ref') || '');
    if (!challenge && !ref) return c.json({ ok: false, error: 'Beri ?challenge= atau ?ref=' }, 400);
    const row = challenge
      ? (await c.env.DB.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(challenge).run())?.results?.[0]
      : (await c.env.DB.prepare('SELECT * FROM agent_calls WHERE ref = ? ORDER BY id DESC LIMIT 1').bind(ref).run())?.results?.[0];
    if (!row) return c.json({ ok: false, error: 'Cabaran tak dijumpai' }, 404);
    return c.json({
      ok: true, challenge: row.challenge, servis: row.service, status: row.status,
      harga_usd: row.price_usd, asset: row.asset || null, tx: row.tx_sig || null,
      hasil: row.status === 'paid' ? row.result : null,
      created_at: row.created_at, paid_at: row.paid_at || null
    });
  } catch (e) {
    return c.json({ ok: false, error: 'Ralat DB' }, 500);
  }
});

// Hasil/pendapatan Agent API — owner sahaja.
app.get('/api/agent/stats', async (c) => {
  try {
    const jangka = String(c.env.AGENT_STATS_KEY || '');
    if (!jangka) return c.json({ ok: false, error: 'Stats dimatikan (AGENT_STATS_KEY kosong)' }, 404);
    const kunci = String(c.req.query('key') || c.req.header('x-key') || '');
    if (kunci !== jangka) return c.json({ ok: false, error: 'Kunci salah' }, 403);
    await ensureAgentTable(c.env);
    const q = async (sql) => (await c.env.DB.prepare(sql).run())?.results || [];
    const [ringkas] = await q("SELECT COUNT(*) AS jumlah, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END),0) AS hasil_usd FROM agent_calls");
    return c.json({
      ok: true,
      jumlah_cabaran: ringkas?.jumlah || 0,
      dibayar: ringkas?.dibayar || 0,
      belum_dibayar: ringkas?.pending || 0,
      hasil_usd: Number(ringkas?.hasil_usd || 0),
      harian: await q("SELECT date(paid_at/1000, 'unixepoch') AS tarikh, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY tarikh ORDER BY tarikh DESC LIMIT 14"),
      per_servis: await q("SELECT service, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY service ORDER BY n DESC"),
      pembayar: await q("SELECT payer, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY payer ORDER BY n DESC LIMIT 10"),
      terkini: await q("SELECT service, status, price_usd, asset, payer, created_at FROM agent_calls ORDER BY id DESC LIMIT 20")
    });
  } catch (e) {
    return c.json({ ok: false, error: 'Ralat DB' }, 500);
  }
});

// Halaman manusia — tengok harga, dompet & cara uji.
app.get('/agent', async (c) => {
  const env = c.env;
  const origin = new URL(c.req.url).origin;
  const wallet = agentWallet(env);
  const solUsd = await agentSolUsd(env);
  const baris = Object.entries(AGENT_SERVICE_META).map(([id, s]) => {
    const usd = agentPrice(env, id);
    const sol = Math.max(Math.round((usd / solUsd) * 1e9), 50000) / 1e9;
    return '<tr><td><code>' + id + '</code></td><td>' + escapeHtml(s.nama) + '</td><td>' +
      '<strong>$' + usd.toFixed(4) + '</strong> USDC<br><span class="dim">' + sol.toFixed(6) + ' SOL</span></td><td class="dim">' +
      escapeHtml(s.desc) + '</td></tr>';
  }).join('');
  const html = `<!doctype html><html lang="ms"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MyKira Agent API — servis AI untuk bot</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; background:#0b0f19; color:#e5e7eb; font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:32px 20px }
  .wrap { max-width: 880px; margin: 0 auto }
  h1 { font-size: 26px; margin: 0 0 6px; background: linear-gradient(90deg,#a78bfa,#f472b6); -webkit-background-clip:text; background-clip:text; color:transparent }
  p.lead { color:#94a3b8; margin:0 0 22px }
  table { width:100%; border-collapse: collapse; margin: 14px 0 26px; font-size:14px }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid #1f2937; vertical-align:top }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em }
  code { background:#111827; border:1px solid #1f2937; border-radius:6px; padding:1px 6px; font-size:13px; color:#c4b5fd }
  pre { background:#111827; border:1px solid #1f2937; border-radius:10px; padding:14px; overflow-x:auto; font-size:12.5px; color:#e2e8f0 }
  .card { background:#0f1523; border:1px solid #1f2937; border-radius:14px; padding:18px 20px; margin-bottom:18px }
  .dim { color:#94a3b8; font-size:12.5px }
  a { color:#a78bfa }
  .tag { display:inline-block; background:#1e1b4b; color:#c4b5fd; border:1px solid #3730a3; border-radius:999px; padding:2px 10px; font-size:12px }
</style></head><body><div class="wrap">
<h1>MyKira Agent API</h1>
<p class="lead">Servis AI berbayar untuk <strong>bot &amp; agen</strong>. Bayar per panggilan dengan USDC atau SOL di Solana — tiada akaun, tiada API key. <span class="tag">x402</span></p>

<div class="card">
  <div class="dim">Dompet penerima (Solana)</div>
  <div><code>${escapeHtml(wallet)}</code></div>
  <div class="dim" style="margin-top:8px">Rangkaian: <code>${agentChain(env).caip2}</code> &nbsp;·&nbsp; Kadar rujukan: 1 SOL ≈ $${solUsd.toFixed(2)}</div>
</div>

<table>
  <thead><tr><th>ID</th><th>Servis</th><th>Harga</th><th>Keterangan</th></tr></thead>
  <tbody>${baris}</tbody>
</table>

<div class="card">
  <strong>Cara guna (2 langkah)</strong>
  <pre># 1. Panggil tanpa bayaran -> dapat harga + reference
curl -s -X POST ${origin}/api/agent/ringkas \\
  -H 'content-type: application/json' \\
  -d '{"text":"Teks panjang yang nak diringkaskan..."}'

# 2. Bayar ke dompet (masukkan "reference"), lepas itu hantar bukti:
curl -s -X POST ${origin}/api/agent/ringkas \\
  -H 'content-type: application/json' \\
  -H 'X-Payment-Ref: &lt;reference&gt;' \\
  -d '{"text":"..."}'</pre>
  <div class="dim">Manifest penemuan: <a href="/.well-known/x402.json">/.well-known/x402.json</a> · Katalog JSON: <a href="/api/agent">/api/agent</a></div>
</div>
</div></body></html>`;
  return c.html(html);
});

app.post('/api/agent/:servis', agentHandler);
app.get('/api/agent/:servis', agentHandler);

// ----------------- BOT PEKERJA @mypekerja1_bot — muka jualan + semakan bayaran -----------------
// Set token  : npx wrangler secret put BOT_TOKEN_PEKERJA
// Set webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://awangbotv3.mykira.workers.dev/webhook-pekerja
// Selagi token kosong, endpoint ini senyap (tak buat apa-apa).

async function pekerjaSend(env, chatId, text) {
  const token = env?.BOT_TOKEN_PEKERJA;
  if (!token || !chatId) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        disable_web_page_preview: true
      })
    });
  } catch (e) { /* senyap */ }
}

/** Cabaran bayaran tanpa HTTP — untuk aliran Telegram. */
async function agentNewChallenge(env, servis, payload = '') {
  const chain = agentChain(env);
  const usd = agentPrice(env, servis);
  const solUsd = await agentSolUsd(env);
  const lamports = Math.max(Math.round((usd / solUsd) * 1e9), 50000);
  const challenge = agentRandHex(16);
  const ref = agentRandPubkey();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO agent_calls (challenge, ref, service, price_usd, network, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(challenge, ref, servis, usd, chain.caip2, String(payload || '').slice(0, 6000), Date.now()).run();
  return { challenge, ref, usd, lamports, chain, wallet: agentWallet(env) };
}

function pekerjaSenarai(env) {
  return Object.entries(AGENT_SERVICE_META).map(([id, s], i) => {
    const usd = agentPrice(env, id);
    return (i + 1) + '. /beli ' + id + ' <teks>\n   ' + s.nama + ' — $' + usd.toFixed(4) +
      ' USDC (~' + (Math.max(Math.round((usd / 150) * 1e9), 50000) / 1e9).toFixed(5) + ' SOL)\n   ' + s.desc;
  }).join('\n\n');
}

app.post('/webhook-pekerja', async (c) => {
  try {
    const env = c.env;
    const u = await c.req.json().catch(() => ({}));
    const msg = u?.message || u?.edited_message || u?.channel_post;
    const chatId = msg?.chat?.id;
    const raw = String(msg?.text || '').trim();
    if (!chatId || !raw) return c.json({ ok: true });

    const fromId = String(msg?.from?.id || '');
    const admin = String(env.ADMIN_ID || '');
    const isAdmin = !!admin && fromId === admin;
    const bahagian = raw.split(/\s+/);
    const cmd = String(bahagian[0] || '').toLowerCase().replace(/@\w+$/, '');
    const asas = new URL(c.req.url).origin;

    if (cmd === '/start' || cmd === '/help' || cmd === '/bantuan') {
      await pekerjaSend(env, chatId,
        '👷 MyWorker — servis AI berbayar (untuk bot & manusia)\n\n' +
        pekerjaSenarai(env) +
        '\n\nCara beli: /beli <id> <teks>\nSemak bayaran: /semak <challenge>' +
        (isAdmin ? '\nHasil masuk: /hasil' : '') +
        '\n\nUntuk bot lain (HTTP/x402): ' + asas + '/agent'
      );
    } else if (cmd === '/servis') {
      await pekerjaSend(env, chatId, pekerjaSenarai(env) + '\n\nDaftar penuh (JSON): ' + asas + '/api/agent');
    } else if (cmd === '/beli') {
      const id = String(bahagian[1] || '').toLowerCase();
      const svc = AGENT_SERVICE_META[id];
      if (!svc) {
        await pekerjaSend(env, chatId, 'Servis tak dikenali. Pilih salah satu:\n\n' + pekerjaSenarai(env));
      } else {
        const teks = bahagian.slice(2).join(' ').trim();
        if (!teks) {
          await pekerjaSend(env, chatId, 'Sertakan teks selepas id. Contoh:\n/beli ' + id + ' Ringkaskan teks ini…');
        } else {
          await ensureAgentTable(env);
          const ch = await agentNewChallenge(env, id, teks);
          await pekerjaSend(env, chatId,
            '🧾 Pesanan ' + id + '\nHarga: $' + ch.usd.toFixed(4) + ' USDC (~' + (ch.lamports / 1e9).toFixed(6) + ' SOL)\n\n' +
            'BAYAR ke dompet:\n' + ch.wallet + '\n\n' +
            'USDC:\n' + asas + '/pay\n(pilih USDC, jumlah ' + ch.usd.toFixed(4) + ', masukkan reference di bawah)\n\n' +
            '🔑 reference: ' + ch.ref + '\n\n' +
            'Lepas bayar, hantar: /semak ' + ch.challenge + '\n\n' +
            '(Bot lain boleh bayar terus: ' + asas + '/api/agent/' + id + ' dengan header X-Payment-Ref: ' + ch.ref + ')'
          );
        }
      }
    } else if (cmd === '/semak') {
      const challenge = String(bahagian[1] || '').trim();
      if (!challenge) {
        await pekerjaSend(env, chatId, 'Format: /semak <challenge>');
      } else {
        await ensureAgentTable(env);
        const row = (await env.DB.prepare('SELECT * FROM agent_calls WHERE challenge = ?').bind(challenge).run())?.results?.[0] || null;
        if (!row) {
          await pekerjaSend(env, chatId, 'Cabaran tak dijumpai.');
        } else if (row.status === 'paid' && row.result) {
          await pekerjaSend(env, chatId, '✅ Sudah dibayar.\n\n' + row.result);
        } else {
          const svc = AGENT_SERVICE_META[row.service];
          const r = await agentSettle(env, row.service, svc, row.payload || '', { challenge });
          await pekerjaSend(env, chatId, r.ok ? '✅ Bayaran diterima!\n\n' + r.hasil : '⏳ ' + r.reason);
        }
      }
    } else if (cmd === '/hasil') {
      if (!isAdmin) {
        await pekerjaSend(env, chatId, 'Akses pemilik sahaja.');
      } else {
        await ensureAgentTable(env);
        const [j] = (await env.DB.prepare(
          "SELECT COUNT(*) AS jumlah, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS dibayar, COALESCE(SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END),0) AS usd FROM agent_calls"
        ).run())?.results || [];
        const per = (await env.DB.prepare(
          "SELECT service, COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS usd FROM agent_calls WHERE status = 'paid' GROUP BY service ORDER BY n DESC"
        ).run())?.results || [];
        await pekerjaSend(env, chatId,
          '💰 Hasil Agent API\n' +
          '• Cabaran: ' + (j?.jumlah || 0) + '\n' +
          '• Dibayar: ' + (j?.dibayar || 0) + '\n' +
          '• Hasil: $' + Number(j?.usd || 0).toFixed(4) +
          (per.length ? '\n\nPer servis:\n' + per.map((p) => '• ' + p.service + ': ' + p.n + ' ($' + Number(p.usd).toFixed(4) + ')').join('\n') : '')
        );
      }
    } else if (cmd.startsWith('/')) {
      await pekerjaSend(env, chatId, 'Arahan: /servis · /beli <id> <teks> · /semak <challenge>');
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error('webhook-pekerja ralat:', err?.message || err);
    return c.json({ ok: true });
  }
});

export default app;
