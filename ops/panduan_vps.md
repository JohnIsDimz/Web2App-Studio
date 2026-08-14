# 🚀 Panduan Deploy VPS — Web2App Studio

> Panduan lengkap untuk deploy ke VPS production dalam **~30-40 menit**.
> Tested di **Ubuntu 22.04 / 24.04 LTS**.
> State: tanpa email (untuk简化), alphanumeric CAPTCHA, 3 produk (topup/token/subscription).

---

## 📋 Prasyarat

| Item | Detail |
|------|--------|
| 🖥️ VPS | Ubuntu 22.04 / 24.04 LTS, **4 GB RAM** (8 GB recommended untuk build APK) |
| 💾 Storage | 50 GB SSD (Android SDK butuh ~10 GB) |
| 🌐 Domain | Beli di **Rumahweb** (langsung pointing A record ke IP VPS, tanpa Cloudflare) |
| 💳 Akun | Supabase, Pakasir (sudah dapat API key) |

**Rekomendasi VPS (region Singapore, dekat Indonesia):**

| Provider | Spec Minimum | Harga/bln |
|----------|--------------|-----------|
| DigitalOcean | 4 GB / 2 vCPU / 80 GB SSD | $24 |
| Vultr | 4 GB / 2 vCPU / 80 GB SSD | $24 |
| Linode | 4 GB / 2 vCPU / 80 GB SSD | $24 |
| Rumahweb VPS | 4 GB / 2 vCPU | ±Rp 200rb |

