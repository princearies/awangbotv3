import { Hono } from 'hono';
import { AWANGBOT_PROMPT } from './prompts/awangbot.js';
import { CIKGU_PROMPT } from './prompts/cikgu.js';
import { BANK_PROMPT } from './prompts/bank.js';

// Import Semua Konfigurasi Tab
import { CHAT_TAB } from './tabs/chat.js';
import { CIKGU_TAB } from './tabs/cikgu.js';
import { BANK_TAB } from './tabs/bank.js';
import { FORM_TAB } from './tabs/form.js';

const app = new Hono();

// Senarai Tab Aktif Portal
const TABS = [CHAT_TAB, CIKGU_TAB, BANK_TAB, FORM_TAB];

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendTelegramMessage(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
  });
}

async function askAi(env, message, customPrompt = null) {
  const ai = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: customPrompt || AWANGBOT_PROMPT },
      { role: 'user', content: message },
    ],
  });
  return ai?.response || 'Maaf, saya kurang pasti. Sila cuba soalan lain.';
}

async function saveLead(env, nama, notes) {
  try {
    await env.DB.prepare('INSERT INTO leads (nama_pelanggan, soalan) VALUES (?, ?)').bind(nama, notes).run();
  } catch (err) {
    console.warn('DB insert failed:', err);
  }
}

