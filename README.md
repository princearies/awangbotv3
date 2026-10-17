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
id, nama, phone, barang, qty, alamat, status, tracking, harga, created_at
```

Satu baris = satu pesanan. `barang` ialah teks bebas — order dari MyKiraShop datang
sebagai senarai item digabung, contoh:

```
Classic Tee - Logo MyKira (M/Hitam) x2; Snapback Cap - Kira (One Size/Navy) x1 | Jumlah RM177.00 (pos percuma)
```

`GET /api/order` padankan `barang` dengan katalog `products` (fungsi `matchProduct`,
fuzzy dua hala) untuk pulangkan medan `harga` **kalau order itu tiada nilai tersimpan**.

> **Jumlah autoritatif.** `matchProduct` memadankan **satu** produk sahaja dan mengira
> `harga = harga_produk × qty`, jadi ia tidak boleh dipercayai untuk troli MyKiraShop:
> - troli bercampur (lebih daripada satu jenis produk) → angka itu **tidak** mewakili jumlah sebenar;
> - kos pos (RM8 bawah RM150) tidak dikira langsung.
>
> Sebab itu MyKiraShop menghantar jumlah sebenar (`subtotal + pos`) sebagai medan
> `harga` ke `POST /api/dropship-order`. Nilai itu disimpan dalam kolum `harga`
> (`ensureDropshipTables` buat `ALTER TABLE dropship_orders ADD COLUMN harga REAL`,
> berpengawal try/catch supaya tak pecah kalau kolum dah ada), dan `/api/order`
> **utamakan** nilai tersimpan itu (`harga ?? kiraan katalog`).
>
> Order tanpa `harga` (aliran bot WhatsApp / pemanggil lama) kekal `null` dan guna
> kiraan katalog seperti dahulu — tiada perubahan tingkah laku untuk bot.

## Table `products`

16 produk MyKiraShop diselaraskan ke table ini (ditanda `supplier = 'MyKiraShop'`)
supaya owner nampak semuanya di satu tempat. Penjana SQL dan katalognya tinggal dalam
repo MyKiraShop (`scripts/sync-catalog.mjs` → `scripts/catalog-sync.sql`), diapply
dengan:

```bash
npx wrangler d1 execute awangbot78 --remote --file ..\project3\mykiraashop\scripts\catalog-sync.sql
```

SQL itu idempotent (`INSERT ... WHERE NOT EXISTS` + `UPDATE ... WHERE nama =`), jadi
produk owner lain tidak tersentuh. Katalog ini **tidak** dipakai dalam prompt AI bot —
`listActiveProducts` hanya di `/api/order` dan `/api/products`.

## Auto-deploy

Setiap `git push` ke `main` di-deploy automatik dalam **~1 minit** oleh cron di VPS.

| | |
| --- | --- |
| Pencetus | cron setiap minit → `~/bin/awangbotv3-autodeploy.sh` |
| Repo di VPS | `~/awangbotv3-deploy` |
| Kunci | deploy key read-only `vps-autodeploy`, alias SSH `github-awangbotv3` |
| Token | `CLOUDFLARE_API_TOKEN` dari `~/.hermes/.env` (VPS) |
| Log | `~/logs/awangbotv3-autodeploy.log` |

Skrip akan **berhenti** dan log amaran kalau klon deploy ada perubahan pada fail
**sumber** yang belum commit — supaya hotfix manual tak ditimpa tanpa sengaja.
`node_modules/`, `.wrangler/` dan `package-lock.json` dikecualikan daripada semakan itu
kerana `npm install` mengubahnya secara normal (dan `node_modules` memang dijejak dalam
repo ini — kesan sejarah sebelum `.gitignore`).

```bash
tail -f ~/logs/awangbotv3-autodeploy.log   # tengok status deploy
```

Deploy manual: `npx wrangler deploy`
