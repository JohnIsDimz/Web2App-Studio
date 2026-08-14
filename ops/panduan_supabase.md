# 🔥 Panduan Setup Supabase — Web2App Studio (SUPER SIMPEL)

> Setup Supabase dalam **5 menit**. Cukup 2 nilai yang perlu diisi.
> (Karena Anda bilang sering pakai Firebase, saya jelaskan dengan comparison)

---

## 🤔 Supabase vs Firebase (Cepat)

| Aspek | Firebase | Supabase |
|-------|----------|----------|
| **Database** | Firestore (NoSQL) | PostgreSQL (SQL) |
| **Auth** | Firebase Auth | Supabase Auth |
| **Real-time** | ✅ | ✅ |
| **SQL** | ❌ | ✅ (native) |
| **Trigger DB** | ❌ | ✅ (auto-create wallet!) |
| **Free tier** | 50k MAU | 50k MAU |
| **Open source** | ❌ | ✅ |
| **Setup time** | ~20 menit | ~5 menit |

**Verdict:** Untuk Web2App Studio, Supabase lebih cocok karena kita butuh **SQL schema + trigger** untuk auto-create wallet. Firebase butuh sync manual.

---

## ⚡ Setup 5 Menit (Step-by-Step)

### Step 1: Buat Akun & Project (1 menit)

1. Buka https://supabase.com/dashboard
2. Login (Google/GitHub/email)
3. **New Project**:
   - Name: `web2app-studio`
   - Database Password: (generate strong, **SIMPAN!**)
   - Region: **Singapore** (terdekat untuk Indonesia)
   - Plan: **Free** ($0/bulan, cukup untuk MVP)
4. Klik **Create new project** → tunggu ~1 menit

### Step 2: Copy 2 Nilai Penting (1 menit)

Setelah project ready:

1. Buka **Settings** (⚙️ icon, sidebar kiri bawah) → **API**
2. Copy 2 nilai ini:
   ```
   Project URL:   https://abcdefghijk.supabase.co    ← COPY
   anon public:   eyJhbGciOiJIUzI1NiIsInR5cCI6...  ← COPY
   ```

**Nilai lain (service_role, JWT secret) TIDAK perlu di-copy ke frontend.** Itu untuk backend saja.

### Step 3: Setup Schema Database (2-5 menit)

1. Sidebar → **SQL Editor** → **+ New query**
2. Copy-paste **SELURUH** isi file `api/database/01_schema.sql`
3. Klik **Run** (atau Ctrl+Enter)
4. Ulangi untuk `api/database/02_builds.sql`

> **Sekarang ada 5 file SQL, bukan 2.** Lihat panduan lengkap step-by-step di
> [`panduan_supabase_sql.md`](./panduan_supabase_sql.md) untuk urutan & troubleshooting.
>
> 💡 **Shortcut:** kalau males copy-paste 5 file, ada **`api/database/00_all_setup.sql`**
> (gabungan semua). Tinggal paste 1 file → Run, jadi.
>
> Urutan eksekusi:
> 1. `01_schema.sql` (tabel users, wallets, transactions + trigger)
> 2. `02_builds.sql` (tabel app_configs, build_jobs)
> 3. `03_webhook_audit.sql` (tabel audit webhook Pakasir)
> 4. `04_atomic_functions.sql` (function atomic saldo/token/subscription)
> 5. `05_anti_double_credit.sql` (UNIQUE + CHECK + trigger anti-cheat)

✅ Sekarang tabel `users`, `wallets`, `transactions`, `app_configs`, `build_jobs` (dan tabel audit) sudah dibuat.

### Step 4: Enable Google Login (Opsional, 2 menit)

Di Supabase Dashboard → **Authentication** → **Providers** → enable **Google** → isi Client ID & Secret dari Google Cloud Console.

**Skip step ini kalau belum mau Google login.**

### Step 5: Paste Config ke Frontend (30 detik)

Edit file `assets/js/auth.js`, **cukup ganti 2 baris**:

```js
const SUPABASE_URL = 'https://abcdefghijk.supabase.co';     // ← GANTI
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6...'; // ← GANTI
```

**Selesai!** Tinggal test signup/login. 🎉

### Step 6 (Opsional): Backend Config

Edit file `api/.env`:

```env
SUPABASE_URL=https://abcdefghijk.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...  # untuk backend saja
SUPABASE_JWT_SECRET=super-secret-key  # dari Settings → API → JWT Secret
```

---

## 📁 Struktur Config (Sekarang Jauh Lebih Simpel)

### Frontend: Cukup 2 Baris!

```js
// assets/js/auth.js (cukup 2 baris ini saja yang perlu diisi!)
const SUPABASE_URL = 'https://YOUR.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```

### Backend: 4 Baris (untuk Production)

