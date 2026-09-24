import { Hono } from 'hono';

const app = new Hono();

async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

app.get('/', (c) => {
  return c.text('AwangBot v3 Active!');
});

app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();

    if (update.message && update.message.text) {
      const chatId = String(update.message.chat.id);
      const text = update.message.text.trim();

      if (text === '/start') {
        const welcomeMsg = '👋 <b>Hai! Saya ialah AI AwangBot.</b>\n\nTanya saya apa-apa soalan pasal Pakej A, B, C atau penghantaran!';
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, welcomeMsg);
        return c.text('OK');
      }

      try {
        // Guna model Llama 3.2 3B Instruct yang disokong sepenuhnya oleh Cloudflare
        const aiResponse = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
          messages: [
            {
              role: 'system',
              content: 'Anda ialah Pembantu AI yang mesra untuk AwangBot. Jawab dalam Bahasa Melayu yang ringkas dan jelas (2-3 ayat).\nMaklumat Perniagaan:\n- Pakej A: RM50\n- Pakej B: RM90\n- Pakej C: RM130\n- Penghantaran: PosLaju / J&T Express (2-3 hari bekerja).'
            },
            { role: 'user', content: text }
          ]
        });

        const replyText = aiResponse.response || 'Maaf, saya kurang pasti. Sila cuba soalan lain.';
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, replyText);

      } catch (aiErr) {
        const errorMsg = '⚠️ <b>Ralat AI:</b> ' + String(aiErr.message || aiErr);
        await sendTelegramMessage(c.env.BOT_TOKEN, chatId, errorMsg);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }

  return c.text('OK');
});

export default app;
