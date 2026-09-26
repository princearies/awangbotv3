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

async function askClaude(env, message, systemPrompt) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = env?.CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL;

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
      messages: [{ role: 'user', content: message }]
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

async function askWorkersAi(env, message, systemPrompt) {
  if (!env?.AI) return null;
  const ai = await env.AI.run(env?.CF_MODEL || '@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ]
  });
  return (ai?.response || '').trim() || null;
}

async function askAi(env, message, customPrompt = null) {
  const systemPrompt = customPrompt || AWANGBOT_PROMPT;

  if (!claudeDisabled && env?.ANTHROPIC_API_KEY) {
    try {
      const out = await askClaude(env, message, systemPrompt);
      if (out) return out;
    } catch (err) {
      console.warn('Claude request gagal, fallback:', err?.message || err);
    }
  }

  try {
    const out = await askWorkersAi(env, message, systemPrompt);
    if (out) return out;
  } catch (err) {
    console.error('Workers AI error:', err);
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

  return c.html(`
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
        }
        .tab-strip::-webkit-scrollbar { display: none; }
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
      }

      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
      });

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
                escapeHtml(data.reply || 'Tiada jawapan.') + '</div></div>';
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

    const aiReply = await askAi(c.env, text, AWANGBOT_PROMPT);
    await sendTelegramMessage(c.env.BOT_TOKEN, chatId, aiReply);
    await saveLead(c.env, `Telegram User (${chatId})`, text);
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
  return c.text('OK');
});

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
