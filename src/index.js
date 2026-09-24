import { Hono } from 'hono';

const app = new Hono();

// Helper hantar mesej Telegram
async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// 1. Web App Frontend (Smartphone Friendly Form)
app.get('/', (c) => {
  const html = `
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Borang Pesanan</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 min-h-screen p-4 flex justify-center items-center">
      <div class="bg-white p-6 rounded-2xl shadow-lg w-full max-w-md">
        <h2 class="text-2xl font-bold text-center text-blue-600 mb-4">🛒 Borang Pesanan</h2>
        <form action="/order" method="POST" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">Nama Penuh</label>
            <input type="text" name="nama" required class="w-full mt-1 p-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">No. Telefon / WhatsApp</label>
            <input type="tel" name="phone" required placeholder="01x-xxxxxxx" class="w-full mt-1 p-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">Pilihan Produk / Pakej</label>
            <select name="produk" required class="w-full mt-1 p-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none bg-white">
              <option value="">-- Pilih Produk --</option>
              <option value="Pakej A">Pakej A</option>
              <option value="Pakej B">Pakej B</option>
              <option value="Pakej C">Pakej C</option>
            </select>
          </div>
          <button type="submit" class="w-full bg-blue-600 text-white font-bold p-3 rounded-xl hover:bg-blue-700 transition">Hantar Pesanan</button>
        </form>
      </div>
    </body>
    </html>
  `;
  return c.html(html);
});

// 2. Endpoint Terima Form & Simpan ke D1
app.post('/order', async (c) => {
  const body = await c.req.parseBody();
  
  const nama = String(body['nama'] || '');
  const phone = String(body['phone'] || '');
  const produk = String(body['produk'] || '');
  
  // Jana ID unik dan timestamp
  const orderId = 'ORD-' + Date.now();
  const createdAt = new Date().toISOString();

  // Simpan terus ke D1 mengikut schema sedia ada
  await c.env.DB.prepare(
    `INSERT INTO orders (id, nama, phone, produk, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orderId, nama, phone, produk, 'pending', createdAt).run();

  // Notifikasi Mesej Telegram kepada Admin
  const adminMsg = `🚨 <b>PESANAN BARU #${orderId}</b>\n\n` +
                   `👤 <b>Nama:</b> ${nama}\n` +
                   `📞 <b>Telefon:</b> ${phone}\n` +
                   `📦 <b>Produk:</b> ${produk}\n\n` +
                   `📅 <b>Masa:</b> ${new Date().toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' })}`;

  await sendTelegramMessage(c.env.BOT_TOKEN, c.env.ADMIN_ID, adminMsg);

  return c.html(`
    <div style="text-align: center; padding: 50px; font-family: sans-serif;">
      <h2>✅ Pesanan Berjaya Dihantar!</h2>
      <p>Terima kasih <b>${nama}</b>, kami akan menghubungi anda melalui WhatsApp/Telefon secepat mungkin.</p>
      <a href="/" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#2563eb; color:white; border-radius:10px; text-decoration:none;">Kembali ke Borang</a>
    </div>
  `);
});

// 3. Webhook Telegram Bot
app.post('/webhook', async (c) => {
  const update = await c.req.json();

  if (update.message && update.message.text) {
    const chatId = String(update.message.chat.id);
    const text = update.message.text.trim();

    if (text === '/start') {
      await sendTelegramMessage(
        c.env.BOT_TOKEN,
        chatId,
        `Selamat datang ke Bot Awang! 🤖\n\nGunakan borang web untuk membuat pesanan.`
      );
    } else if (text === '/orders' && chatId === c.env.ADMIN_ID) {
      const { results } = await c.env.DB.prepare(
        `SELECT * FROM orders ORDER BY created_at DESC LIMIT 5`
      ).all();

      if (!results || results.length === 0) {
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, `Tiada pesanan dalam rekod.`);
      } else {
        let msg = `📊 <b>5 PESANAN TERKINI:</b>\n\n`;
        results.forEach((row) => {
          msg += `#${row.id}\n👤 ${row.nama}\n📞 ${row.phone}\n📦 ${row.produk}\nStatus: ${row.status}\n\n`;
        });
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, msg);
      }
    }
  }

  return c.text('OK');
});

export default app;