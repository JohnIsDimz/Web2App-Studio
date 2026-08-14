# Web2App Studio

> SaaS platform untuk mengubah website menjadi aplikasi Android (APK) secara otomatis.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-UNLICENSED-red)]()

## ✨ Fitur

- 🎨 **Web-to-APK Converter** — Masukkan URL website, klik build, APK siap didownload
- 💰 **Sistem Saldo** — Top-up saldo via QRIS (Pakasir), lalu beli token atau subscription pakai saldo
- 📦 **3 Produk** — Token satuan (Rp 500/token) + Subscription Basic/Pro/Premium
- 🔨 **Async Build Pipeline** — Bull Queue + Redis worker, tidak blokir API
- 🛡️ **Security** — CAPTCHA alphanumeric server-side, HttpOnly cookie, HSTS, CSP, rate limit
- 🎯 **Neobrutalism UI** — Design yang bold dan tegas

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20 (Express) |
| Database | Supabase (PostgreSQL) + atomic SQL functions |
| Auth | Supabase Auth (JWT) |
| Queue | Bull + Redis |
| Payment | Pakasir (QRIS) — top-up saldo |
| APK Build | Capacitor + Android SDK |
| Frontend | HTML + Vanilla JS + Tailwind CSS |
| Process Manager | PM2 |
| Web Server | Nginx + Let's Encrypt (certbot) |

## 📂 Struktur Proyek

```
web2app-studio/
├── 🌐 HTML (frontend statis, di root)
│   ├── index.html              # Landing page
│   ├── login.html              # Halaman login
│   ├── signup.html             # Halaman signup
│   ├── pricing.html            # Pricing & topup saldo
│   ├── dashboard.html          # Builder dashboard
│   ├── history.html            # Riwayat transaksi
│   └── convert.html            # Beli token pakai saldo
│
├── 📁 assets/                  # Aset frontend
│   ├── css/
│   │   └── neobrutalism.css    # Design system
│   └── js/                     # 11 file (api, auth, captcha, convert,
│                               #   dashboard, deposit, feather, history,
│                               #   icons, pricing, ui)
│
├── 🔧 api/                    # Backend Node.js
│   ├── package.json
│   ├── .env.example
│   ├── database/              # SQL DDL (5 file)
│   │   ├── 01_schema.sql             # users, wallets, transactions
│   │   ├── 02_builds.sql             # app_configs, build_jobs
│   │   ├── 03_webhook_audit.sql      # webhook audit + reconciliation
│   │   ├── 04_atomic_functions.sql   # saldo ↔ token atomic
│   │   └── 05_anti_double_credit.sql # UNIQUE + CHECK + triggers
│   └── src/
│       ├── config/            # supabase, pakasir, queue
│       ├── controllers/       # 6 handler (build, captcha, cron, preview,
│       │                      #   transaction, webhook)
│       ├── middlewares/       # auth, errorHandler
│       ├── routes/            # api.routes.js (15 endpoint)
│       ├── services/          # 3 service (builder, transaction, wallet)
│       ├── validators/        # joi schemas
│       ├── workers/           # build.worker.js (Bull consumer)
│       └── server.js          # Entry point (Helmet + session)
│
├── 🛠️ ops/                    # Production operations
│   ├── nginx/                 # Nginx reverse proxy config
│   ├── pm2/                   # PM2 ecosystem
│   ├── scripts/               # 2 script
│   │   ├── deploy.sh          # Deploy + certbot + PM2 start
│   │   └── 99-verify-all.sh   # Health check
│   ├── install.sh             # ⭐ Master installer (10 step)
│   ├── README.md
│   ├── panduan_vps.md         # ⭐ Panduan deploy (ID)
│   ├── panduan_supabase.md    # Setup Supabase (5 menit)
│   ├── panduan_pakasir_saldo.md  # Alur Pakasir vs saldo
│   └── panduan_upload.md      # Upload project ke VPS
│
├── .gitignore
├── .gitattributes
└── README.md                  # File ini
```

## 🚀 Quick Start (Development)

### Prasyarat
- Node.js 20+
- Redis
- Akun Supabase + Pakasir

### 1. Setup Backend
```bash
cd api
cp .env.example .env
# Edit .env, isi kredensial Supabase + Pakasir + COOKIE_SECRET + CRON_SECRET

npm install

# Jalankan schema SQL di Supabase (SQL Editor, urut):
#   01_schema.sql → 02_builds.sql → 03_webhook_audit.sql
#   → 04_atomic_functions.sql → 05_anti_double_credit.sql
# Detail: ops/panduan_supabase_sql.md

# API server (terminal 1)
npm run dev

# Build worker (terminal 2)
npm run dev:worker
```

### 2. Setup Frontend
```bash
# Edit assets/js/auth.js → sudah terisi (untuk development)
# Untuk produksi, ganti SUPABASE_URL & SUPABASE_ANON_KEY

# Serve dengan static server (dari root project)
npx serve -p 5500

# Buka: http://localhost:5500/index.html
```

## 🌐 Production Deployment

Lihat: **[`ops/panduan_vps.md`](./ops/panduan_vps.md)** untuk panduan lengkap Bahasa Indonesia (Rumahweb + Let's Encrypt, tanpa Cloudflare).

Atau jalankan script otomatis:
```bash
cd ops
sudo bash install.sh       # 10 step: Node, Redis, PM2, JDK, Android SDK, Nginx, certbot
sudo bash scripts/deploy.sh # Setup certbot SSL + PM2 start + Nginx reload
```

## 💰 Pricing Model

| Produk | Harga | Detail |
|--------|-------|--------|
| **Token** | Rp 500 / token | Beli pakai saldo, 1 token = 1 build APK |
| **Basic** | Rp 15.000 / bln | 35 build / bulan (subscription) |
| **Pro** | Rp 30.000 / bln | Unlimited build + GPS + Push Notification |
| **Premium** | Rp 60.000 / bln | Unlimited + custom package name + VIP queue |

**Alur:** Signup dapat 3 token bonus → Top-up saldo via QRIS (Pakasir) → Beli token atau subscription pakai saldo.

## 📜 Lisensi

UNLICENSED — Proprietary software.