**Domain:** Beli di [Rumahweb](https://my.rumahweb.com) (atau registrar lain), lalu pointing A record ke IP VPS. SSL diurus otomatis oleh **certbot Let's Encrypt** saat deploy (lihat Step 2).

---

## 📦 Apa yang Diinstall Installer

Installer otomatis menginstall **10 step**:

| # | Step | Paket | Fungsi |
|---|------|-------|--------|
| 1 | System Update | `curl wget git build-essential htop jq net-tools unzip zip logrotate cron` | Utility, debugging, archiver |
| 2 | Firewall | `ufw fail2ban` | Anti-brute-force, port management |
| 3 | Timezone + Limits | `tzdata sysctl` | Asia/Jakarta, 65535 FD, network tuning |
| 4 | User non-root | `adduser sudo` | User `webapp` (bukan root) |
| 5 | Node.js | `nodejs 20.x LTS` | Backend API runtime |
| 6 | Redis | `redis-server 7.x` | Bull Queue + session store |
| 7 | PM2 | `pm2 pm2-logrotate` | Process manager + auto-rotate logs |
| 8 | Java + Android | `openjdk-17 + cmdline-tools` | APK compiler (build-tools 34.0.0) |
| 9 | Nginx | `nginx 1.24 + certbot` | Reverse proxy + SSL termination (Let's Encrypt) |
| 10 | Project dir | `/var/www/web2app-studio` | Project + storage + logs + backups |

**⏱️ Estimasi: 15-20 menit** (mostly download Android SDK ~3 GB)

---

## ⚡ 3-Step Deploy

### Step 1: SSH ke VPS & Install Dependencies

```bash
# 1. SSH ke VPS sebagai root
ssh root@YOUR_VPS_IP

# 2. Upload project ke /var/www/web2app-studio
#    Opsi A: Git clone
cd /var/www
sudo git clone https://github.com/your-username/web2app-studio.git
#    Opsi B: SCP
#    scp -r ./web2app-studio root@YOUR_VPS_IP:/var/www/

# 3. Jalankan installer
cd /var/www/web2app-studio/ops
sudo bash install.sh
```

Installer output (sample):
```
✓ System updated, 1234 packages total
✓ UFW: SSH (22), HTTP (80), HTTPS (443) only
✓ fail2ban: SSH brute-force protection aktif
✓ Timezone: Asia/Jakarta
✓ User 'webapp' dibuat
✓ Node.js v20.x.x | npm 10.x.x
✓ Redis aktif (PONG), maxmemory 256mb
✓ PM2 5.x.x + pm2-logrotate terinstall
✓ OpenJDK 17.x.x
✓ Android SDK di /opt/android-sdk
✓ Build tools 34.0.0 + platforms android-34
✓ Nginx 1.24.x + certbot Let's Encrypt ready
✅ INSTALASI SELESAI!
```

### Step 2: Pointing Domain Rumahweb ke VPS (DNS A Record)

Tidak pakai Cloudflare. Langsung pointing domain Rumahweb ke IP VPS lewat DNS A record. SSL diurus otomatis oleh **certbot Let's Encrypt** di Step 3 (saat `deploy.sh` jalan).

```bash
# 1. Login panel Rumahweb
#    https://my.rumahweb.com → Login
#
# 2. Pilih domain kamu → klik "Manage" atau "Kelola"
#
# 3. Buka menu "DNS Management" / "DNS Zone"
#
# 4. Hapus A record lama untuk @ dan www (kalau ada)
#
# 5. Tambah 2 A record baru:
#
#    ┌──────┬──────┬──────────────┬───────┐
#    │ Type │ Name │ Value/Target │ TTL   │
#    ├──────┼──────┼──────────────┼───────┤
#    │ A    │ @    │ VPS_IP_KAMU  │ 300   │
#    │ A    │ www  │ VPS_IP_KAMU  │ 300   │
#    └──────┴──────┴──────────────┴───────┘
#
#    Ganti VPS_IP_KAMU dengan IP VPS kamu (mis. 188.166.x.x).
#
# 6. Simpan. Tunggu propagasi DNS 5-30 menit.
#
# 7. Verifikasi propagasi dari lokal:
dig web2appstudio.my.id A +short
dig www.web2appstudio.my.id A +short
# Expected: muncul IP VPS kamu
```

**Kenapa gak pakai Cloudflare?**
- Lebih simpel, gak perlu setup nameserver, origin cert, atau Full/Strict mode
- DNS propagation lebih cepat karena langsung ke authoritative NS Rumahweb
- SSL Let's Encrypt gratis via certbot, auto-renew tiap 60 hari
- Kalau nanti butuh DDoS protection / CDN, bisa tambah Cloudflare belakangan (mode DNS-only, tanpa proxy)

**Lanjut ke Step 3 untuk certbot + deploy.**

### Step 3: Configure & Start

```bash
# 1. Copy .env
cd /var/www/web2app-studio/api
sudo cp .env.example .env
sudo chmod 600 .env   # owner read-only
sudo nano .env
```

**Variabel WAJIB diisi** (lihat `.env.example` untuk dokumentasi lengkap):

```bash
# Application
NODE_ENV=production
APP_BASE_URL=https://web2appstudio.my.id
APP_FRONTEND_URL=https://web2appstudio.my.id

# Supabase (https://supabase.com/dashboard → Settings → API)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=...

# Pakasir (https://app.pakasir.com → Project → API Key)
PAKASIR_API_KEY=...
PAKASIR_WEBHOOK_SECRET=...

# Session secret (HARUS random 48+ chars)
# Generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
COOKIE_SECRET=replace-with-random-48-chars-min

# Cron secret (random 32+ chars)
CRON_SECRET=replace-with-random-32-chars-min
```

Lanjutkan:

```bash
# 2. Install Node dependencies
cd /var/www/web2app-studio
sudo -u webapp npm ci --omit=dev

# 3. Setup Nginx site
sudo cp /var/www/web2app-studio/ops/nginx/web2appstudio.my.id.conf \
        /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 4. Start dengan PM2
cd /var/www/web2app-studio
sudo -u webapp pm2 start ops/pm2/ecosystem.config.cjs
sudo -u webapp pm2 save

# 5. Setup cron jobs (PENTING!)
sudo -u webapp crontab -e
# (paste crontab di bawah)
```

**Crontab yang harus di-paste:**

```cron
# Path PM2 + Node
PATH=/usr/bin:/usr/local/bin:/usr/local/sbin

# Setiap 5 menit: expire pending transactions
*/5 * * * * curl -s -X POST -H "x-cron-secret: $(grep ^CRON_SECRET /var/www/web2app-studio/api/.env | cut -d= -f2)" https://web2appstudio.my.id/api/cron/expire-pending-transactions > /dev/null 2>&1

# Setiap 30 menit: reconcile pending payments
*/30 * * * * curl -s -X POST -H "x-cron-secret: $(grep ^CRON_SECRET /var/www/web2app-studio/api/.env | cut -d= -f2)" https://web2appstudio.my.id/api/cron/reconcile-pending-payments > /dev/null 2>&1

# Setiap hari jam 01:00: check expired subscriptions
0 1 * * * curl -s -X POST -H "x-cron-secret: $(grep ^CRON_SECRET /var/www/web2app-studio/api/.env | cut -d= -f2)" https://web2appstudio.my.id/api/cron/check-expired-subscriptions > /dev/null 2>&1

# Setiap hari jam 01:05: reconcile wallets (self-healing)
5 1 * * * curl -s -X POST -H "x-cron-secret: $(grep ^CRON_SECRET /var/www/web2app-studio/api/.env | cut -d= -f2)" https://web2appstudio.my.id/api/cron/reconcile-wallets > /dev/null 2>&1
```

---

## ✅ Verifikasi

```bash
# 1. PM2 processes (harus 2: api + worker)
sudo -u webapp pm2 ls
# Expected: web2app-api & web2app-worker status "online"

# 2. API health
curl https://web2appstudio.my.id/api/health
# Expected: {"success":true,"status":"ok",...}

# 3. Test CAPTCHA
curl -c /tmp/cookies.txt https://web2appstudio.my.id/api/captcha/generate
# Expected: {"success":true,"data":{"code":"A3K7","length":4,...}}

# 4. Cron jobs
sudo -u webapp crontab -l
# Expected: 4 cron jobs terdaftar

# 5. Browser test
# Buka https://web2appstudio.my.id
# Coba signup → CAPTCHA alphanumeric 4 char muncul
# Coba login → CAPTCHA juga muncul
# Coba topup deposit → Pakasir QRIS
```

---

## 🔄 Update Aplikasi (Zero Downtime)

```bash
cd /var/www/web2app-studio

# 1. Pull latest code
sudo -u webapp git pull origin main

# 2. Re-install deps (kalau package.json berubah)
cd /var/www/web2app-studio/api
sudo -u webapp npm ci --omit=dev

# 3. Reload PM2 (zero downtime)
cd /var/www/web2app-studio/ops/pm2
sudo -u webapp pm2 reload ecosystem.config.cjs

# 4. Lihat log
sudo -u webapp pm2 logs --lines 30
```

---

## 📋 Commands Sehari-hari

### PM2 Management
```bash
sudo -u webapp pm2 ls                    # list processes
sudo -u webapp pm2 monit                 # real-time monitor
sudo -u webapp pm2 logs web2app-api      # tail log API
sudo -u webapp pm2 logs web2app-worker   # tail log worker
sudo -u webapp pm2 restart all           # restart semua
sudo -u webapp pm2 reload all            # zero-downtime reload
sudo -u webapp pm2 stop web2app-worker   # stop 1 process
sudo -u webapp pm2 delete all            # hapus semua
sudo -u webapp pm2 save                  # save process list
```

### System Services
```bash
systemctl status nginx
systemctl restart nginx
systemctl status redis-server
systemctl status fail2ban
journalctl -u nginx -f
tail -f /var/log/nginx/web2appstudio.error.log
```

### Resource Monitoring
```bash
htop                                    # CPU/RAM per-process
df -h                                    # disk usage
free -h                                  # memory
redis-cli ping                           # Redis health
redis-cli info memory                    # Redis memory usage
```

### Application Debug
```bash
# Test CAPTCHA generate
curl -c /tmp/cookies.txt https://web2appstudio.my.id/api/captcha/generate

# Test CAPTCHA verify
curl -b /tmp/cookies.txt -X POST \
  -H "Content-Type: application/json" \
  -d '{"code":"A3K7"}' \
  https://web2appstudio.my.id/api/captcha/verify

# Test create transaction (perlu auth)
TOKEN="eyJ..."
curl -X POST https://web2appstudio.my.id/api/transactions/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"topup","amount_idr":5000}'

# Lihat error 4xx/5xx
sudo -u webapp pm2 logs web2app-api | grep -E 'ERROR|status=4|status=5'
```

### Backup
```bash
# Backup .env
sudo cp /var/www/web2app-studio/api/.env /root/.env.backup.$(date +%Y%m%d)

# Backup build outputs
sudo tar czf /root/builds-$(date +%Y%m%d).tar.gz \
  /var/www/web2app-studio/api/storage/builds

# Backup database (Supabase, via dashboard)
# https://supabase.com/dashboard → Project → Database → Backups
```

---

## 🆘 Troubleshooting

### ❌ API tidak respond (502 Bad Gateway)

```bash
# 1. Cek PM2
sudo -u webapp pm2 ls
sudo -u webapp pm2 logs web2app-api --lines 50

# 2. Cek Nginx
systemctl status nginx
tail -f /var/log/nginx/web2appstudio.error.log

# 3. Cek port 3000
ss -tlnp | grep 3000
# Expected: LISTEN di port 3000

# 4. Restart
sudo -u webapp pm2 restart all
systemctl restart nginx
```

### ❌ CAPTCHA gak muncul di browser

```bash
# 1. Cek console browser (F12 → Console)
# Lihat error di Network tab

# 2. Cek session cookie
# Chrome DevTools → Application → Cookies → cek 'wb2.sid'

# 3. Test manual
curl -c /tmp/cookies.txt \
  https://web2appstudio.my.id/api/captcha/generate
# Expected: {"success":true,"data":{"code":"A3K7",...}}

# 4. Cek CORS
# APP_FRONTEND_URL di .env HARUS sama dengan domain asli
```

### ❌ CAPTCHA terus gagal padahal kode benar

```bash
# 1. Cek session di Redis
redis-cli KEYS "*sess:*"
# Harus ada session dengan field captchaCode

# 2. Test full flow
curl -c /tmp/cookies.txt https://web2appstudio.my.id/api/captcha/generate
# Lihat code, misal "A3K7"

curl -b /tmp/cookies.txt -X POST \
  -H "Content-Type: application/json" \
  -d '{"code":"A3K7"}' \
  https://web2appstudio.my.id/api/captcha/verify
# Expected: {"success":true,"data":{"valid":true}}

# 3. Cek COOKIE_SECRET (kalau pernah berubah, session invalid)
grep COOKIE_SECRET /var/www/web2app-studio/api/.env
```

### ❌ Webhook Pakasir tidak masuk

1. Cek URL di dashboard Pakasir: `https://web2appstudio.my.id/api/webhook/pakasir`
2. Cek log: `sudo -u webapp pm2 logs web2app-api | grep webhook`
3. `PAKASIR_WEBHOOK_SECRET` di `.env` HARUS sama dengan dashboard Pakasir
4. Test endpoint reachable:
   ```bash
   curl -X POST https://web2appstudio.my.id/api/webhook/pakasir \
     -H "Content-Type: application/json" \
     -d '{"order_id":"test","status":"completed","amount":50000}'
   # Expected: 401 invalid_signature (artinya endpoint OK, signature salah)
   ```

### ❌ Build stuck di "queued"

```bash
# 1. Cek worker
sudo -u webapp pm2 logs web2app-worker --lines 50
redis-cli ping
redis-cli LLEN bull:build-apk:waiting

# 2. Restart worker
sudo -u webapp pm2 restart web2app-worker

# 3. Cek Java + Android SDK
java -version
echo $ANDROID_SDK_ROOT
ls $ANDROID_SDK_ROOT/platforms/android-34/
```

### ❌ Out of Memory (OOM) saat build APK

Build APK butuh 2-4 GB RAM. Tambah swap:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
# Expected: Swap: 4.0G
```

Atau upgrade VPS ke 8 GB RAM.

### ❌ SSL Certificate Error (Let's Encrypt)

```bash
# 1. Cek cert Let's Encrypt ada
sudo ls -la /etc/letsencrypt/live/web2appstudio.my.id/

# 2. Test SSL chain dari VPS
curl -vI https://web2appstudio.my.id 2>&1 | grep -i "SSL\|cert"

# 3. Cek expiry cert
sudo certbot certificates

# 4. Kalau cert belum ada / gagal generate, run certbot manual:
sudo certbot --nginx -d web2appstudio.my.id -d www.web2appstudio.my.id

# 5. Test auto-renew
sudo certbot renew --dry-run

# 6. Cek log certbot kalau ada error
sudo tail -50 /var/log/letsencrypt/letsencrypt.log
```

**Penyebab umum gagal certbot:**
- DNS A record belum propagasi (tunggu 5-30 menit)
- Port 80 ke-block firewall (certbot butuh HTTP untuk challenge)
- Domain gak resolve ke IP VPS (cek `dig web2appstudio.my.id A +short`)

### ❌ Disk penuh

```bash
df -h
du -sh /var/www/web2app-studio/api/storage/*
du -sh /var/log/*

# Cleanup
sudo journalctl --vacuum-time=7d
sudo -u webapp pm2 flush
sudo find /var/www/web2app-studio/api/storage/builds \
  -type d -mtime +30 -exec rm -rf {} \;
```

### ❌ Supabase Realtime gak konek (history.html)

```bash
# 1. Supabase Dashboard → Database → Replication
#    Enable tables: transactions, wallets, app_configs
# 2. Test dari browser console:
#    const { data } = await supabase.from('transactions').select('*').limit(1);
```

### ❌ "Invalid API key" dari Supabase

```bash
# Cek .env
grep SUPABASE /var/www/web2app-studio/api/.env

# Test direct
curl https://YOUR.supabase.co/rest/v1/users?apikey=YOUR_ANON_KEY
# Expected: 200 OK atau 401 (key valid tapi gak ada akses)

# Restart PM2 kalau .env diubah
sudo -u webapp pm2 restart all
```

---

## 🗂️ File yang Dihasilkan Installer

| Path | Fungsi | Permission |
|------|--------|------------|
| `/var/www/web2app-studio/` | Project directory | `webapp:webapp` |
| `/var/log/pm2/` | PM2 logs (rotated 50M, retain 14) | `webapp:webapp` |
| `/var/backups/web2app-studio/` | Backup storage | `webapp:webapp` |
| `/var/www/web2app-studio/api/storage/builds/` | Output APK | `webapp:webapp` |
| `/opt/android-sdk/` | Android SDK 34 | `755` |
| `/etc/nginx/sites-enabled/web2appstudio.my.id.conf` | Nginx site | `root:root` |
| `/var/www/certbot/` | Let's Encrypt ACME challenge webroot (auto-managed certbot) | `root:root` |
| `/etc/letsencrypt/live/${DOMAIN}/` | SSL Let's Encrypt certificates (auto-managed certbot) | `root:root` |
| `/etc/fail2ban/jail.local` | Anti-brute-force | `root:root` |
| `/etc/ufw/` | Firewall rules | `root:root` |
| `/etc/sysctl.d/99-web2app.conf` | Kernel tuning | `root:root` |

---

## 🔒 Security Checklist

### Server Hardening (otomatis dari installer)
- [x] **Firewall (UFW)** — SSH (22), HTTP (80), HTTPS (443) only
- [x] **fail2ban** — anti SSH brute-force (3 attempt → 24h ban)
- [x] **User non-root** (`webapp`) — Node.js run as webapp, bukan root
- [x] **SSL** — HTTPS via Let's Encrypt (auto-renew certbot)
- [x] **System limits** — 65535 file descriptors per process
- [x] **Sysctl tuning** — TCP buffer, memory, swap

### Application Security (otomatis dari code)
- [x] **HTTPS enforcement** — HTTP auto-redirect ke HTTPS
- [x] **HSTS** — 1 tahun, force HTTPS di browser
- [x] **CSP** — Content Security Policy ketat
- [x] **Cookie HttpOnly + Secure + SameSite** — anti-XSS, anti-CSRF
- [x] **CAPTCHA server-side** — alphanumeric 4 char, anti-bypass
- [x] **Helmet headers** — X-Frame-Options DENY, nosniff, dll
- [x] **Rate limit** — 100 req/15 min per IP
- [x] **HMAC signature** — webhook Pakasir verified
- [x] **SQL injection** — pakai parameterized query (Supabase)
- [x] **XSS** — CSP + HttpOnly cookie + escape HTML di UI

### Rekomendasi Tambahan (Manual, opsional)
- [ ] **Disable root SSH**: `PermitRootLogin no` di `/etc/ssh/sshd_config`
- [ ] **SSH key-only**: `PasswordAuthentication no`
- [ ] **Auto-update OS**: `apt install unattended-upgrades`
- [ ] **Backup `.env`** ke tempat aman (Bitwarden, 1Password)
- [ ] **Uptime monitoring** (Uptime Kuma, free self-hosted)
- [ ] **Error tracking** (Sentry, free tier)

---

## 📊 Arsitektur Production

```
┌──────────────────────────────────────────────────┐
│ User (Indonesia)                                │
│   ↓ HTTPS                                       │
│ Rumahweb DNS (authoritative)                    │
│   • A record @ + www → VPS_IP                   │
└──────────────────────────────────────────────────┘
                  ↓
┌──────────────────────────────────────────────────┐
│ VPS Singapore (Ubuntu 22.04/24.04)              │
│                                                  │
│ Nginx (:80 redirect, :443 SSL Let's Encrypt)   │
│   ├──► /api/*       → Node.js API (:3000)       │
│   │                  ├──► Supabase (PostgreSQL)  │
│   │                  ├──► Redis (Bull Queue)    │
│   │                  └──► Pakasir (payment)      │
│   │                                              │
│   ├──► /downloads/* → Static APK files          │
│   │                                              │
│   └──► /*            → Static frontend (HTML/JS) │
│                       (login, signup, dashboard)│
│                                                  │
│ Build Worker (Node.js + JDK + Android SDK)      │
│   └──► Compile APK in background                 │
└──────────────────────────────────────────────────┘
```

---

## 💰 Estimasi Biaya Bulanan

| Komponen | Biaya |
|----------|-------|
| VPS 4 GB (DigitalOcean SG) | $24 |
| Domain (Rumahweb) | Rp 200rb/thn |
| SSL (Let's Encrypt / certbot) | $0 |
| Supabase (free tier) | $0 |
| Pakasir (0.7% fee per transaksi) | Variable |
| **TOTAL** | **~$24/bln** |

**Untuk ~100 user aktif/bulan**:
- ~500 transaksi × 0.7% = ±Rp 35.000 fee Pakasir
- Total: ±$24 + Rp 35rb = ±Rp 400rb/bln

---

## 🆘 Bantuan Lebih Lanjut

- 💰 [`panduan_pakasir_saldo.md`](./panduan_pakasir_saldo.md) — alur Pakasir vs Saldo (uang Anda AMAN)
- 📤 [`panduan_upload.md`](./panduan_upload.md) — upload project ke VPS (SCP / Rsync / SFTP)
- 🔒 [`ops/install.sh`](./install.sh) — installer script (bisa di-review sebelum dijalankan)

**Verifikasi akhir (kapan saja):**

```bash
# System check
sudo -u webapp pm2 ls
sudo systemctl status nginx redis-server fail2ban
redis-cli ping
df -h
free -h

# Application check
curl https://web2appstudio.my.id/api/health
sudo -u webapp pm2 logs --lines 50 --nostream
sudo -u webapp crontab -l

# SSL check (dari VPS)
openssl s_client -connect web2appstudio.my.id:443 -servername web2appstudio.my.id < /dev/null 2>&1 | grep -E "subject|issuer"
```

---

## 🎉 Selesai!

Sistem Web2App Studio Anda sudah **production-ready**.

**Total waktu deploy: 30-40 menit**
- 15-20 menit: download SDK + install packages
- 5-10 menit: setup domain Rumahweb (DNS A record + propagasi)
- 5-10 menit: certbot Let's Encrypt + configure `.env` + start PM2
- 5 menit: setup cron jobs + verifikasi

Kalau ada error, cek section **Troubleshooting** di atas.
