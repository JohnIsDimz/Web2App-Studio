# Panduan: Alur Pakasir vs Saldo (PENTING!)

## TL;DR

**Pakasir HANYA untuk top up saldo.** Beli token atau subscription itu **potong saldo internal**, gak lewat Pakasir. Uang Anda di Pakasir **AMAN** dan tidak akan hilang/terpotong.

## Visualisasi Alur

```
┌─────────────────────────────────────────────────────────────┐
│                    USER FLOW (AMAN)                          │
└─────────────────────────────────────────────────────────────┘

STEP 1: User Top Up Saldo (Pakai Pakasir)
══════════════════════════════════════════
   User klik "Top Up Rp 50.000" di pricing.html
         ↓
   Server kita panggil Pakasir API:
   POST https://app.pakasir.com/api/transactioncreate/qris
   Body: { project, order_id, amount: 50000 }
         ↓
   Pakasir generate QR code (gambar QR untuk user scan)
         ↓
   QR dikembalikan ke user
         ↓
   User scan QR pakai e-wallet (GoPay/OVO/DANA)
         ↓
   User bayar Rp 50.000 ke PAKASIR
         ↓
   ┌────────────────────────────────────────┐
   │ 💰 UANG FISIK:                          │
   │ - User transfer 50.000 → Akun Pakasir   │
   │   Anda (akumulasi)                      │
   │ - Pakasir simpan di saldo merchant      │
   └────────────────────────────────────────┘
         ↓
   Pakasir kirim webhook ke server kita:
   POST /api/webhook/pakasir
   Body: { order_id, status: "completed", amount: 50000 }
         ↓
   Server kita VALIDASI webhook (HMAC signature)
         ↓
   Server update DATABASE: wallet.balance_idr += 50.000
         ↓
   ✅ SELESAI! User punya saldo 50.000 di dompet


STEP 2: User Beli Token (POTONG SALDO, GAK LEWAT PAKASIR)
════════════════════════════════════════════════════════════
   User klik "Beli 20 Token" di convert.html
         ↓
   Browser hit server kita:
   POST /api/transactions/create
   Body: { type: "token_purchase", amount_idr: 10000 }
         ↓
   Server VALIDASI: saldo user >= 10.000? ✓
         ↓
   Server panggil SQL function atomic:
   SELECT purchase_tokens_with_saldo(user_id, wallet_id, 10000)
         ↓
   SQL function (dalam 1 transaction):
   1. Lock wallet row (FOR UPDATE)
   2. UPDATE wallets SET balance_idr -= 10000
   3. UPDATE wallets SET token_balance += 20
   4. INSERT transactions (type='token_purchase', status='success')
   5. Return balance_before/after, tokens_before/after
         ↓
   ✅ SELESAI! User saldo 40.000, token +20

   ⚠️ TIDAK ADA panggilan ke Pakasir!
   ⚠️ TIDAK ADA transfer uang!
   ⚠️ Hanya update angka di database!


STEP 3: User Subscribe (POTONG SALDO, GAK LEWAT PAKASIR)
════════════════════════════════════════════════════════════
   User klik "Pilih Basic" di pricing.html (subscription tab)
         ↓
   Browser hit server kita:
   POST /api/transactions/create
   Body: { type: "subscription", target_tier: "basic" }
         ↓
   Server VALIDASI: saldo user >= 15.000? ✓
         ↓
   Server panggil SQL function atomic:
   SELECT activate_subscription_with_saldo(...)
         ↓
   SQL function:
   1. Lock wallet row
   2. UPDATE wallets SET balance_idr -= 15.000
   3. UPDATE wallets SET subscription_tier = 'basic'
   4. UPDATE wallets SET subscription_expires_at = now() + 30 days
   5. INSERT transactions (type='subscription', status='success')
         ↓
   ✅ SELESAI! User saldo 25.000, tier=basic 30 hari

   ⚠️ TIDAK ADA panggilan ke Pakasir!
   ⚠️ TIDAK ADA transfer uang!


STEP 4: User Build APK (POTONG TOKEN / PAKAI QUOTA)
══════════════════════════════════════════════════
   User submit form build APK di dashboard.html
         ↓
   Server hit /api/build
         ↓
   - Kalau tier='none' (free trial) → potong 1 token
     SQL: SELECT deduct_token_for_build(user_id, 1)
   - Kalau tier='basic' (langganan) → increment quota
   - Kalau tier='pro'/'premium' → unlimited (gak potong apa-apa)
         ↓
   ✅ Build APK selesai, APK didownload user

   ⚠️ TIDAK ADA panggilan ke Pakasir!


RINGKASAN API CALL KE PAKASIR
════════════════════════════
Hanya di 1 tempat: saat user top up saldo.

Semua endpoint lain (token purchase, subscription, build)
TIDAK PERNAH panggil Pakasir. Cuma update database internal.
```

