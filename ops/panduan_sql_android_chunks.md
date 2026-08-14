# 🗄️ Setup Database Supabase — CHUNK MODE (untuk HP Android)

> **Cara paling gampang untuk pengguna Android tanpa akses ke file di PC.**
> Tiap chunk = 1 paste ke Supabase SQL Editor.
> Total: **7 chunk**, jalankan urut.

---

## 📋 Daftar Chunk

| Chunk | File SQL | Isi | Verifikasi |
|-------|----------|-----|------------|
| **1** | `01_schema.sql` (full) | 3 tabel + 1 trigger | 3 tabel baru di Table Editor |
| **2** | `02_builds.sql` (full) | 2 tabel + index | 5 tabel total |
| **3** | `03_webhook_audit.sql` (full) | 2 tabel audit | 7 tabel total |
| **4** | `04_atomic_functions.sql` part A | 3 function | 3 function di Database → Functions |
| **5** | `04_atomic_functions.sql` part B | 3 function sisanya | 6 function total |
| **6** | `04_atomic_functions.sql` part C | 1 function terakhir + GRANT | 7 function total |
| **7** | `05_anti_double_credit.sql` (full) | UNIQUE + CHECK + 2 trigger | trigger baru |

**Total waktu: 10-15 menit** (tiap chunk ~1-2 menit).

---

## 🎯 Recap Kilat

Untuk SETIAP chunk, lakukan hal yang sama:

1. Buka chunk ini di HP (scroll ke bawah sampai ketemu "ISI CHUNK N:")
2. **Tap & tahan** di area SQL → menu muncul → **"Select all"**
3. **Copy** (highlight biru semua)
4. Buka **Supabase SQL Editor** di Chrome (tab baru atau tab yg ada)
5. **+ New query** (tab baru) — atau pakai tab sebelumnya
6. **Tap & tahan** di editor → **Paste**
7. **Cek baris pertama**: harus `-- ================` (komentar SQL)
8. Klik **Run** → tunggu sampai "Success"
9. Lanjut ke chunk berikutnya

---

## ⚠️ Anti-Gagal: Yang BUKAN SQL

**❌ JANGAN paste nama file:**
```
01_schema.sql    ← nama file, BUKAN SQL
```
Error: `ERROR: 42601: trailing junk after numeric literal at or near "01_schema"`

**✅ Paste ISI file (dimulai dengan `--`):**
```sql
-- =============================================
-- Web2App Studio - Database Schema (DDL)
-- Target: Supabase (PostgreSQL 15+)
...
CREATE TABLE public.users (
  id UUID PRIMARY KEY ...
);
```

---

## ✅ CHUNK 1/7: Schema (Tabel User, Wallet, Transaction)

**Paste ini ke Supabase SQL Editor:**

