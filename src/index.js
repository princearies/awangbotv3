import { Hono } from 'hono';

const app = new Hono();

// Prompt asal untuk AwangBot78
const SYSTEM_PROMPT = `
Anda ialah Pembantu AI untuk AwangBot78 — perniagaan yang MEMBINA BOT AI KUSTOM untuk pelbagai jenis pelanggan.

Contoh jenis bot yang kami pernah bina:
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
- Jangan sebut pasal penghantaran fizikal.
`;

// Prompt khas untuk CikguBot Demo
const CIKGU_SYSTEM_PROMPT = `
Anda ialah CikguBot — Tutor AI mesra dan pintar untuk pelajar sekolah/tuisyen di Malaysia.

Peranan anda:
- Membantu menerangkan soalan pelajaran (Matematik, Sains, Sejarah, Bahasa Melayu, Bahasa Inggeris, dll).
- Memberi penjelasan yang mudah difahami, bersikap mesra, bersemangat dan sabar.
- Gunakan bahasa Melayu yang sopan (gunakan panggilan "Cikgu" atau "CikguBot" dan panggil pengguna "pelajar" atau "adik").
- Jika soalan perlukan langkah penyelesaian (seperti Matematik), tunjukkan langkah ringkas satu per satu.
`;

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
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
    }),
  });
}

async function askAi(env, message, customPrompt = null) {
  const ai = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: customPrompt || SYSTEM_PROMPT },
      { role: 'user', content: message },
    ],
  });

  return ai?.response || 'Maaf, saya kurang pasti. Sila cuba soalan lain.';
}

async function saveLead(env, nama, notes) {
  try {
    await env.DB.prepare(
      'INSERT INTO leads (nama_pelanggan, soalan) VALUES (?, ?)'
    ).bind(nama, notes).run();
  } catch (err) {
    console.warn('DB insert failed:', err);
  }
}