app.get('/', (c) => {
  const navButtons = TABS.map((t, idx) => `
    <button type="button" data-tab="${t.id}" class="tab-btn px-2.5 py-1.5 rounded-lg font-bold transition ${idx === 0 ? t.activeColor + ' text-white' : 'text-slate-400 hover:text-white'}">
      ${t.label}
    </button>
  `).join('');

  const chatPanels = TABS.filter(t => t.id !== 'form').map((t, idx) => `
    <section id="tab-${t.id}" class="tab-panel ${idx === 0 ? '' : 'hidden'} flex flex-col flex-1 overflow-hidden">
      ${t.headerBanner ? `<div class="p-2.5 bg-slate-900/80 border-b border-slate-700/50 text-xs text-slate-300 flex items-center justify-between"><span>${t.headerBanner}</span><span class="bg-green-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">Aktif</span></div>` : ''}

      <div id="${t.id}-chat-box" class="flex-1 overflow-y-auto p-4 space-y-4">
        <div class="flex items-start">
          <div class="max-w-[85%] bg-slate-700/50 border border-slate-600/50 p-3 rounded-2xl text-sm">
            ${t.welcomeMsg}
          </div>
        </div>
      </div>

      <div id="${t.id}-loading" class="hidden px-4 py-1 text-xs text-slate-400 italic">
        Bot sedang memikirkan jawapan...
      </div>

      <div class="p-3 border-t border-slate-700 bg-slate-800/90">
        <form id="${t.id}-form" class="flex gap-2">
          <input id="${t.id}-input" type="text" required placeholder="${t.placeholder}" class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500" />
          <button type="submit" class="bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-xl font-bold text-sm transition">Hantar</button>
        </form>
      </div>
    </section>
  `).join('');

  return c.html(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>AwangBot78 - Multi-Bot Portal</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style> body { background: #020817; } </style>
    </head>
    <body class="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
      <div class="w-full max-w-xl h-[88vh] bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header class="flex flex-wrap items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/90 gap-2">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
            <span class="font-bold text-blue-400 text-sm md:text-base">AwangBot78 Portal</span>
          </div>
          <div class="flex gap-1 rounded-xl bg-slate-900 p-1 border border-slate-700 text-xs">
            ${navButtons}
          </div>
        </header>

        ${chatPanels}

        <!-- TAB BORANG PERMOHONAN -->
        <section id="tab-form" class="tab-panel hidden flex-1 overflow-y-auto p-5">
          <h2 class="text-xl font-bold text-blue-400 mb-1">Borang Permohonan Bot Custom</h2>
          <p class="text-xs text-slate-400 mb-4">Isi maklumat di bawah untuk pendaftaran tempahan bot anda.</p>
          <form id="lead-form" action="/register" method="POST" class="space-y-3">
            <div>
              <label class="block text-xs font-medium mb-1 text-slate-300">Nama Anda / Syarikat</label>
              <input name="nama" type="text" required placeholder="Contoh: Ahmad / Kedai Makanan" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label class="block text-xs font-medium mb-1 text-slate-300">Nombor WhatsApp / Telegram</label>
              <input name="kontak" type="text" required placeholder="Contoh: 0123456789 atau @ahmad" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label class="block text-xs font-medium mb-1 text-slate-300">Pilihan Pakej</label>
              <select name="pakej" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                <option value="Pakej A (RM50)">Pakej A (RM50) — Bot Asas</option>
                <option value="Pakej B (RM90)">Pakej B (RM90) — Bot Standard</option>
                <option value="Pakej C (RM130)">Pakej C (RM130) — Bot Lengkap Custom</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium mb-1 text-slate-300">Fungsi Bot Yang Diingini</label>
              <textarea name="soalan" rows="3" required placeholder="Terangkan keperluan bot anda..." class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"></textarea>
            </div>
            <button type="submit" class="w-full bg-green-600 hover:bg-green-500 font-bold py-2.5 rounded-lg transition duration-200 text-sm shadow-lg shadow-green-500/20">Hantar Permohonan</button>
          </form>
        </section>
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
        if (targetPanel) targetPanel.classList.remove('hidden');

        document.querySelectorAll('.tab-btn').forEach(function(btn) {
          var isCurrent = btn.dataset.tab === selectedTab;
          var tabObj = tabsConfig.find(function(t) { return t.id === btn.dataset.tab; });
          var activeClass = tabObj ? tabObj.activeColor : 'bg-blue-600';

          btn.className = 'tab-btn px-2.5 py-1.5 rounded-lg font-bold transition ' + (isCurrent ? activeClass + ' text-white' : 'text-slate-400 hover:text-white');
        });
      }

      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
      });

      tabsConfig.filter(function(t) { return t.id !== 'form'; }).forEach(function(t) {
        var formElem = document.getElementById(t.id + '-form');
        var inputElem = document.getElementById(t.id + '-input');
        var boxElem = document.getElementById(t.id + '-chat-box');
        var loadingElem = document.getElementById(t.id + '-loading');

        if (formElem) {
          formElem.addEventListener('submit', async function(e) {
            e.preventDefault();
            var text = inputElem.value.trim();
            if (!text) return;

            var userBubble = '<div class="flex justify-end"><div class="' + (t.activeColor || 'bg-blue-600') + ' p-3 rounded-2xl max-w-[85%] text-sm text-white shadow">' + escapeHtml(text) + '</div></div>';
            boxElem.insertAdjacentHTML('beforeend', userBubble);
            inputElem.value = '';
            boxElem.scrollTop = boxElem.scrollHeight;
            loadingElem.classList.remove('hidden');

            try {
              var response = await fetch(t.apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
              });
              var data = await response.json();
              if (!response.ok) throw new Error(data?.error || 'Ralat API.');

              var botBubble = '<div class="flex items-start"><div class="bg-slate-700 ' + t.borderStyle + ' p-3 rounded-2xl max-w-[85%] text-sm text-slate-100 shadow">' + (t.badge ? '<b>' + t.badge + '</b><br>' : '') + escapeHtml(data.reply || 'Tiada jawapan.') + '</div></div>';
              boxElem.insertAdjacentHTML('beforeend', botBubble);
            } catch (err) {
              var errorBubble = '<div class="flex items-start"><div class="bg-red-500/20 border border-red-500/30 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100">⚠️ ' + escapeHtml(err.message) + '</div></div>';
              boxElem.insertAdjacentHTML('beforeend', errorBubble);
            } finally {
              loadingElem.classList.add('hidden');
              boxElem.scrollTop = boxElem.scrollHeight;
            }
          });
        }
      });
    </script>
    </html>
  `);
});

// API ROUTINGS
app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  const reply = await askAi(c.env, String(body.message || '').trim(), AWANGBOT_PROMPT);
  await saveLead(c.env, 'Web Chat User', body.message);
  return c.json({ reply });
});

app.post('/api/cikgu-chat', async (c) => {
  const body = await c.req.json();
  const reply = await askAi(c.env, String(body.message || '').trim(), CIKGU_PROMPT);
  await saveLead(c.env, 'CikguBot User', body.message);
  return c.json({ reply });
});

app.post('/api/bank-chat', async (c) => {
  const body = await c.req.json();
  const reply = await askAi(c.env, String(body.message || '').trim(), BANK_PROMPT);
  await saveLead(c.env, 'BankBot Lead', body.message);
  return c.json({ reply });
});

app.post('/register', async (c) => {
  const body = await c.req.parseBody();
  await saveLead(c.env, String(body.nama || 'Tanpa Nama'), '[Permohonan] Kontak: ' + body.kontak + ' | Pakej: ' + body.pakej);
  return c.html('<div style="background:#020817;color:white;text-align:center;padding:50px;"><h2>✅ Permohonan Berjaya!</h2><a href="/" style="color:#3b82f6;">Kembali ke Web</a></div>');
});

app.post('/webhook', async (c) => {
  const update = await c.req.json();
  if (!update?.message?.text) return c.text('OK');
  const chatId = String(update.message.chat.id);
  const text = String(update.message.text).trim();
  if (text === '/start') {
    await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '👋 Hai! Saya AwangBot78.');
    return c.text('OK');
  }
  const aiReply = await askAi(c.env, text, AWANGBOT_PROMPT);
  await sendTelegramMessage(c.env.BOT_TOKEN, chatId, aiReply);
  return c.text('OK');
});

export default app;
