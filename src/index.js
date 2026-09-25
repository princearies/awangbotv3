import { Hono } from 'hono';
const app = new Hono();

async function sendTelegramMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

const SYSTEM_PROMPT = `Anda ialah Pembantu AI untuk AwangBot78 — perniagaan yang MEMBINA BOT AI KUSTOM untuk pelbagai jenis pelanggan.

Contoh jenis bot yang kami dah pernah bina (bukan senarai tetap, semuanya boleh disesuaikan):
- CikguBot — untuk tutor/pusat tuisyen
- InfluencerBot — untuk content creator/influencer
- EnterpriseBot — untuk syarikat/perniagaan

Setiap bot dibina IKUT KEPERLUAN pelanggan sendiri (fungsi, bahasa, gaya jawapan semua boleh custom).

Pakej harga (ikut tahap kerumitan, BUKAN jenis bot tertentu):
- Pakej A: RM50 — bot asas, 1 fungsi utama
- Pakej B: RM90 — bot standard, 2-3 fungsi custom
- Pakej C: RM130 — bot lengkap, custom penuh + sokongan lanjutan

Arahan jawapan:
- Jawab ringkas dalam Bahasa Melayu (2-3 ayat).
- Jangan anggap pelanggan nak bot jenis tertentu — TANYA apa fungsi/jenis bot yang mereka nak, supaya admin boleh bagi quote yang tepat.
- Jangan sebut pasal penghantaran fizikal/PosLaju — produk kami ialah BOT, bukan barangan.`;

app.get('/', (c) => c.text('AwangBot v4 Dual Active! Telegram+WhatsApp'));

// --- 1. TELEGRAM WEBHOOK ---
app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();
    if (update.message?.text) {
      const chatId = String(update.message.chat.id);
      const text = update.message.text.trim();

      // Semakan hanya jika pengguna taip /start
      if (text === '/start') {
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '👋 <b>Hai! Saya AwangBot78.</b>\nKami bina bot AI custom (cth: untuk cikgu, influencer, syarikat). Cakap apa jenis bot yang anda nak, saya bantu terangkan pakej yang sesuai!');
        return c.text('OK');
      }

      // Pemprosesan soalan biasa guna AI
      try {
        const ai = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }]
        });
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, ai.response || 'Maaf, saya kurang pasti. Sila cuba soalan lain.');
      } catch (aiErr) {
        console.error('AI Error:', aiErr);
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, '⚠️ Maaf, sistem AI mengalami gangguan seketika. Sila cuba lagi.');
      }

      // Simpan lead
      try { await c.env.DB.prepare("INSERT INTO leads (nama_pelanggan, soalan) VALUES (?,?)").bind(chatId, text).run() } catch(e){}
    }
  } catch (e) { console.error(e) }
  return c.text('OK');
});

// --- 2. WHATSAPP WEBHOOK ---
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
