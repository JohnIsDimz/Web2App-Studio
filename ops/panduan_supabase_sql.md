# 🗄️ Panduan Setup Database Supabase (Android-Friendly)

> Setup database Web2App Studio di Supabase.
> Wajib dijalankan **sebelum deploy** (atau sebelum testing).
> Total waktu: **5-10 menit**.
> 📱 **Panduan ini dioptimasi untuk pengguna HP Android** (gak perlu laptop).

---

## 🎯 Recap Kilat (6 Langkah)

1. **Dapatkan file** `00_all_setup.sql` (kirim ke HP, atau buka di GitHub)
2. **Select all** di text viewer / browser
3. **Copy**
4. **Buka** Supabase SQL Editor di Chrome
5. **Paste**
6. **Run** → tunggu 10-30 detik

Detail per langkah ada di bawah. 👇

---

## 📱 Dapatkan File SQL di HP

Pilih 1 dari 2 metode:

### Metode A: Kirim File dari PC/Laptop ke HP (Paling Gampang)

**Cara kirim file:**
- **WhatsApp** → kirim file ke diri sendiri (chat "Saya")
- **Google Drive** → upload dari PC, download di HP
- **Telegram** → kirim ke "Saved Messages"
- **Kabel USB** → copy `api/database/00_all_setup.sql` ke folder Download HP
- **Email** → attach file, kirim ke email Anda sendiri

**Setelah file ada di HP:**

1. Buka aplikasi **Google Files** (atau file manager bawaan HP)
2. Navigate ke folder **Download** (atau sesuai tempat Anda simpan)
3. Tap file **`00_all_setup.sql`**
4. Akan muncul pop-up "Open with" → pilih:
   - ✅ **"Text Viewer"** atau **"HTML Viewer"** (paling aman)
   - ✅ **"Google Drive"** viewer
   - ❌ **JANGAN pilih** Word / WPS Office (bisa format ulang jadi rusak)
5. Di text viewer, **tap & tahan** di area teks → menu muncul → tap **"Select all"**
6. Setelah semua ke-highlight (biru) → tap **"Copy"**

**Visual (kurang lebih):**
```
┌─────────────────────────────────────────┐
│ Downloads                               │
├─────────────────────────────────────────┤
│ 📄 00_all_setup.sql        60 KB    [TAP]│
│ 📄 README.md                           │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│ -- Web2App Studio - COMPLETE...         │
│ -- File ini GABUNGAN dari 5 file SQL..│
│                                         │
│ -- ## FILE 1: 01_schema.sql ##        │
│ CREATE TABLE public.users (            │
│   id UUID PRIMARY KEY ...              │
│   ...                                  │
│                                         │
│       [⋮] Menu  →  [Select all]        │
│                    [Copy]              │
└─────────────────────────────────────────┘
```

---

### Metode B: Buka dari GitHub di Browser HP (Paling Simpel)

**Syarat:** project Anda **sudah di-push ke GitHub** (dari PC/laptop, sekali aja).

1. Di HP, buka **Chrome** (atau browser lain)
2. Ketik URL ini di address bar (ganti `USERNAME` dengan username GitHub Anda):
   ```
   https://raw.githubusercontent.com/USERNAME/web2app-studio/main/api/database/00_all_setup.sql
   ```
3. Browser akan tampilkan file sebagai **plain text** (1887 baris SQL, keliatan semua)
4. **Tap & tahan** di area teks → menu muncul → **"Select all"**
5. Setelah highlight semua → tap **"Copy"**

**Belum push ke GitHub?** Kirim via WhatsApp/Email aja (Metode A).

---

## 🌐 Paste & Run di Supabase

1. **Buka tab baru** di Chrome (atau tetap di tab yang sama)
2. Pergi ke **https://supabase.com/dashboard**
3. Pilih project Anda (mis. `web2app-studio`)
4. Sidebar kiri → tap **"SQL Editor"** (icon database)
5. Tap tombol **"+ New query"** (pojok kanan atas)
6. **Tap & tahan** di area kosong editor → menu muncul → **"Paste"**

   **Visual (kurang lebih):**
   ```
   ┌────────────────────────────────────┐
   │ SQL Editor                  [Run ▶]│
   ├────────────────────────────────────┤
   │                                    │
   │  -- Web2App Studio - COMPLETE...  │  ← Paste di sini
   │  CREATE TABLE public.users (      │
   │  ...                              │
   │                                    │
   │                                    │
   └────────────────────────────────────┘
   ```

7. **Cek dulu sebelum Run** (penting!):
   - Scroll ke atas
   - Baris pertama harusnya `-- ================` (komentar SQL) atau `CREATE TABLE`
   - **JANGAN** `00_all_setup.sql` (kalau iya, Anda salah paste)

8. Tap tombol **"Run"** (pojok kanan bawah, atau di menu ⋮ → "Run")
9. **Tunggu 10-30 detik** — kalau lama, itu normal (banyak SQL yang diproses)
10. Hasil akan muncul di bagian bawah editor:
    - ✅ **"Success. No rows returned"** → BERHASIL!
    - ❌ **Merah** → ada error, lihat Troubleshooting di bawah

---

## ⚠️ Anti-Gagal: Yang BUKAN SQL

**❌ JANGAN paste seperti ini (salah):**
```
00_all_setup.sql    ← nama file, BUKAN SQL
```

**✅ Paste yang benar (isi SQL):**
```sql
-- =============================================
-- Web2App Studio - COMPLETE DATABASE SETUP
-- =============================================
...
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ...
);
```