## Visualisasi Uang vs Saldo Database

```
┌─────────────────────────────────────────────────────────────┐
│ 💰 UANG FISIK (di akun Pakasir Anda)                        │
│    = Total semua pembayaran user yang sudah berhasil       │
│    Bisa di-withdraw manual via dashboard.pakasir.com       │
│    TIDAK BISA diambil/dipindah oleh sistem kita             │
│    TIDAK terpotong otomatis                                 │
└─────────────────────────────────────────────────────────────┘
                              ↕ (1 arah: cuma bertambah)
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 📊 SALDO DATABASE (angka di Supabase)                       │
│    = Total saldo semua user (balance_idr)                  │
│    + Total saldo belum di-spend (tersimpan di wallet user) │
│    = angka virtual yang merepresentasikan uang di Pakasir  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 💳 TIAP USER punya "saldo" sendiri (di wallet table)        │
│    User A: Rp 50.000 (sisa deposit)                         │
│    User B: Rp 15.000 (siap buat subscription)               │
│    User C: Rp 0 (pernah top up tapi udah dipake)            │
└─────────────────────────────────────────────────────────────┘
```

## Yang HARUS Anda Cek di Dashboard Pakasir

1. **Balance**: Total uang yang sudah diterima dari user
2. **Transactions**: Riwayat pembayaran masuk (per order_id)
3. **Withdrawal**: Tarik dana ke rekening bank Anda (MANUAL, bukan otomatis)

Sistem kita TIDAK pernah withdraw otomatis. Anda yang kontrol penuh.

## Pertanyaan Umum

### Q: Kalau user top up 50K, terus langsung beli token 10K, uangnya gimana?

A: Flow:
- Step 1: User top up 50K → Pakasir terima 50K, saldo database +50K
- Step 2: User beli token 10K → saldo database -10K (gak lewat Pakasir)
- Hasil: User saldo = 40K, token = 20

Uang di Pakasir Anda: **tetap 50K** (gak berkurang).
Saldo database user: 40K (sesuai dengan uang yang "tersisa" bisa dibelanjakan).

### Q: Apakah uang saya aman dari double-debit?

A: Ya. Lihat file `api/database/05_anti_double_credit.sql`:
- UNIQUE constraint di `reference_id` → Pakasir gak bisa duplicate-charge
- SQL function atomic pakai row lock + advisory lock
- Audit trail ke `webhook_audit` table
- Reconciliation cron (setiap 30 menit) cek inconsistency

### Q: Gimana cara withdraw uang dari Pakasir ke rekening saya?

A: Manual via dashboard `app.pakasir.com`:
1. Login ke dashboard Pakasir
2. Menu "Withdrawal" atau "Penarikan"
3. Masukkan nominal + rekening bank
4. Submit (Pakasir proses 1-3 hari kerja)

Sistem kita TIDAK ikut campur. Anda yang lakukan sendiri.

### Q: Kalau sistem kita error, uang user hilang?

A: TIDAK. Saldo user disimpan di 2 tempat:
1. Database kita (Supabase PostgreSQL)
2. Backup otomatis Supabase setiap hari

Kalau VPS kita down, user bisa tetap top up (karena webhook Pakasir akan di-retry).
Kalau database corrupt, restore dari backup Supabase.

Plus ada **cron reconciliation** yang deteksi kalau ada tx success tapi saldo gak masuk → manual recovery.

## Yang WAJIB Dilakukan Sebelum Production

1. **Set PAKASIR_WEBHOOK_SECRET** di `.env` (WAJIB, jangan kosong)
2. **Set ALLOW_INSECURE_WEBHOOK=false** (production)
3. **Test dengan nominal kecil** (Rp 500) dulu sebelum live
4. **Monitor dashboard Pakasir** setiap hari, cross-check dengan transactions table
5. **Setup backup Supabase** otomatis (Supabase Pro)
6. **Withdraw rutin** ke rekening bank (jangan numpuk di Pakasir)
