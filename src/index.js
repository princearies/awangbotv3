import { Hono } from 'hono';
const app = new Hono();

// --- Telegram Function ---
async function sendTelegramMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

const SYSTEM_PROMPT = `Anda ialah Pembantu AI untuk AwangBot78 — perniagaan yang MEMBINA BOT AI KUSTOM untuk pelbagai jenis pelanggan.

Contoh jenis bot yang kami dah pernah bina:
- CikguBot — untuk tutor/pusat tuisyen
- InfluencerBot — untuk content creator/influencer
- EnterpriseBot — untuk syarikat/perniagaan

Pakej harga:
- Pakej A: RM50 — bot asas, 1 fungsi utama
- Pakej B: RM90 — bot standard, 2-3 fungsi custom
- Pakej C: RM130 — bot lengkap, custom penuh + sokongan lanjutan

Arahan jawapan:
- Jawab ringkas dalam Bahasa Melayu (2-3 ayat).
- TANYA apa fungsi/jenis bot yang mereka nak.
- Jangan sebut pasal penghantaran fizikal.`;

// --- 1. WEB CHAT GUI + REGISTRATION FORM (GET /) ---
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AwangBot78 - Live AI Assistant</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex flex-col items-center justify-center p-3 md:p-6">
      
      <div class="max-w-xl w-full bg-slate-800 rounded-2xl shadow-2xl border border-slate-700 flex flex-col h-[85vh]">
        
        <!-- Header -->
        <div class="p-4 border-b border-slate-700 bg-slate-800/80 rounded-t-2xl flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
            <div>
              <h1 class="font-bold text-lg text-blue-400">AwangBot78 Web AI</h1>
              <p class="text-xs text-slate-400">Tanya soalan & daftar bot AI anda secara live</p>
            </div>
          </div>
        </div>

        <!-- Chat Messages Area -->
        <div id="chat-box" class="flex-1 overflow-y-auto p-4 space-y-4">
          <div class="flex items-start space-x-2">
            <div class="bg-blue-600/30 border border-blue-500/30 p-3 rounded-2xl max-w-[85%] text-sm">
              👋 <b>Hai! Saya AwangBot78.</b><br>Kami bina bot AI custom (cth: CikguBot, InfluencerBot, Syarikat). Boleh tanya apa-apa soalan di sini atau minta cadangan pakej!
            </div>
          </div>
        </div>

        <!-- Typing Indicator -->
        <div id="loading" class="hidden px-4 py-2 text-xs text-slate-400 italic">
          AwangBot78 sedang menaip...
        </div>

        <!-- Input Area -->
        <div class="p-3 border-t border-slate-700 bg-slate-800/90 rounded-b-2xl">
          <form id="chat-form" class="flex gap-2">
            <input type="text" id="user-input" required placeholder="Taip soalan anda di sini..." class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500">
            <button type="submit" class="bg-blue-600 hover:bg-blue-500 px-5 py-3 rounded-xl font-bold text-sm transition shadow-lg shadow-blue-500/20">
              Hantar
            </button>
          </form>
        </div>

      </div>

      <script>
        const form = document.getElementById('chat-form');
        const input = document.getElementById('user-input');
        const box = document.getElementById('chat-box');
        const loading = document.getElementById('loading');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;

          // User message UI
          box.innerHTML += \`
            <div class="flex justify-end">
              <div class="bg-blue-600 p-3 rounded-2xl max-w-[85%] text-sm text-white shadow">
                \${text}
              </div>
            </div>
          \`;
          input.value = '';
          box.scrollTop = box.scrollHeight;
          loading.classList.remove('hidden');

          try {
            const res = await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: text })
            });
            const data = await res.json();
            
            loading.classList.add('hidden');
            box.innerHTML += \`
              <div class="flex items-start space-x-2">
                <div class="bg-slate-700 border border-slate-600 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100 shadow">
                  \${data.reply}
                </div>
              </div>
            \`;
            box.scrollTop = box.scrollHeight;
          } catch(err) {
            loading.classList.add('hidden');
            box.innerHTML += \`
              <div class="flex justify-center">
                <div class="bg-red-500/20 text-red-300 text-xs p-2 rounded-lg">
                  Ralat sambungan. Sila cuba lagi.
                </div>
              </div>
            \`;
          }
        });
      </script>
    </body>
    </html>
  `);
});

// --- 2. API ENDPOINT UNTUK WEB LIVE CHAT (POST /api/chat) ---
app.post('/api/chat', async (c) => {
  try {
    const body = await c.req.json();
    const text = body.message || '';

    let reply = 'Maaf, sila cuba lagi.';
    try {
      const ai = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }]
      });
      reply = ai.response || reply;
    } catch (aiErr) {
      console.error('Web AI Error:', aiErr);
      reply = '⚠️ Sistem AI mengalami gangguan seketika.';
    }

    // Simpan lead dari Web Chat
    try {
      await c.env.DB.prepare("INSERT INTO leads (nama_pelanggan, soalan) VALUES (?,?)").bind('Web User', text).run();
    } catch(e){}

    return c.json({ reply });
  } catch(e) {
    return c.json({ reply: 'Ralat pemprosesan web chat.' }, 500);
  }
});

// --- 3. TELEGRAM WEBHOOK ---
app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();
    if (update.message?.text) {
      const chatId = String(update.message.chat.id);
      const text = update.message.text.trim();

      if (text === '/start') {
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '👋 <b>Hai! Saya AwangBot78.</b>\nKami bina bot AI custom (cth: untuk cikgu, influencer, syarikat). Cakap apa jenis bot yang anda nak, saya bantu terangkan pakej yang sesuai!');
        return c.text('OK');
      }

      try {
        const ai = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }]
        });
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, ai.response || 'Maaf, saya kurang pasti. Sila cuba soalan lain.');
      } catch (aiErr) {
        console.error('AI Error:', aiErr);
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '⚠️ Maaf, sistem AI mengalami gangguan seketika. Sila cuba lagi.');
      }

      try { await c.env.DB.prepare("INSERT INTO leads (nama_pelanggan, soalan) VALUES (?,?)").bind(chatId, text).run() } catch(e){}
    }
  } catch (e) { console.error(e) }
  return c.text('OK');
});

// --- 4. WHATSAPP WEBHOOK ---
app.get('/webhook/whatsapp', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token === c.env.VERIFY_TOKEN) {
    return c.text(challenge || '');
  }
  return c.text('Forbidden', 403);
});

app.post('/webhook/whatsapp', async (c) => {
  try {
    const body = await c.req.json();
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || !msg.text) return c.json({ ok: true });

    const from = msg.from;
    const text = msg.text.body;

    try {
      const ai = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }]
      });

      await fetch(`https://graph.facebook.com/v20.0/${c.env.PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          text: { body: ai.response || 'Maaf, sila cuba lagi.' }
        })
      });
    } catch (aiErr) {
      console.error('WhatsApp AI Error:', aiErr);
    }

    try { await c.env.DB.prepare("INSERT INTO leads (nama_pelanggan, soalan) VALUES (?,?)").bind(from, text).run() } catch(e){}
  } catch (e) { console.error(e) }
  return c.json({ ok: true });
});

export default app;
