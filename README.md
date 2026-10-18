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
| `AGENT_WALLET` | var | Dompet terima Agent API. Kosong = guna `SALES_WALLET` |
| `AGENT_STATS_KEY` | var | Kunci untuk `GET /api/agent/stats?key=` |
| `AGENT_PRICES` | var | Override harga (JSON), cth `{"ringkas":0.004}` |
| `SOL_NETWORK` | var | `devnet` untuk ujian; kosong = mainnet |
| `SOL_RPC` | var | RPC tersuai (Helius/QuickNode). Kosong = awam + fallback |

Rahsia (set dengan `wrangler secret put`, **tidak** dalam repo):
`ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN_017`, `WHATSAPP_TOKEN`, `BOT_TOKEN`, `DUITNOW_QR`, `PAYPAL_ME`, `SALES_WALLET`, `BOT_TOKEN_PEKERJA`, `GEMINI_API_KEY`

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

## Agent API — jual servis AI kepada bot/agen lain (x402)

Endpoint berbayar untuk **bot/agen lain** (bukan manusia). Bayaran masuk terus ke dompet Solana
(`SALES_WALLET`), disahkan sendiri on-chain — tiada pihak ketiga, tiada private key di worker,
tiada akaun/API key untuk pelanggan.

| Route | Keterangan |
| --- | --- |
| `GET /api/agent` | Katalog servis + harga (JSON) |
| `GET /.well-known/x402.json` | Manifest penemuan (diindeks x402 Bazaar / Agent Bazaar) |
| `POST /api/agent/<servis>` | Endpoint berbayar: 402 → bayar → hasil |
| `GET /api/agent/status?challenge=` | Semak status bayaran satu cabaran |
| `GET /api/agent/stats?key=` | Hasil/pendapatan (kunci `AGENT_STATS_KEY`) |
| `GET /agent` | Halaman manusia: senarai harga + cara uji |
| `POST /webhook-pekerja` | Webhook **@mypekerja1_bot**: `/servis`, `/beli`, `/semak`, `/hasil` |

Servis: `ringkas`, `terjemah`, `tulis`, `json` (guna rantaian AI sedia ada — Gemini/Workers AI, kos ~0).

**Aliran:**

1. Bot panggil `POST /api/agent/ringkas` tanpa bayaran → **402** + harga (USDC & SOL) + `reference` unik.
2. Bot bayar ke dompet; `reference` dimasukkan sebagai akaun tambahan dalam transaksi.
3. Bot panggil semula dengan `X-Payment-Ref: <reference>` (atau `X-Payment-Tx: <signature>`).
4. Worker sahkan on-chain: `getSignaturesForAddress(reference)` → `getTransaction` → kira **beza baki**
   dompet kita (SOL asli + USDC SPL). Replay ditolak (`tx_sig` UNIQUE). Hasil di-cache (idempotent).

`maxSupportedTransactionVersion: 1` diperlukan (Solana kini ada transaksi versi 1).
USDC = harga tepat; SOL = min 0.00005 SOL (yuran rangkaian).

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

Sumber sebenar katalog **kedai MyKiraShop**. 16 produk asal diselaraskan ke sini
(ditanda `supplier = 'MyKiraShop'`). Penjana SQL dan katalognya tinggal dalam repo
MyKiraShop (`scripts/sync-catalog.mjs` → `scripts/catalog-sync.sql`), diapply dengan:

```bash
npx wrangler d1 execute awangbot78 --remote --file ..\project3\mykirashop\scripts\catalog-sync.sql
```

> **Nota token:** `CLOUDFLARE_API_TOKEN` dalam `~/.hermes/.env` tiada kebenaran D1
> (balas `code: 7403`). Untuk D1, guna token dari `~/kiraenterprisev5.5/.env.d1`.

SQL itu idempotent (`INSERT ... WHERE NOT EXISTS` + `UPDATE ... WHERE nama =`), jadi
produk owner lain tidak tersentuh. Katalog ini **tidak** dipakai dalam prompt AI bot —
`listActiveProducts` hanya di `/api/order` dan `/api/products`.

### Kolum untuk kedai

Kolum asal: `nama`, `harga`, `modal`, `supplier`, `gambar`, `penerangan`, `aktif`.
Kolum tambahan (ditambah automatik oleh `ensureProductsTable`):

| Kolum | Guna |
| --- | --- |
| `slug` | kunci padanan dengan kedai (`/product/<slug>`) |
| `kategori` | `baju` atau `accessory` → hantar ke kedai; kosong = bukan produk kedai |
| `sizes` | senarai saiz dipisah koma, cth `S,M,L,XL` |
| `colors` | senarai warna dipisah koma, cth `Hitam,Navy` |

`GET /api/catalog-shop` memulangkan baris `aktif = 1` + `kategori IN ('baju','accessory')`
**tanpa `modal`** — dipanggil oleh kedai melalui service binding.

### Urus dari Telegram (owner sahaja)

```
SENARAI                          # senarai produk + slug
TAMBAH nama | harga | modal | kategori | saiz | warna | gambar | penerangan
       cth: TAMBAH Hoodie Kira | 149 | 70 | baju | S,M,L,XL | Hitam,Navy
EDIT <id> <medan> <nilai>        # medan: nama, harga, modal, kategori, saiz, warna, gambar, penerangan, slug
       cth: EDIT 21 harga 89   |   EDIT 21 kategori baju   |   EDIT 21 saiz S,M,L,XL
HARGA <id> <harga>               # ringkasan untuk harga
TUTUP <id> / BUKA <id>           # produk keluar/masuk kedai
```

Slug dijana automatik daripada nama (unik). Produk yang `TUTUP` terus hilang dari kedai.

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