Kalau error seperti ini:
```
ERROR: 42601: trailing junk after numeric literal at or near "00_all_setup"
```
Artinya Anda paste **nama file**, bukan isinya. Ulangi dari Step 2 (select all + copy di text viewer).

---

## ✅ Verifikasi: Cek Tabel & Function

Setelah "Success" muncul, pastikan semua object terbuat:

### Step V1: Cek Tabel

1. Sidebar kiri Supabase → tap **"Table Editor"** (icon tabel)
2. Harus ada **7 tabel** di schema `public`:
   ```
   ✅ users
   ✅ wallets
   ✅ transactions
   ✅ app_configs
   ✅ build_jobs
   ✅ webhook_audit
   ✅ reconciliation_log
   ```

### Step V2: Cek Function (lebih advanced, opsional)

1. Sidebar → **"Database"** → **"Functions"**
2. Harus ada **7+ function**:
   ```
   ✅ handle_new_user
   ✅ credit_bonus_tokens
   ✅ apply_topup_to_wallet
   ✅ apply_subscription_to_wallet
   ✅ purchase_tokens_with_saldo
   ✅ activate_subscription_with_saldo
   ✅ deduct_token_for_build
   ```

### Step V3: Cek dengan Query SQL

Buka SQL Editor lagi, **+ New query**, paste ini lalu Run:

```sql
-- Cek jumlah tabel (expected: 7)
SELECT COUNT(*) as total_tables
FROM information_schema.tables
WHERE table_schema = 'public';

-- Cek jumlah function (expected: 7+)
SELECT COUNT(*) as total_functions
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_type = 'FUNCTION';

-- List semua trigger
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY trigger_name;
```

Kalau return nilai sesuai → **database siap dipakai**. 🎉

---

## 🆘 Troubleshooting (untuk Android)

### ❌ "trailing junk after numeric literal at or near 00_all_setup"
- **Penyebab:** Anda paste **nama file** (`00_all_setup.sql`), bukan isinya
- **Fix:** Ulangi dari awal, pastikan yang ke-copy adalah **ISI** file (dimulai dengan `--`)

### ❌ "permission denied for table users"
- Anda login sebagai **anon**, harusnya **postgres**
- **Fix:** Logout dari Supabase, login lagi sebagai owner project

### ❌ "relation already exists" (tabel udah ada)
- **Itu normal** kalau Anda run ulang SQL
- **Fix:** Abaikan, lanjut aja. Tabel yang udah ada gak perlu di-create ulang

### ❌ File .sql gak bisa dibuka / "Format not supported"
- File manager HP Anda gak support .sql
- **Fix:** Rename file jadi `.txt` dulu, atau pakai Metode B (GitHub di browser)

### ❌ Chrome ke-close pas paste (kehabisan RAM)
- File 60KB, paste ke editor yang handle 1887 baris = bisa makan memory
- **Fix:**
  - Tutup tab lain dulu
  - Atau pakai browser ringan (Firefox Lite, Bromite)
  - Atau split file jadi 2 bagian (buka `01-03` dulu, lalu `04-05`)

### ❌ "Failed to run sql query" tapi gak jelas errornya
- Mungkin ada karakter tersembunyi (zero-width space, dll)
- **Fix:** Copy ulang dari text viewer, pastikan gak lewat Word/WhatsApp yang bisa add formatting

### ❌ User signup berhasil tapi wallet tidak ke-create
- Trigger `handle_new_user` belum aktif
- **Fix:** Run ulang query ini di SQL Editor:
  ```sql
  -- Cek trigger
  SELECT * FROM information_schema.triggers
  WHERE trigger_name = 'on_auth_user_created';
  -- Kalau kosong, run ulang 00_all_setup.sql
  ```

### ❌ Saldo bisa minus setelah topup
- CHECK constraint belum aktif
- **Fix:** Run ulang `00_all_setup.sql` (aman, idempotent)

---

## 📂 Isi File `00_all_setup.sql`

Gabungan 5 file asli (jalan dalam urutan ini):

| # | File Original | Isi |
|---|---------------|-----|
| 1 | `01_schema.sql` | Tabel `users`, `wallets`, `transactions` + trigger auto-create wallet |
| 2 | `02_builds.sql` | Tabel `app_configs`, `build_jobs` |
| 3 | `03_webhook_audit.sql` | Tabel `webhook_audit`, `reconciliation_log` |
| 4 | `04_atomic_functions.sql` | 7 function atomic (topup, beli token, subscription) |
| 5 | `05_anti_double_credit.sql` | UNIQUE + CHECK + trigger anti-cheat |

**5 file asli tetap ada** kalau Anda mau pisah eksekusi per-file (mis. untuk debug). Tapi `00_all_setup.sql` jauh lebih gampang — 1 paste, jadi semua.

**AMAN dijalanin ulang** (idempotent) — pakai `CREATE OR REPLACE` & `IF NOT EXISTS`.

---

## 🎉 Selesai!

Database Supabase Anda sekarang punya:
- ✅ 7 tabel (users, wallets, transactions, app_configs, build_jobs, webhook_audit, reconciliation_log)
- ✅ 7+ function atomic (CRUD saldo, token, subscription)
- ✅ 4+ trigger (auto-create wallet, anti-balance-jump, anti-double-credit)
- ✅ RLS policies (row-level security)
- ✅ UNIQUE & CHECK constraints (data integrity)

**Lanjut ke deploy backend:** `ops/panduan_vps.md` → Step 3 (Configure & Start)
