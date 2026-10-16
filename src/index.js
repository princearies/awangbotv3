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

  // 1. Gemini free dulu (kalau ada key)
  if (env?.GEMINI_API_KEY) {
    try {
      const out = await askGemini(env, message, systemPrompt, history);
      if (out) return out;
    } catch (err) {
      console.warn('Gemini gagal, fallback:', err?.message || err);
    }
  }

  // 2. Workers AI free
  try {
    const out = await askWorkersAi(env, message, systemPrompt, history);
    if (out) return out;
  } catch (err) {
    console.error('Workers AI error:', err);
  }

  // 3. Claude prepaid — last resort saja ($5 trial cepat habis)
  if (!claudeDisabled && env?.ANTHROPIC_API_KEY) {
    try {
      const out = await askClaude(env, message, systemPrompt, history);
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
}

async function saveDropshipOrder(env, o) {
  await ensureDropshipTables(env);
  if (!env?.DB) return null;
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
  const salesPrompt = isBotSales ? PROMPT_017 : (lang === 'ms' ? PROMPT_DROPSHIP : PROMPT_DROPSHIP_EN);
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
  const id = Number(c.req.query('id') || 0);
  if (!id) return c.json({ ok: false, error: 'id diperlukan' }, 400);
  try {
    await ensureDropshipTables(c.env);
    const row = await c.env.DB.prepare(
      'SELECT id, barang, qty, status FROM dropship_orders WHERE id = ?'
    ).bind(id).run();
    const hit = row?.results?.[0];
    if (!hit) return c.json({ ok: false, error: 'tiada order' }, 404);
    return c.json({ ok: true, ...hit });
  } catch (e) { return c.json({ ok: false, error: 'DB ralat' }, 500); }
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
  if(o){fetch('/api/order?id='+encodeURIComponent(o)).then(function(r){return r.json()}).then(function(d){if(d.ok){line.textContent='Order #'+d.id+' — '+d.barang+' x'+d.qty+' ('+d.status+')'}}).catch(function(){})}
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
  const products = (Array.isArray(body.products) ? body.products : [])
    .map((s) => String(s).slice(0, 80))
    .filter(Boolean)
    .slice(0, 5);
  if (!products.length) return c.json({ ok: false, error: 'products diperlukan, cth ["kopi sabah","kuali viral"]' }, 400);
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
  try {
    const update = await c.req.json();
    if (!update?.message?.text) return c.text('OK');
    const chatId = String(update.message.chat.id);
    const text = String(update.message.text).trim();

    if (text === '/start') {
      await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '👋 Hai! Saya AwangBot78. Tanya saya tentang pakej dan perkhidmatan bot kustom untuk perniagaan anda.');
      return c.text('OK');
    }

    // Owner commands (ADMIN_ID sahaja): PAID n | POS n TRACKING | SAMPAI n | STATUS n | REFUND n
    if (c.env.ADMIN_ID && chatId === String(c.env.ADMIN_ID)) {
      const handled = await handleOwnerCommand(c.env, text);
      if (handled) {
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, handled);
        return c.text('OK');
      }
    }

    const aiReply = await askAi(c.env, text, AWANGBOT_PROMPT);
    await sendTelegramMessage(c.env.BOT_TOKEN, chatId, aiReply);
    await saveLead(c.env, `Telegram User (${chatId})`, text);
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
  return c.text('OK');
});

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
  const m = String(text || '').trim().match(/^(paid|pos|sampai|status|refund)\s+(\d+)\s*([\s\S]*)$/i);
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

export default app;