app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>AwangBot78 - Live Chat & CikguBot Portal</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { background: #020817; }
      </style>
    </head>
    <body class="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
      <div class="w-full max-w-xl h-[88vh] bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header class="flex flex-wrap items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/90 gap-2">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
            <span class="font-bold text-blue-400 text-sm md:text-base">AwangBot78 Portal</span>
          </div>

          <!-- TAB BUTTONS -->
          <div class="flex gap-1 rounded-xl bg-slate-900 p-1 border border-slate-700 text-xs">
            <button type="button" data-tab="chat" class="tab-btn px-2.5 py-1.5 rounded-lg font-bold transition bg-blue-600 text-white">💬 Live Chat</button>
            <button type="button" data-tab="cikgu" class="tab-btn px-2.5 py-1.5 rounded-lg font-bold transition text-slate-400 hover:text-white">👨‍🏫 CikguBot Demo</button>
            <button type="button" data-tab="form" class="tab-btn px-2.5 py-1.5 rounded-lg font-bold transition text-slate-400 hover:text-white">📝 Permohonan</button>
          </div>
        </header>

        <!-- TAB 1: LIVE CHAT (AWANGBOT78) -->
        <section id="tab-chat" class="tab-panel flex flex-col flex-1 overflow-hidden">
          <div id="chat-box" class="flex-1 overflow-y-auto p-4 space-y-4">
            <div class="flex items-start">
              <div class="max-w-[85%] bg-blue-600/30 border border-blue-500/30 p-3 rounded-2xl text-sm">
                👋 <b>Hai! Saya AwangBot78.</b><br>
                Tanya saya tentang tempahan bot custom, atau cuba tab <b>CikguBot Demo</b> untuk lihat contoh bot latihan!
              </div>
            </div>
          </div>

          <div id="loading" class="hidden px-4 py-1 text-xs text-slate-400 italic">
            AwangBot78 sedang menaip...
          </div>

          <div class="p-3 border-t border-slate-700 bg-slate-800/90">
            <form id="chat-form" class="flex gap-2">
              <input
                id="user-input"
                type="text"
                required
                placeholder="Taip soalan tempahan bot..."
                class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                class="bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-xl font-bold text-sm transition"
              >
                Hantar
              </button>
            </form>
          </div>
        </section>

        <!-- TAB 2: CIKGUBOT DEMO (LIVE WORKING BOT) -->
        <section id="tab-cikgu" class="tab-panel hidden flex flex-col flex-1 overflow-hidden">
          <div class="p-3 bg-emerald-950/50 border-b border-emerald-800/50 text-xs text-emerald-300 flex items-center justify-between">
            <span>📚 <b>CikguBot (Tutor AI):</b> Sedia membantu soalan subjek Sekolah/Tuisyen!</span>
            <span class="bg-emerald-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">Aktif</span>
          </div>

          <div id="cikgu-chat-box" class="flex-1 overflow-y-auto p-4 space-y-4">
            <div class="flex items-start">
              <div class="max-w-[85%] bg-emerald-600/20 border border-emerald-500/30 p-3 rounded-2xl text-sm">
                👨‍🏫 <b>Selamat datang ke CikguBot!</b><br>
                Saya ialah Pembantu Tutor AI. Tanya saya apa sahaja soalan Matematik, Sains, Sejarah atau Bahasa Melayu!
              </div>
            </div>
          </div>

          <div id="cikgu-loading" class="hidden px-4 py-1 text-xs text-emerald-400 italic">
            CikguBot sedang memikirkan jawapan...
          </div>

          <div class="p-3 border-t border-slate-700 bg-slate-800/90">
            <form id="cikgu-form" class="flex gap-2">
              <input
                id="cikgu-input"
                type="text"
                required
                placeholder="Tanya soalan pelajaran di sini..."
                class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2.5 rounded-xl font-bold text-sm transition"
              >
                Tanya Cikgu
              </button>
            </form>
          </div>
        </section>

        <!-- TAB 3: BORANG PERMOHONAN -->
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

            <button type="submit" class="w-full bg-green-600 hover:bg-green-500 font-bold py-2.5 rounded-lg transition duration-200 text-sm shadow-lg shadow-green-500/20">
              Hantar Permohonan
            </button>
          </form>
        </section>
      </div>
    </body>

    <script>
      function switchTab(tab) {
        var panels = document.querySelectorAll('.tab-panel');
        var buttons = document.querySelectorAll('.tab-btn');

        panels.forEach(function(panel) {
          panel.classList.toggle('hidden', panel.id !== 'tab-' + tab);
        });

        buttons.forEach(function(btn) {
          var active = btn.dataset.tab === tab;
          btn.classList.toggle('bg-blue-600', active && tab === 'chat');
          btn.classList.toggle('bg-emerald-600', active && tab === 'cikgu');
          btn.classList.toggle('bg-green-600', active && tab === 'form');
          btn.classList.toggle('text-white', active);
          btn.classList.toggle('text-slate-400', !active);
          btn.classList.toggle('hover:text-white', !active);
        });
      }

      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
      });

      // LOGIK CHAT AWANGBOT78
      var chatForm = document.getElementById('chat-form');
      var chatBox = document.getElementById('chat-box');
      var userInput = document.getElementById('user-input');
      var loading = document.getElementById('loading');

      chatForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        var text = userInput.value.trim();
        if (!text) return;

        var userBubble = '<div class="flex justify-end"><div class="bg-blue-600 p-3 rounded-2xl max-w-[85%] text-sm text-white shadow">' + escapeHtml(text) + '</div></div>';
        chatBox.insertAdjacentHTML('beforeend', userBubble);
        userInput.value = '';
        chatBox.scrollTop = chatBox.scrollHeight;
        loading.classList.remove('hidden');

        try {
          var response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
          });
          var data = await response.json();
          if (!response.ok) throw new Error(data?.error || 'Ralat API chat.');

          var botBubble = '<div class="flex items-start"><div class="bg-slate-700 border border-slate-600 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100 shadow">' + escapeHtml(data.reply || 'Tiada jawapan.') + '</div></div>';
          chatBox.insertAdjacentHTML('beforeend', botBubble);
        } catch (err) {
          var errorBubble = '<div class="flex items-start"><div class="bg-red-500/20 border border-red-500/30 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100">⚠️ ' + escapeHtml(err.message || 'Sistem AI gagal diproses.') + '</div></div>';
          chatBox.insertAdjacentHTML('beforeend', errorBubble);
        } finally {
          loading.classList.add('hidden');
          chatBox.scrollTop = chatBox.scrollHeight;
        }
      });

      // LOGIK CIKGUBOT CHAT
      var cikguForm = document.getElementById('cikgu-form');
      var cikguChatBox = document.getElementById('cikgu-chat-box');
      var cikguInput = document.getElementById('cikgu-input');
      var cikguLoading = document.getElementById('cikgu-loading');

      cikguForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        var text = cikguInput.value.trim();
        if (!text) return;

        var userBubble = '<div class="flex justify-end"><div class="bg-emerald-600 p-3 rounded-2xl max-w-[85%] text-sm text-white shadow">' + escapeHtml(text) + '</div></div>';
        cikguChatBox.insertAdjacentHTML('beforeend', userBubble);
        cikguInput.value = '';
        cikguChatBox.scrollTop = cikguChatBox.scrollHeight;
        cikguLoading.classList.remove('hidden');

        try {
          var response = await fetch('/api/cikgu-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
          });
          var data = await response.json();
          if (!response.ok) throw new Error(data?.error || 'Ralat CikguBot API.');

          var botBubble = '<div class="flex items-start"><div class="bg-slate-700 border border-emerald-500/40 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100 shadow">👨‍🏫 <b>[CikguBot]</b><br>' + escapeHtml(data.reply || 'Tiada jawapan.') + '</div></div>';
          cikguChatBox.insertAdjacentHTML('beforeend', botBubble);
        } catch (err) {
          var errorBubble = '<div class="flex items-start"><div class="bg-red-500/20 border border-red-500/30 p-3 rounded-2xl max-w-[85%] text-sm text-slate-100">⚠️ ' + escapeHtml(err.message || 'Ralat CikguBot AI.') + '</div></div>';
          cikguChatBox.insertAdjacentHTML('beforeend', errorBubble);
        } finally {
          cikguLoading.classList.add('hidden');
          cikguChatBox.scrollTop = cikguChatBox.scrollHeight;
        }
      });
    </script>
    </html>
  `);
});

// ENDPOINT LIVE CHAT ASAL
app.post('/api/chat', async (c) => {
  try {
    const body = await c.req.json();
    const message = String(body.message || '').trim();

    if (!message) {
      return c.json({ error: 'Mesej kosong.' }, 400);
    }

    const reply = await askAi(c.env, message);
    await saveLead(c.env, 'Web Chat User', message);

    return c.json({ reply });
  } catch (err) {
    console.error('Chat route error:', err);
    return c.json({ error: 'Ralat pemprosesan web chat.' }, 500);
  }
});

// ENDPOINT KHAS CIKGUBOT
app.post('/api/cikgu-chat', async (c) => {
  try {
    const body = await c.req.json();
    const message = String(body.message || '').trim();

    if (!message) {
      return c.json({ error: 'Mesej kosong.' }, 400);
    }

    // Menggunakan Prompt Khas CikguBot
    const reply = await askAi(c.env, message, CIKGU_SYSTEM_PROMPT);
    await saveLead(c.env, 'CikguBot User', message);

    return c.json({ reply });
  } catch (err) {
    console.error('CikguBot Chat route error:', err);
    return c.json({ error: 'Ralat pemprosesan CikguBot Chat.' }, 500);
  }
});

// ENDPOINT PERMOHONAN
app.post('/register', async (c) => {
  try {
    const body = await c.req.parseBody();
    const nama = String(body.nama || '').trim() || 'Tanpa Nama';
    const kontak = String(body.kontak || '').trim() || '-';
    const pakej = String(body.pakej || '').trim() || '-';
    const soalan = String(body.soalan || '').trim() || '-';

    const infoLengkap = '[Permohonan Web] Kontak: ' + kontak + ' | Pakej: ' + pakej + ' | Keperluan: ' + soalan;

    await saveLead(c.env, nama, infoLengkap);

    return c.html(`
      <!DOCTYPE html>
      <html lang="ms">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
        <div class="max-w-md w-full bg-slate-800 rounded-2xl p-6 text-center border border-slate-700 shadow-2xl">
          <div class="text-green-400 text-5xl mb-4">✅</div>
          <h2 class="text-2xl font-bold mb-2">Permohonan Berjaya!</h2>
          <p class="text-slate-300 mb-6">
            Terima kasih <b>${escapeHtml(nama)}</b>. Maklumat anda telah disimpan ke sistem AwangBot78.
          </p>
          <a href="/" class="inline-block bg-blue-600 px-6 py-2 rounded-lg font-semibold hover:bg-blue-500 transition">
            Kembali ke Web
          </a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Register route error:', err);
    return c.text('Ralat permohonan: ' + err.message, 500);
  }
});

