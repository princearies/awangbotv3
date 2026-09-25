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

// --- 1. WEB GUI LANDING PAGE & BORANG PENDAFTARAN (GET /) ---
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pendaftaran AwangBot78</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-slate-800 rounded-2xl shadow-2xl p-6 border border-slate-700">
        <div class="text-center mb-6">
          <h1 class="text-3xl font-extrabold text-blue-400">AwangBot78</h1>
          <p class="text-slate-400 text-sm mt-1">Borang Pendaftaran Custom AI Bot</p>
        </div>
        
        <form action="/register" method="POST" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1 text-slate-300">Nama Anda / Syarikat</label>
            <input type="text" name="nama" required placeholder="Contoh: Ahmad / Kedai Makanan" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500">
          </div>

          <div>
            <label class="block text-sm font-medium mb-1 text-slate-300">Nombor WhatsApp / Username Telegram</label>
            <input type="text" name="kontak" required placeholder="Contoh: 0123456789 atau @ahmad" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500">
          </div>

          <div>
            <label class="block text-sm font-medium mb-1 text-slate-300">Pilihan Pakej</label>
            <select name="pakej" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500">
              <option value="Pakej A (RM50)">Pakej A (RM50) — Bot Asas</option>
              <option value="Pakej B (RM90)">Pakej B (RM90) — Bot Standard</option>
              <option value="Pakej C (RM130)">Pakej C (RM130) — Bot Lengkap Custom</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium mb-1 text-slate-300">Fungsi Bot Yang Diingini</label>
            <textarea name="soalan" rows="3" required placeholder="Contoh: Saya nak bot jawal soalan harga tuisyen & subjek..." class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"></textarea>
          </div>

          <button type="submit" class="w-full bg-blue-600 hover:bg-blue-500 font-bold py-3 rounded-lg transition duration-200 shadow-lg shadow-blue-500/30">
            Hantar Pendaftaran
          </button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- 2. PROSES PENDAFTARAN FORM (POST /register) ---
app.post('/register', async (c) => {
  try {
    const body = await c.req.parseBody();
    const nama = body.nama || 'Tanpa Nama';
    const kontak = body.kontak || '-';
    const pakej = body.pakej || '-';
    const soalan = body.soalan || '-';

    const infoLengkap = `[Pendaftaran Web] Kontak: ${kontak} | Pakej: ${pakej} | Keperluan: ${soalan}`;

    // Simpan data pendaftaran terus ke Database D1
    try {
      await c.env.DB.prepare("INSERT INTO leads (nama_pelanggan, soalan) VALUES (?,?)").bind(nama, infoLengkap).run();
    } catch(dbErr) {
      console.error('D1 Error:', dbErr);
    }

    return c.html(`
      <!DOCTYPE html>
      <html lang="ms">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-4">
        <div class="max-w-md w-full bg-slate-800 rounded-2xl p-6 text-center border border-slate-700 shadow-2xl">
          <div class="text-green-400 text-5xl mb-4">✅</div>
          <h2 class="text-2xl font-bold mb-2">Pendaftaran Berjaya!</h2>
          <p class="text-slate-300 mb-6">Terima kasih <b>${nama}</b>. Maklumat anda telah disimpan ke sistem AwangBot78. Kami akan menghubungi anda melalui WhatsApp/Telegram secepat mungkin.</p>
          <a href="/" class="inline-block bg-blue-600 px-6 py-2 rounded-lg font-semibold hover:bg-blue-500 transition">Kembali ke Laman Utama</a>
        </div>
      </body>
      </html>
    `);
  } catch(e) {
    return c.text("Ralat semasa pendaftaran: " + e.message, 500);
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
