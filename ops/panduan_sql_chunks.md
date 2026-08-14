# 🗄️ Setup Database Supabase — 7 Chunk (Paling Ringan untuk HP)

> **Cara paling gampang untuk HP Android.** Tiap chunk kecil (~150-440 baris), gak nge-lag.
> Total: **7 chunk**, jalankan urut. Tiap chunk = 1 paste ke Supabase.
> Total waktu: **10-15 menit**.

---

## 📋 Daftar Chunk

| # | File Chunk | Isi | Verifikasi Setelah Run |
|---|------------|-----|------------------------|
| **1** | `chunks/chunk_1_schema.sql` | 3 tabel (users, wallets, transactions) + 1 trigger | 3 tabel baru di Table Editor |
| **2** | `chunks/chunk_2_builds.sql` | 2 tabel (app_configs, build_jobs) | 5 tabel total |
| **3** | `chunks/chunk_3_audit.sql` | 2 tabel (webhook_audit, reconciliation_log) | 7 tabel total |
| **4** | `chunks/chunk_4_functions_a.sql` | 2 function (convert_saldo_to_tokens, credit_bonus_tokens) | 2 function baru |
| **5** | `chunks/chunk_5_functions_b.sql` | 3 function (apply_topup, deduct_token, purchase_tokens) | 5 function total |
| **6** | `chunks/chunk_6_functions_c.sql` | 3 function (activate_subscription, apply_topup v2, handle_new_user) | 7 function total |
| **7** | `chunks/chunk_7_anti_double_credit.sql` | UNIQUE + CHECK + 2 trigger anti-cheat | 4+ trigger |

---

## 🔁 Alur Per Chunk (SAMA untuk Tiap Chunk)

Untuk SETIAP chunk di atas, lakukan hal yang sama:

### Step A: Buka File Chunk di HP

**Pilih 1 metode:**

#### Metode 1: Kirim File dari PC/Laptop (Paling Gampang)
1. Kirim file `chunk_X_xxx.sql` via **WhatsApp** (chat sendiri) / **Google Drive** / **kabel USB**
2. Di HP, buka pakai **Google Files** (atau file manager)
3. Tap file `.sql` → pilih **"Text Viewer"** (JANGAN pilih Word/WPS)

#### Metode 2: Buka dari GitHub di Browser
URL pattern: `https://raw.githubusercontent.com/USERNAME/web2app-studio/main/api/database/chunks/chunk_1_schema.sql`

(Ganti `USERNAME` dengan username GitHub Anda. Hanya jalan kalau project udah di-push.)

### Step B: Copy Isi File

1. Di text viewer / browser, **tap & tahan** di area teks
2. Menu muncul → tap **"Select all"** (semua text ke-highlight biru)
3. Tap **"Copy"**

### Step C: Paste & Run di Supabase

1. Buka **Chrome** di HP → **https://supabase.com/dashboard**
2. Pilih project → sidebar **SQL Editor**
3. **+ New query** (tab baru) — atau pakai tab yg udah ada
4. **Tap & tahan** di area kosong editor → **"Paste"**
5. **Cek baris pertama**: harus `-- ================` (komentar SQL), BUKAN `chunk_1_schema.sql`
6. Tap tombol **"Run"** (pojok kanan bawah, atau menu ⋮ → Run)
7. **Tunggu 5-30 detik** sampai "Success" muncul

### Step D: Verifikasi

Lanjut ke tabel/chunk berikutnya setelah dapat "Success. No rows returned".

---

## ⚠️ Anti-Gagal

**❌ JANGAN paste nama file:**
```
chunk_1_schema.sql    ← nama file, BUKAN SQL
```
Error: `trailing junk after numeric literal at or near "chunk_1"`

**✅ Paste ISI file (dimulai `--`):**
```sql
-- =============================================
-- CHUNK 1/7: 01_schema.sql (tabel users, wallets, transactions)
-- Jalankan di Supabase SQL Editor
-- =============================================
...
CREATE TABLE public.users (
  id UUID PRIMARY KEY ...
);
```

---

## ✅ Verifikasi Akhir (Setelah Semua 7 Chunk Sukses)

### Cek Tabel (Total 7)
- Sidebar Supabase → **Table Editor** → harusnya ada 7 tabel:
  - `users`, `wallets`, `transactions`, `app_configs`, `build_jobs`, `webhook_audit`, `reconciliation_log`

### Cek Function (Total 7+)
- Sidebar → **Database** → **Functions** → harusnya ada 7 function:
  - `handle_new_user`, `credit_bonus_tokens`, `apply_topup_to_wallet`, `apply_subscription_to_wallet`, `purchase_tokens_with_saldo`, `activate_subscription_with_saldo`, `deduct_token_for_build`

### Cek dengan Query (Opsional)

Buka **+ New query** di SQL Editor, paste ini, Run:

```sql
SELECT COUNT(*) as total_tables
FROM information_schema.tables
WHERE table_schema = 'public';
-- Expected: 7
```

---

## 🆘 Troubleshooting

### ❌ "trailing junk after numeric literal at or near chunk_X"
Anda paste **nama file**, bukan isinya. Ulangi dari Step B (pilih "Select all" di text viewer).

### ❌ "relation already exists" di chunk 2/3/4/5/6/7
Anda udah pernah jalanin chunk sebelumnya. **Aman, skip aja** atau klik Run ulang.

### ❌ "function already exists" di chunk 4/5/6
Sama, aman. CREATE OR REPLACE akan replace function lama.

### ❌ "syntax error at or near END"
Chunk ke-potong di tengah function. Solusi: copy ulang chunk tersebut, pastikan semua baris ke-copy (scroll ke bawah dulu sebelum "Select all").

### ❌ Chrome nge-lag / force close pas paste
- Tutup tab lain dulu
- Pakai browser ringan (Firefox Lite, Bromite)
- Atau split chunk manual (buka text viewer, copy setengah, paste ke chunk 1; copy setengah lagi, paste chunk 2)

### ❌ Lupa chunk mana yang udah dijalanin
- Coba jalanin ulang chunk yang dicurigai. Aman, idempotent.

---

## 📂 File Chunk

Semua chunk ada di folder: `api/database/chunks/`

| File | Baris | Ukuran |
|------|-------|--------|
| `chunk_1_schema.sql` | 270 | 10 KB |
| `chunk_2_builds.sql` | 139 | 6 KB |
| `chunk_3_audit.sql` | 152 | 5 KB |
| `chunk_4_functions_a.sql` | 277 | 10 KB |
| `chunk_5_functions_b.sql` | 296 | 9 KB |
| `chunk_6_functions_c.sql` | 296 | 9 KB |
| `chunk_7_anti_double_credit.sql` | 438 | 14 KB |
| **Total** | **1868** | **63 KB** |

**Max per chunk: 438 baris** (chunk 7) — masih aman untuk HP Android modern.
