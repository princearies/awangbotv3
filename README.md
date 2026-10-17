# awangbotv3

Worker Hono yang menyatukan **bot WhatsApp**, **dropship order** dan **halaman bayaran**
untuk MyKira. Live di **https://awangbotv3.mykira.workers.dev**

## Struktur

```
src/
├─ index.js          # semua route (bot WA, dropship, bayaran, chat tabs)
├─ prompts/          # satu fail per persona/bidang (017, dropship, klinik, …)
└─ tabs/             # konfigurasi tab UI
wrangler.toml        # binding D1 (awangbot78), AI, vars
```

## Binding & konfigurasi

| Nama | Jenis | Nota |
| --- | --- | --- |
| `DB` | D1 `awangbot78` | table utama: `leads`, `dropship_orders`, `products`, `chat_memory` |
| `AI` | Workers AI | fallback model bila Claude tiada |
| `ADMIN_ID` | var | Telegram admin |
| `CLAUDE_MODEL` | var | model Claude utama |
| `CF_MODEL_CHAIN` | var | rantaian fallback Workers AI |
| `PHONE_NUMBER_ID_017` | var | Phone Number ID WABA |

Rahsia (set dengan `wrangler secret put`, **tidak** dalam repo):
`ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN_017`, `WHATSAPP_TOKEN`, `BOT_TOKEN`, `DUITNOW_QR`, `PAYPAL_ME`, `SALES_WALLET`

## Route utama

| Route | Keterangan |
| --- | --- |
| `GET/POST /webhook-017` | Webhook WhatsApp 017 (verify token `awang017`) |
| `POST /api/dropship-order` | Terima order dari borang/luar → simpan `dropship_orders` |
| `GET /api/order` | Butiran order awam (tanpa nama/phone/alamat) untuk halaman bayaran |
| `GET /pay` | Halaman bayaran: DuitNow / SOL / USDC / PayPal |
| `GET /track` | Semak status order |
| `GET /api/products` | Katalog awam (tanpa modal/supplier) |
| `POST /api/dropship-chat` | Chat dropship |
| `POST /api/<bidang>-chat` | Chat per bidang: klinik, burger, pbt, bank, property, … |
| `POST /register` | Pendaftaran |

## Table `dropship_orders`

```
id, nama, phone, barang, qty, alamat, status, tracking, created_at
```

Satu baris = satu pesanan. `barang` ialah teks bebas — order dari MyKiraaShop datang
sebagai senarai item digabung, contoh:

```
Classic Tee - Logo MyKiraa (M/Hitam) x2; Snapback Cap - Kiraa (One Size/Navy) x1 | Jumlah RM177.00 (pos percuma)
```

`GET /api/order` cuba padankan `barang` dengan katalog `products` (fungsi `matchProduct`,
fuzzy dua hala) untuk pulangkan medan `harga`.

> **Perhatian:** `matchProduct` memadankan **satu** produk sahaja, dan `harga` dikira
> `harga_produk × qty`. Untuk troli bercampur (lebih daripada satu jenis produk),
> angka itu **tidak** mewakili jumlah sebenar. Jumlah sebenar sentiasa ada dalam `barang`.

## Auto-deploy

Setiap `git push` ke `main` di-deploy automatik dalam **~1 minit** oleh cron di VPS.

| | |
| --- | --- |
| Pencetus | cron setiap minit → `~/bin/awangbotv3-autodeploy.sh` |
| Repo di VPS | `~/awangbotv3-deploy` |
| Kunci | deploy key read-only `vps-autodeploy`, alias SSH `github-awangbotv3` |
| Token | `CLOUDFLARE_API_TOKEN` dari `~/.hermes/.env` (VPS) |
| Log | `~/logs/awangbotv3-autodeploy.log` |

Skrip akan **berhenti** dan log amaran kalau klon deploy ada perubahan yang belum
commit — supaya hotfix manual tak ditimpa tanpa sengaja.

```bash
tail -f ~/logs/awangbotv3-autodeploy.log   # tengok status deploy
```

Deploy manual: `npx wrangler deploy`