// WEBHOOK TELEGRAM
app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();

    if (!update?.message?.text) {
      return c.text('OK');
    }

    const chatId = String(update.message.chat.id);
    const text = String(update.message.text).trim();

    if (text === '/start') {
      await sendTelegramMessage(
        c.env.BOT_TOKEN,
        chatId,
        '👋 <b>Hai! Saya AwangBot78.</b>\nKami bina bot AI custom untuk cikgu, influencer, syarikat dan bisnes. Cakap apa jenis bot yang anda nak.'
      );
      return c.text('OK');
    }

    try {
      const aiReply = await askAi(c.env, text);
      await sendTelegramMessage(c.env.BOT_TOKEN, chatId, aiReply);
      await saveLead(c.env, String(chatId), text);
    } catch (err) {
      console.error('Telegram AI error:', err);
      await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '⚠️ Maaf, sistem AI mengalami gangguan seketika.');
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }

  return c.text('OK');
});

// WEBHOOK WHATSAPP
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
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg || !msg.text) {
      return c.json({ ok: true });
    }

    const from = msg.from;
    const text = String(msg.text.body || '').trim();

    try {
      const aiReply = await askAi(c.env, text);
      await fetch('https://graph.facebook.com/v20.0/' + c.env.PHONE_NUMBER_ID + '/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + c.env.ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: aiReply || 'Maaf, sila cuba lagi.' },
        }),
      });
      await saveLead(c.env, from, text);
    } catch (err) {
      console.error('WhatsApp AI error:', err);
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }

  return c.json({ ok: true });
});

export default app;