```env
# api/.env
SUPABASE_URL=https://YOUR.supabase.co
SUPABASE_ANON_KEY=eyJ...           # sama dgn frontend
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # ⚠️ JANGAN expose ke frontend
SUPABASE_JWT_SECRET=...            # dari Settings → API
```

---

## 🎯 Kenapa Lebih Simpel dari Firebase?

### Firebase (9+ file config):
```
firebase-config.js          # API key
firebase-auth.js            # Auth config
firebase-firestore.js       # Database rules
firestore.rules             # Security rules
firebase.json               # Project config
.firebaserc                 # Project alias
storage.rules               # Storage rules
+ perlu download service account JSON untuk backend
```

### Supabase (1 file config):
```
assets/js/auth.js    # 2 baris!
api/.env             # 4 baris untuk backend
```

**That's it.** No service account JSON, no rules file, no aliases.

---

## 🔍 Auto-Detect Local vs Production

Code sudah pintar auto-detect environment:

```js
const API_BASE_URL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:3000/api'    // Development
    : `${window.location.origin}/api`; // Production
```

- Buka dari `localhost:5500` → API ke `localhost:3000`
- Buka dari `web2appstudio.my.id` → API ke `web2appstudio.my.id/api`

**Gak perlu edit config saat deploy!** 🚀

---

## 🛡️ Auto-Validasi Config

Frontend sekarang punya **error banner** yang muncul kalau config belum diisi:

```js
if (SUPABASE_URL.includes('YOUR_')) {
  showSetupError('⚠️ Supabase config belum diisi! ...');
}
```

Anda akan langsung tahu kalau lupa ganti `YOUR_xxx` dengan nilai asli.

---

## 📋 Checklist Setup

- [ ] Buat project di Supabase
- [ ] Copy Project URL + anon key
- [ ] Run `01_schema.sql` di SQL Editor
- [ ] Run `02_builds.sql` di SQL Editor
- [ ] Edit `assets/js/auth.js` (2 baris)
- [ ] Test signup di browser
- [ ] (Opsional) Enable Google OAuth
- [ ] (Production) Setup domain & deploy

**Total: 5-10 menit** untuk MVP jalan. ⚡

---

## 🆘 Troubleshooting

### ❌ "Invalid API key"
- Pastikan **anon key** di `auth.js` sama persis dengan di dashboard
- Cek tidak ada spasi/newline tertinggal saat copy-paste

### ❌ "Failed to fetch"
- **Local**: Pastikan backend jalan di port 3000 (`npm run dev` di folder `api/`)
- **Production**: Cek CORS di `api/.env` → `APP_FRONTEND_URL` harus sesuai domain frontend

### ❌ "row level security policy violation"
- Trigger `on_auth_user_created` belum jalan
- Re-run `01_schema.sql` di SQL Editor
- Cek di SQL: `SELECT * FROM public.users;` — kalau ada error RLS, trigger belum aktif

### ❌ "Email not confirmed"
- Di Supabase → Authentication → Providers → Email → **Confirm email: OFF** (untuk testing)
- Atau buka email verification link yang dikirim Supabase

### ❌ User signup tapi wallet tidak ke-create
- Cek trigger:
  ```sql
  SELECT * FROM information_schema.triggers 
  WHERE trigger_name = 'on_auth_user_created';
  ```
- Kalau null, re-run `01_schema.sql`

---

## 📊 Perbandingan Effort

| Task | Firebase | Supabase |
|------|---------|----------|
| Setup project | 5 menit | 1 menit |
| Get API key | 3 menit | 30 detik |
| Database schema | 20 menit (Firestore rules) | 1 menit (SQL copy-paste) |
| Auth setup | 10 menit | 0 menit (default sudah jalan) |
| Backend integration | 15 menit (service account JSON) | 2 menit (env var) |
| Trigger auto-create | Manual (Cloud Function) | 0 menit (DB trigger) |
| **Total** | **~55 menit** | **~5 menit** |

---

## 🎉 Selesai!

Sekarang Supabase setup Anda **jauh lebih simpel**:
- ✅ Frontend: **2 baris** yang perlu diisi
- ✅ Backend: **4 baris** env var
- ✅ Auto-detect local vs production
- ✅ Error banner kalau config lupa diisi
- ✅ Semua auth method jalan (email, password, Google)

Kalau Anda sebelumnya pakai Firebase, **migrasi ke Supabase ini worth it** karena:
1. SQL lebih powerful untuk relational data (wallet, transactions, build_jobs)
2. Trigger database = auto-create wallet saat user signup (gak perlu Cloud Function)
3. 1 API untuk semua (RLS aktif, gak perlu sync manual)
4. Open source (gak ada vendor lock-in)

Mau saya bantu setup Supabase sekarang atau lanjut ke fitur lain?
